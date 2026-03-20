#!/usr/bin/env node
/**
 * ProRes fetch strategy simulation.
 *
 * Tests different network fetch strategies against a real HTTP server
 * to find the optimal approach for ProRes playback.
 *
 * Usage:
 *   node wasm/sim-prores-fetch.mjs --url http://host/file.mov
 *   node wasm/sim-prores-fetch.mjs --url http://host/file.mov --start 100 --count 200
 */

// --- MOV parsing (reused from bench-prores.mjs) ---

function parseMoovBoxes(buf, start, end) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let codecTag = "";
  let width = 0, height = 0;
  let sampleSizes = [];
  let chunkOffsets = [];
  let stscEntries = []; // { firstChunk, samplesPerChunk }
  let isVideoTrack = false;
  const proresTags = ["apch", "apcn", "apcs", "apco", "ap4h", "ap4x"];

  function walk(s, e) {
    let p = s;
    while (p + 8 <= e) {
      let sz = view.getUint32(p);
      const tp = String.fromCharCode(buf[p + 4], buf[p + 5], buf[p + 6], buf[p + 7]);
      if (sz < 8) break;
      if (sz === 1 && p + 16 <= e) {
        sz = view.getUint32(p + 8) * 0x100000000 + view.getUint32(p + 12);
      }
      const nextP = p + sz;

      if (tp === "trak") isVideoTrack = false;
      if (["moov", "trak", "mdia", "minf", "stbl", "dinf"].includes(tp)) {
        walk(p + 8, Math.min(nextP, e));
      }
      if (tp === "stsd" && p + 8 + 4 + 4 + 8 <= e) {
        const es = p + 8 + 4 + 4;
        const tag = String.fromCharCode(buf[es + 4], buf[es + 5], buf[es + 6], buf[es + 7]);
        if (proresTags.includes(tag)) {
          isVideoTrack = true;
          codecTag = tag;
          width = view.getUint16(es + 32);
          height = view.getUint16(es + 34);
        }
      }
      if (tp === "stsz" && isVideoTrack) {
        const fb = p + 8;
        const sampleSize = view.getUint32(fb + 4);
        const count = view.getUint32(fb + 8);
        sampleSizes = [];
        for (let j = 0; j < count; j++) {
          sampleSizes.push(sampleSize === 0 ? view.getUint32(fb + 12 + j * 4) : sampleSize);
        }
      }
      if (tp === "stsc" && isVideoTrack) {
        const fb = p + 8;
        const count = view.getUint32(fb + 4);
        stscEntries = [];
        for (let j = 0; j < count; j++) {
          stscEntries.push({
            firstChunk: view.getUint32(fb + 8 + j * 12),      // 1-based
            samplesPerChunk: view.getUint32(fb + 8 + j * 12 + 4),
          });
        }
      }
      if (tp === "stco" && isVideoTrack) {
        const fb = p + 8;
        const count = view.getUint32(fb + 4);
        chunkOffsets = [];
        for (let j = 0; j < count; j++) {
          chunkOffsets.push(view.getUint32(fb + 8 + j * 4));
        }
      }
      if (tp === "co64" && isVideoTrack) {
        const fb = p + 8;
        const count = view.getUint32(fb + 4);
        chunkOffsets = [];
        for (let j = 0; j < count; j++) {
          chunkOffsets.push(
            view.getUint32(fb + 8 + j * 8) * 0x100000000 +
            view.getUint32(fb + 8 + j * 8 + 4),
          );
        }
      }
      p = nextP;
    }
  }

  walk(start, end);
  return { codecTag, width, height, sampleSizes, chunkOffsets, stscEntries };
}

