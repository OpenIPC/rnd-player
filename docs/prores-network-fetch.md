# ProRes Network Fetch Strategy

Research into optimal HTTP fetch strategies for real-time ProRes playback. Documents the current architecture, Chrome trace debugging methodology, discovered browser limitations, and action points for future work.

## Problem Statement

ProRes HQ 1080p content has an average bitrate of **181 Mbps** (~884 KB/frame at 25fps). The player must fetch, decode, and render frames at this rate for smooth real-time playback. Network fetch latency and throughput are the primary bottleneck — WASM decode capacity (~147 fps single-worker) is not the limiting factor.

## Current Architecture

```
Main thread (fetch)              Workers (decode only)
  │                                ├── Worker 0: WASM decode
  │  1. Single Range request       ├── Worker 1: WASM decode
  │     for entire buffer window   └── Worker 2: WASM decode
  │     (~62 frames, ~55 MB)
  │
  │  2. await response.arrayBuffer()
  │     (browser downloads internally)
  │
  │  3. Extract frames, dispatch
  │     round-robin to decode workers
  │     via postMessage + Transferable
  │
  │  4. Workers decode, return
  │     YUV planes via postMessage
  │
  │  5. Ring buffer → rAF loop → WebGL2
```

### Key Design Decisions

**Main-thread fetch, worker-only decode.** Chrome Web Workers each open independent TCP connections — there is no connection reuse across workers or between workers and the main thread. Moving fetch to the main thread ensures a single connection per pipeline, avoiding per-request TCP overhead.

**Single large Range request.** A single request for the entire buffer window (~55 MB) pays one TTFB cost (~600 ms) instead of N costs. The browser's `arrayBuffer()` downloads at full internal speed without JS event loop contention.

**Pre-compiled WASM.** The WASM module is compiled once on the main thread using `WebAssembly.compileStreaming()` during moov probe (parallel). The compiled `WebAssembly.Module` is sent to workers via `postMessage` (structured-clonable). Workers instantiate from the pre-compiled module — eliminates the ~5 second per-worker compilation delay.

**Pre-buffer before play.** Playback starts only after `MIN_BUFFER_BEFORE_PLAY` (15) consecutive frames are decoded. This prevents immediate buffer underruns after pressing play.

**Smart seek.** If the target frame is already in the ring buffer, it renders instantly without cancelling the active fetch pipeline. Only out-of-buffer seeks cancel and re-dispatch.

### Constants

| Constant | Value | Rationale |
|---|---|---|
| `MAX_WORKERS` | 3 | Decode-only workers; 3 gives ~440 fps decode capacity |
| `BATCH_SIZE` | 10 | Unused in current single-request model; kept for future use |
| `MAX_BUFFER_MEMORY` | 500 MB | Hard cap on decoded frame memory |
| `MIN_BUFFER_BEFORE_PLAY` | 15 | ~0.6s at 25fps before playback starts |
| `maxBufferFrames` | ~62 | Derived: `MAX_BUFFER_MEMORY / estimatedFrameBytes` |

## Architecture Evolution

The fetch strategy went through several iterations, each informed by Chrome trace analysis:

### v1: N workers, each fetch + decode (original)

- `hardwareConcurrency` workers (up to 16), each independently fetching and decoding
- `BATCH_SIZE=10` frames per Range request per worker
- **Problem**: N concurrent HTTP connections caused server serialization (TTFB staircase: 600ms per additional connection) and TCP slow start on every connection

### v2: Pipeline mode — workers self-schedule

- Added `decodePipeline` message: worker loops through batches within an assigned range
- Workers fetch sequentially within their pipeline (connection reuse potential)
- Reduced to 3 workers, increased batch size to 30
- **Problem**: Chrome Web Workers don't share connection pools — `connectionReused=false` on every request regardless of sequential fetch pattern

### v3: Main-thread fetch, worker decode

- Moved all fetching to the main thread
- Workers receive pre-fetched frame data via `decodeOnly` message
- Sequential `fetch()` calls from main thread for each batch
- **Problem**: Chrome still showed `connectionReused=false` even for sequential same-origin requests from the main thread. Each batch paid 600ms TTFB.

### v4: Streaming single request