/** Build per-sample {offset, size} table using stsc + stco/co64 + stsz. */
function buildSampleTable(sampleSizes, chunkOffsets, stscEntries) {
  const samples = [];
  let sampleIdx = 0;
  const numChunks = chunkOffsets.length;

  for (let chunkIdx = 0; chunkIdx < numChunks; chunkIdx++) {
    // Determine samples-per-chunk for this chunk (stsc entries use 1-based chunk numbers)
    const chunkNum = chunkIdx + 1;
    let spc = 1;
    for (let e = stscEntries.length - 1; e >= 0; e--) {
      if (chunkNum >= stscEntries[e].firstChunk) {
        spc = stscEntries[e].samplesPerChunk;
        break;
      }
    }

    let offset = chunkOffsets[chunkIdx];
    for (let s = 0; s < spc && sampleIdx < sampleSizes.length; s++) {
      const size = sampleSizes[sampleIdx];
      samples.push({ offset, size });
      offset += size;
      sampleIdx++;
    }
  }

  return samples;
}

// --- Argument parsing ---

const args = process.argv.slice(2);
let movUrl = null;
let startFrame = 100;
let frameCount = 100;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--url") movUrl = args[++i];
  else if (arg === "--start") startFrame = parseInt(args[++i]);
  else if (arg === "--count") frameCount = parseInt(args[++i]);
  else if (arg === "--help" || arg === "-h") {
    console.log("Usage: node sim-prores-fetch.mjs --url URL [--start N] [--count N]");
    process.exit(0);
  }
}

if (!movUrl) {
  console.error("Error: --url is required");
  process.exit(1);
}

// --- Helpers ---

function percentile(sorted, p) {
  const idx = Math.min(Math.ceil(sorted.length * p) - 1, sorted.length - 1);
  return sorted[Math.max(0, idx)];
}

function formatBytes(bytes) {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + " GB";
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + " MB";
  return (bytes / 1024).toFixed(1) + " KB";
}

function formatRate(bytesPerSec) {
  const mbps = (bytesPerSec * 8) / 1_000_000;
  return mbps.toFixed(1) + " Mbps";
}

/** Fetch a Range and return { data, ttfb, elapsed, bytes }. */
async function timedFetch(url, rangeStart, rangeEnd, signal) {
  const t0 = performance.now();
  const resp = await fetch(url, {
    headers: { Range: `bytes=${rangeStart}-${rangeEnd}` },
    signal,
  });
  const ttfb = performance.now() - t0;

  if (!resp.ok && resp.status !== 206) {
    throw new Error(`HTTP ${resp.status}`);
  }

  const data = new Uint8Array(await resp.arrayBuffer());
  const elapsed = performance.now() - t0;
  return { data, ttfb, elapsed, bytes: data.byteLength };
}

// --- Main ---