- Single large Range request using `response.body.getReader()`
- Frames extracted from the stream as their bytes arrive
- **Problem**: O(n^2) accumulator bug in v4a (fixed). After fix, main-thread `reader.read()` loop competed with rAF/React for event loop time, limiting throughput to 30-56 Mbps vs 475 Mbps from Node.js.

### v5: Single arrayBuffer request (current)

- Single Range request, `await response.arrayBuffer()`
- Browser downloads internally at full speed
- All frames extracted and dispatched in one fast loop after download completes
- **Result**: 40-66 Mbps throughput. Still 3-7x below Node.js baseline (475 Mbps), but no code-level fix exists for this gap.

## Browser Network Limitations Discovered

### No connection reuse from Web Workers

Every `fetch()` call from a Web Worker opens a new TCP connection. Chrome DevTools traces consistently show `connectionReused=false` for all worker-originated requests. Workers do not share the main thread's connection pool.

**Evidence**: Trace analysis across 5 sessions, 3-16 workers, all showing `connectionReused=false`. Verified with `curl` that the server (ecstatic) properly supports HTTP keep-alive.

### No connection reuse from main thread (cross-origin)

Even sequential `fetch()` calls from the main thread to a cross-origin server (different port) showed `connectionReused=false`. The app runs on `localhost:5173` (Vite dev) while the MOV server is on `10.x.x.x:3000`.

### Server serialization (ecstatic)

The ecstatic static file server (single-threaded Node.js) serializes concurrent Range requests. With N concurrent connections, TTFB follows a linear staircase: ~600ms per additional connection.

**Evidence**: 6 concurrent requests showed TTFB of 592, 1153, 1698, 2263, 2816, 3375ms — perfect ~550ms spacing.

### Browser throughput gap

| Method | 50 MB download | Throughput |
|---|---|---|
| Node.js `fetch` (undici) | 850 ms | 475 Mbps |
| Browser `arrayBuffer()` | ~6000 ms | 66 Mbps |
| Browser `ReadableStream` | ~15000 ms | 30 Mbps |

The 7x gap between Node.js and browser `arrayBuffer()` is due to: renderer process IPC overhead, Chrome's network stack buffering, and lack of connection reuse (fresh TCP + slow start on every request).

## Debugging Methodology

### Simulation script (`wasm/sim-prores-fetch.mjs`)

A Node.js script that tests fetch strategies against the real server, measuring what the network/server can actually deliver:

```bash
node wasm/sim-prores-fetch.mjs --url http://server:3000/file.mov
node wasm/sim-prores-fetch.mjs --url http://server:3000/file.mov --start 100 --count 200
```

**What it measures:**

1. **Frame size distribution** (min, median, avg, p95, max) and content bitrate
2. **Baseline network**: single 1 MB and 10 MB requests for TTFB + throughput
3. **7 fetch strategies** (1-conn serial through 10-conn parallel), each fetching 100 frames:
   - Wall-clock time, effective throughput, time-to-first-frame
   - Whether each strategy can sustain 25fps
4. **Connection reuse**: 5 sequential requests, comparing 1st TTFB vs subsequent

**Key insight**: the simulation establishes the **server-side ceiling** — the maximum throughput the server can deliver. If the browser can't reach this ceiling, the bottleneck is browser-side.

### Chrome trace analysis

Chrome Performance traces (`chrome://tracing` or DevTools Performance panel) were analyzed programmatically via Node.js scripts that parse the JSON trace format.

**Network request analysis:**
```js
// Extract timing for all MOV requests
const sends = events.filter(e => e.name === 'ResourceSendRequest' && e.args?.data?.url?.includes('.mov'));
const responses = events.filter(e => e.name === 'ResourceReceiveResponse');
// Key fields: connectionReused, statusCode, encodedDataLength
```

This revealed: TTFB staircase patterns, connection reuse status, per-request throughput, and concurrent request overlap.

**Frame delivery timeline:**
```js
// Worker→main postMessages = decoded frame delivery
const mainMsgs = events.filter(e => e.tid === mainTid && e.name === 'HandlePostMessage');
// Group by 500ms windows to see burst patterns
```

This revealed: bursty delivery (all frames arrive at once after download completes) vs smooth streaming, and gaps between pipeline completions.