async function main() {
  console.log("\n=== ProRes Fetch Strategy Simulation ===\n");

  // 1. Fetch moov
  console.log("Scanning top-level boxes...");
  const head = await fetch(movUrl, { method: "HEAD" });
  if (!head.ok) throw new Error(`HEAD failed: ${head.status}`);
  const fileSize = parseInt(head.headers.get("content-length"));
  console.log(`File size: ${formatBytes(fileSize)}`);

  let pos = 0;
  let moovOffset = -1, moovSize = -1;
  while (pos < fileSize) {
    const resp = await fetch(movUrl, {
      headers: { Range: `bytes=${pos}-${pos + 15}` },
    });
    const hdr = new Uint8Array(await resp.arrayBuffer());
    const hv = new DataView(hdr.buffer);
    let boxSize = hv.getUint32(0);
    const boxType = String.fromCharCode(...hdr.slice(4, 8));
    if (boxSize === 1 && hdr.length >= 16) {
      boxSize = hv.getUint32(8) * 0x100000000 + hv.getUint32(12);
    }
    if (boxSize < 8) throw new Error(`Invalid box at ${pos}`);
    if (boxType === "moov") { moovOffset = pos; moovSize = boxSize; break; }
    pos += boxSize;
  }
  if (moovOffset < 0) throw new Error("moov atom not found");

  console.log(`Fetching moov (${formatBytes(moovSize)})...`);
  const moovResp = await fetch(movUrl, {
    headers: { Range: `bytes=${moovOffset}-${moovOffset + moovSize - 1}` },
  });
  const moovBuf = new Uint8Array(await moovResp.arrayBuffer());
  const { codecTag, width, height, sampleSizes, chunkOffsets, stscEntries } =
    parseMoovBoxes(moovBuf, 8, moovSize);

  console.log(`Codec: ${codecTag}  ${width}x${height}  ${sampleSizes.length} frames`);
  console.log(`Chunks: ${chunkOffsets.length}  stsc entries: ${stscEntries.length}`);

  // Build sample table from stsc + stco/co64 + stsz
  const samples = buildSampleTable(sampleSizes, chunkOffsets, stscEntries);

  // --- 1a. Frame size distribution ---
  console.log("\n--- Frame Size Distribution ---");
  const sorted = [...sampleSizes].sort((a, b) => a - b);
  const totalBytes = sampleSizes.reduce((a, b) => a + b, 0);
  const avg = totalBytes / sampleSizes.length;
  console.log(`  min    = ${formatBytes(sorted[0])}`);
  console.log(`  median = ${formatBytes(percentile(sorted, 0.5))}`);
  console.log(`  avg    = ${formatBytes(avg)}`);
  console.log(`  p95    = ${formatBytes(percentile(sorted, 0.95))}`);
  console.log(`  max    = ${formatBytes(sorted[sorted.length - 1])}`);
  const fps = 25;
  const contentBitrate = avg * fps * 8;
  console.log(`  content bitrate @${fps}fps = ${formatRate(avg * fps)}`);

  // Validate frame range
  const endFrame = Math.min(startFrame + frameCount, samples.length);
  const actualCount = endFrame - startFrame;
  if (actualCount <= 0) {
    console.error(`No frames in range [${startFrame}, ${endFrame})`);
    process.exit(1);
  }
  console.log(`\nTest range: frames ${startFrame}..${endFrame - 1} (${actualCount} frames)`);

  const testSamples = samples.slice(startFrame, endFrame);
  const testTotalBytes = testSamples.reduce((a, s) => a + s.size, 0);
  console.log(`Test data: ${formatBytes(testTotalBytes)}`);

  // --- 1b. Baseline network characteristics ---
  console.log("\n--- Baseline Network ---");

  // Single 1 MB request
  {
    const mid = samples[Math.floor(samples.length / 2)];
    const rangeEnd = Math.min(mid.offset + 1_000_000 - 1, fileSize - 1);
    const r = await timedFetch(movUrl, mid.offset, rangeEnd);
    console.log(`  1 MB request:  TTFB=${r.ttfb.toFixed(0)}ms  total=${r.elapsed.toFixed(0)}ms  throughput=${formatRate(r.bytes / (r.elapsed / 1000))}`);
  }

  // Single 10 MB request
  {
    const mid = samples[Math.floor(samples.length / 2)];
    const rangeEnd = Math.min(mid.offset + 10_000_000 - 1, fileSize - 1);
    const r = await timedFetch(movUrl, mid.offset, rangeEnd);
    console.log(`  10 MB request: TTFB=${r.ttfb.toFixed(0)}ms  total=${r.elapsed.toFixed(0)}ms  throughput=${formatRate(r.bytes / (r.elapsed / 1000))}`);
  }

  // --- 1c. Fetch strategies ---
  console.log("\n--- Fetch Strategies ---");
  console.log(`(each fetches ${actualCount} frames = ${formatBytes(testTotalBytes)})\n`);

  const results = [];

  // Helper: build contiguous Range for a slice of samples
  function rangeForSlice(slice) {
    const first = slice[0];
    const last = slice[slice.length - 1];
    return { start: first.offset, end: last.offset + last.size - 1 };
  }

  // Strategy A: Single stream — 1 big Range request
  {
    const label = "A: 1-conn, 1 big request";
    const range = rangeForSlice(testSamples);
    const t0 = performance.now();
    const r = await timedFetch(movUrl, range.start, range.end);
    const wall = performance.now() - t0;
    results.push({ label, wall, ttff: r.ttfb, bytes: r.bytes, requests: 1 });
  }

  // Strategy B: 1 connection, 10 serial small requests
  {
    const label = "B: 1-conn, 10 serial batches";
    const batchSize = Math.ceil(actualCount / 10);
    const t0 = performance.now();
    let firstTtfb = 0;
    let totalBytesB = 0;
    for (let b = 0; b < 10; b++) {
      const bStart = b * batchSize;
      const bEnd = Math.min(bStart + batchSize, actualCount);
      if (bStart >= actualCount) break;
      const slice = testSamples.slice(bStart, bEnd);
      const range = rangeForSlice(slice);
      const r = await timedFetch(movUrl, range.start, range.end);
      totalBytesB += r.bytes;
      if (b === 0) firstTtfb = r.ttfb;
    }
    const wall = performance.now() - t0;
    results.push({ label, wall, ttff: firstTtfb, bytes: totalBytesB, requests: 10 });
  }

  // Strategy C: 2 concurrent connections
  {
    const label = "C: 2-conn parallel";
    const half = Math.ceil(actualCount / 2);
    const t0 = performance.now();
    const promises = [];
    for (let c = 0; c < 2; c++) {
      const bStart = c * half;
      const bEnd = Math.min(bStart + half, actualCount);
      if (bStart >= actualCount) continue;
      const slice = testSamples.slice(bStart, bEnd);
      const range = rangeForSlice(slice);
      promises.push(timedFetch(movUrl, range.start, range.end));
    }
    const fetches = await Promise.all(promises);
    const wall = performance.now() - t0;
    const ttff = Math.min(...fetches.map(f => f.ttfb));
    const totalBytesC = fetches.reduce((a, f) => a + f.bytes, 0);
    results.push({ label, wall, ttff, bytes: totalBytesC, requests: 2 });
  }

  // Strategy D: 3 concurrent connections
  {
    const label = "D: 3-conn parallel";
    const chunk = Math.ceil(actualCount / 3);
    const t0 = performance.now();
    const promises = [];
    for (let c = 0; c < 3; c++) {
      const bStart = c * chunk;
      const bEnd = Math.min(bStart + chunk, actualCount);
      if (bStart >= actualCount) continue;
      const slice = testSamples.slice(bStart, bEnd);
      const range = rangeForSlice(slice);
      promises.push(timedFetch(movUrl, range.start, range.end));
    }
    const fetches = await Promise.all(promises);
    const wall = performance.now() - t0;
    const ttff = Math.min(...fetches.map(f => f.ttfb));
    const totalBytesD = fetches.reduce((a, f) => a + f.bytes, 0);
    results.push({ label, wall, ttff, bytes: totalBytesD, requests: 3 });
  }

  // Strategy E: 6 concurrent connections (Chrome max per origin)
  {
    const label = "E: 6-conn parallel";
    const chunk = Math.ceil(actualCount / 6);
    const t0 = performance.now();
    const promises = [];
    for (let c = 0; c < 6; c++) {
      const bStart = c * chunk;
      const bEnd = Math.min(bStart + chunk, actualCount);
      if (bStart >= actualCount) continue;
      const slice = testSamples.slice(bStart, bEnd);
      const range = rangeForSlice(slice);
      promises.push(timedFetch(movUrl, range.start, range.end));
    }
    const fetches = await Promise.all(promises);
    const wall = performance.now() - t0;
    const ttff = Math.min(...fetches.map(f => f.ttfb));
    const totalBytesE = fetches.reduce((a, f) => a + f.bytes, 0);
    results.push({ label, wall, ttff, bytes: totalBytesE, requests: 6 });
  }

  // Strategy F: 10 concurrent connections (current approach)
  {
    const label = "F: 10-conn parallel (current)";
    const chunk = Math.ceil(actualCount / 10);
    const t0 = performance.now();
    const promises = [];
    for (let c = 0; c < 10; c++) {
      const bStart = c * chunk;
      const bEnd = Math.min(bStart + chunk, actualCount);
      if (bStart >= actualCount) continue;
      const slice = testSamples.slice(bStart, bEnd);
      const range = rangeForSlice(slice);
      promises.push(timedFetch(movUrl, range.start, range.end));
    }
    const fetches = await Promise.all(promises);
    const wall = performance.now() - t0;
    const ttff = Math.min(...fetches.map(f => f.ttfb));
    const totalBytesF = fetches.reduce((a, f) => a + f.bytes, 0);
    results.push({ label, wall, ttff, bytes: totalBytesF, requests: 10 });
  }

  // Strategy G: 2 sequential large requests
  {
    const label = "G: 2 serial large batches";
    const half = Math.ceil(actualCount / 2);
    const t0 = performance.now();
    let firstTtfb = 0;
    let totalBytesG = 0;
    for (let c = 0; c < 2; c++) {
      const bStart = c * half;
      const bEnd = Math.min(bStart + half, actualCount);
      if (bStart >= actualCount) break;
      const slice = testSamples.slice(bStart, bEnd);
      const range = rangeForSlice(slice);
      const r = await timedFetch(movUrl, range.start, range.end);
      totalBytesG += r.bytes;
      if (c === 0) firstTtfb = r.ttfb;
    }
    const wall = performance.now() - t0;
    results.push({ label, wall, ttff: firstTtfb, bytes: totalBytesG, requests: 2 });
  }

  // --- 1d. Connection reuse test ---
  console.log("--- Connection Reuse ---");
  {
    const ttfbs = [];
    const mid = samples[Math.floor(samples.length / 2)];
    for (let i = 0; i < 5; i++) {
      const idx = Math.floor(samples.length / 2) + i;
      const s = samples[Math.min(idx, samples.length - 1)];
      const r = await timedFetch(movUrl, s.offset, s.offset + s.size - 1);
      ttfbs.push(r.ttfb);
    }
    console.log(`  5 sequential requests TTFB: ${ttfbs.map(t => t.toFixed(0) + "ms").join(", ")}`);
    console.log(`  1st request TTFB: ${ttfbs[0].toFixed(0)}ms`);
    console.log(`  avg 2-5 TTFB: ${(ttfbs.slice(1).reduce((a, b) => a + b, 0) / 4).toFixed(0)}ms`);
    console.log(`  reuse benefit: ${ttfbs[0] > ttfbs[1] * 1.3 ? "YES (keep-alive helps)" : "MINIMAL"}`);
  }

  // --- 1e. Results table ---
  console.log("\n--- Results ---\n");
  console.log(
    "| Strategy                       | Wall (ms) | Throughput  |  fps  | TTFF (ms) | Requests |" +
    " Can sustain 25fps? |"
  );
  console.log(
    "|--------------------------------|-----------|-------------|-------|-----------|----------|" +
    "--------------------|"
  );

  for (const r of results) {
    const wallSec = r.wall / 1000;
    const throughput = formatRate(r.bytes / wallSec);
    const frameFps = actualCount / wallSec;
    const sustain = frameFps >= 25 ? "YES" : "no";
    console.log(
      `| ${r.label.padEnd(30)} | ${r.wall.toFixed(0).padStart(9)} | ${throughput.padStart(11)} | ${frameFps.toFixed(1).padStart(5)} | ${r.ttff.toFixed(0).padStart(9)} | ${String(r.requests).padStart(8)} | ${sustain.padStart(18)} |`,
    );
  }

  // Find winner
  const winner = results.reduce((best, r) => r.wall < best.wall ? r : best, results[0]);
  console.log(`\nWinner: ${winner.label} (${winner.wall.toFixed(0)}ms)`);

  // Recommendations
  console.log("\n--- Recommendations ---");
  const bestParallel = results.filter(r => r.label.includes("parallel"))
    .reduce((best, r) => r.wall < best.wall ? r : best, results[2]);
  const bestSerial = results.filter(r => r.label.includes("serial"))
    .reduce((best, r) => r.wall < best.wall ? r : best, results[1]);

  if (bestParallel.wall < bestSerial.wall * 0.9) {
    const connCount = parseInt(bestParallel.label.match(/(\d+)-conn/)?.[1] || "2");
    const batchSize = Math.ceil(actualCount / connCount);
    console.log(`  Use ${connCount} parallel connections with batch size ~${batchSize}`);
    console.log(`  This is ${((1 - bestParallel.wall / results[5].wall) * 100).toFixed(0)}% faster than current 10-conn approach`);
  } else {
    console.log(`  Serial fetching is competitive — server may serialize concurrent requests`);
    console.log(`  Use fewer connections (1-2) with larger batches`);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