**rAF gap analysis:**
```js
// FireAnimationFrame gaps = visible stutters
const rafs = events.filter(e => e.name === 'FireAnimationFrame').sort((a,b) => a.ts - b.ts);
for (let i = 1; i < rafs.length; i++) gaps.push(rafs[i].ts - rafs[i-1].ts);
// Gaps > 100ms = user-visible freeze
```

This revealed: pre-buffer wait times, buffer underrun patterns, and main-thread blocking.

**Worker thread activity:**
```js
const workerTids = events.filter(e => e.name === 'thread_name' && e.args?.name === 'DedicatedWorker thread');
// HandlePostMessage count per worker = messages received
// FunctionCall durations = WASM decode time
```

This revealed: workers were idle most of the time (starved for data), and WASM compilation took ~5 seconds before the pre-compiled module fix.

**Data streaming rate:**
```js
const recvData = events.filter(e => e.name === 'ResourceReceivedData');
// Group by 1-second buckets to see throughput ramp-up (TCP slow start)
```

This revealed: streaming throughput was limited to 30-56 Mbps by JS event loop contention.

### Key debugging pattern

1. **Simulate** with Node.js to establish the server-side ceiling
2. **Capture** a Chrome Performance trace during playback
3. **Parse** the trace JSON to extract network timing, frame delivery, and rAF gaps
4. **Compare** browser results to Node.js baseline to identify browser-side bottlenecks
5. **Implement** a fix based on the findings
6. **Capture** another trace and compare metrics to verify improvement

## Action Points

### Server-side (highest impact)

1. **HTTP/2 support.** Chrome multiplexes all requests over a single TCP connection, eliminating per-request connection overhead and TTFB staircase. Test with nginx as a reverse proxy:
   ```
   server {
     listen 3000 http2;
     location / { proxy_pass http://localhost:3001; }
   }
   ```

2. **Same-origin serving.** Serve MOV files from the same origin as the app (same port). This may enable Chrome's connection reuse for sequential requests. Configure Vite's dev server proxy:
   ```js
   // vite.config.ts
   server: { proxy: { '/media': 'http://10.x.x.x:3000' } }
   ```

3. **Replace ecstatic.** Use nginx, caddy, or a multi-threaded file server that can serve concurrent Range requests without serialization.

### Browser-side (code changes)

4. **Dedicated fetch worker.** Move the `arrayBuffer()` download to a single dedicated worker. This frees the main thread entirely and may improve throughput since the worker's event loop is not competing with React/rAF. The fetch worker posts frame data to the main thread, which dispatches to decode workers.

5. **Adaptive pipeline depth.** Monitor actual throughput during playback. If throughput exceeds content bitrate, use single-request mode (lower TTFB overhead). If throughput is insufficient, switch to concurrent requests (higher aggregate throughput despite TTFB staircase).

6. **Overlap fetch and playback.** Start the next pipeline fetch before the current buffer is exhausted. Currently, a new pipeline starts only after the previous one completes and the buffer runs out. Starting the next fetch when the buffer drops below 50% would eliminate inter-pipeline gaps.

7. **Progressive playback start.** Use `ReadableStream` for the first pipeline to enable playback as soon as the first batch of frames arrives, then switch to `arrayBuffer()` for subsequent pipelines. This trades first-pipeline throughput for lower time-to-first-frame.

### Measurement

8. **Automated throughput regression test.** Run `wasm/sim-prores-fetch.mjs` in CI against a reference server to detect server/network regressions.

9. **Browser throughput benchmark.** Build an in-app diagnostic that measures actual `arrayBuffer()` throughput for the target server and reports whether real-time playback is achievable before the user presses play.

## File Map

| File | Purpose |
|---|---|
| `wasm/sim-prores-fetch.mjs` | Network fetch strategy simulation (Node.js) |
| `src/hooks/useProResPlayback.ts` | Main-thread fetch pipeline + worker decode pool |
| `src/workers/proResWorker.ts` | WASM decode worker (supports `decodeOnly` + legacy modes) |
| `src/types/proResWorker.types.ts` | Message types (`decodeOnly`, `decodePipeline`, etc.) |
| `src/components/ProResViewer.tsx` | WASM pre-compilation + moov probe (parallel) |
| `src/wasm/proresDecoder.ts` | WASM loader (accepts pre-compiled module) |
| `docs/prores-viewer.md` | Core ProRes viewer architecture |
