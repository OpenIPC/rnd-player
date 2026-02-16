import { test } from "@playwright/test";
import { isDashFixtureAvailable, loadPlayerWithDash } from "./helpers";

test.skip(
  !isDashFixtureAvailable(),
  "DASH fixture not generated — run: bash e2e/generate-dash-fixture.sh",
);

/**
 * Deep diagnostic probe: replicates the exact mp4box → VideoDecoder pipeline
 * used by the thumbnail worker. Fetches real init + media segments, parses
 * them with mp4box to extract the avcC description and sync samples, then
 * feeds them to VideoDecoder.
 *
 * Run on all CI platforms to see exactly where Linux WebKitGTK fails.
 */
test("probe WebCodecs H.264 pipeline (mp4box → VideoDecoder)", async ({
  page,
  browserName,
}) => {
  await loadPlayerWithDash(page);

  // Load mp4box via Vite's module transform. We inject a module script
  // that loads from the Vite dev server — it resolves the bare 'mp4box'
  // specifier to the pre-bundled dependency.
  await page.evaluate(async () => {
    const script = document.createElement("script");
    script.type = "module";
    script.src = "/src/expose-mp4box.ts";
    document.head.appendChild(script);
  });
  await page.waitForFunction(
    () => (window as any).__mp4box !== undefined,
    null,
    { timeout: 10000 },
  );

  const result = await page.evaluate(async () => {
    const info: Record<string, unknown> = {};
    info.userAgent = navigator.userAgent;
    info.hasVideoDecoder = typeof VideoDecoder !== "undefined";
    if (!info.hasVideoDecoder) return info;

    const { createFile, DataStream, Endianness } = (window as any).__mp4box;
    if (!createFile) {
      info.mp4boxError = "mp4box not loaded";
      return info;
    }
    info.mp4boxLoaded = true;

    function toMP4BoxBuffer(ab: ArrayBuffer, offset: number) {
      const buf = ab.slice(0) as ArrayBuffer & { fileStart: number };
      buf.fileStart = offset;
      return buf;
    }

    // ── Step 1: Fetch init + media segments (lowest rendition = stream4) ──
    let initBytes: ArrayBuffer;
    let mediaBytes: ArrayBuffer;
    try {
      initBytes = await (await fetch("/dash/init-stream4.m4s")).arrayBuffer();
      mediaBytes = await (
        await fetch("/dash/chunk-stream4-00001.m4s")
      ).arrayBuffer();
      info.initSize = initBytes.byteLength;
      info.mediaSize = mediaBytes.byteLength;
    } catch (e) {
      info.fetchError = String(e);
      return info;
    }

    // ── Step 2: Parse init segment — extract avcC description ──
    let description: Uint8Array | undefined;
    let codecString = "";
    let videoWidth = 0;
    let videoHeight = 0;

    try {
      const mp4 = createFile();
      mp4.onReady = (fileInfo: any) => {
        const vt = fileInfo.videoTracks?.[0];
        if (!vt) {
          info.initParseError = "No video tracks found";
          return;
        }
        codecString = vt.codec;
        videoWidth = vt.video?.width ?? vt.track_width;
        videoHeight = vt.video?.height ?? vt.track_height;
        info.trackCodec = codecString;
        info.trackWidth = videoWidth;
        info.trackHeight = videoHeight;
        info.trackTimescale = vt.timescale;
        info.trackDuration = vt.duration;
        info.trackSampleCount = vt.nb_samples;

        // Extract avcC box (same as thumbnailWorker.extractDescription)
        const trak = mp4.getTrackById(vt.id) as any;
        if (!trak) {
          info.descriptionError = "getTrackById returned null";
          return;
        }
        const entries = trak.mdia?.minf?.stbl?.stsd?.entries;
        if (!entries || entries.length === 0) {
          info.descriptionError = "No stsd entries";
          return;
        }
        const entry = entries[0];
        info.stsdEntryType = entry.type;
        const box = entry.avcC ?? entry.hvcC ?? entry.vpcC ?? entry.av1C;
        if (!box) {
          info.descriptionError = "No codec config box";
          return;
        }
        info.codecConfigBoxType = "avcC";
        try {
          const stream = new DataStream(
            undefined,
            0,
            Endianness.BIG_ENDIAN,
          );
          box.write(stream);
          const pos = stream.getPosition();
          description = new Uint8Array(stream.buffer, 8, pos - 8);
          info.descriptionSize = description.byteLength;
          info.descriptionHex = Array.from(description.slice(0, 32))
            .map((b: number) => b.toString(16).padStart(2, "0"))
            .join(" ");
        } catch (e) {
          info.descriptionWriteError = String(e);
        }
      };
      mp4.appendBuffer(toMP4BoxBuffer(initBytes, 0));
      mp4.flush();
      mp4.stop();
    } catch (e) {
      info.initParseError = String(e);
      return info;
    }

    if (!description) {
      info.result = "FAILED: no description extracted from init segment";
      return info;
    }

    // ── Step 3: isConfigSupported with real codec + description ──
    try {
      const support = await VideoDecoder.isConfigSupported({
        codec: codecString,
        codedWidth: videoWidth,
        codedHeight: videoHeight,
        description,
      });
      info.isConfigSupported = support.supported;
    } catch (e) {
      info.isConfigSupported_error = String(e);
    }

    // ── Step 4: Extract samples from media segment ──
    interface SampleInfo {
      data: ArrayBuffer;
      cts: number;
      timescale: number;
      is_sync: boolean;
      size: number;
    }
    const samples: SampleInfo[] = [];
    try {
      const mp4 = createFile();
      mp4.onReady = (fileInfo: any) => {
        const vt = fileInfo.videoTracks?.[0];
        if (vt) {
          mp4.setExtractionOptions(vt.id, null, { nbSamples: 5000 });
          mp4.start();
        }
      };
      mp4.onSamples = (_id: number, _ref: unknown, extracted: any[]) => {
        for (const s of extracted) {
          if (s.data)
            samples.push({
              data: s.data,
              cts: s.cts,
              timescale: s.timescale,
              is_sync: s.is_sync,
              size: s.data.byteLength,
            });
        }
      };
      mp4.onError = (_mod: string, msg: string) => {
        info.sampleExtractError = msg;
      };

      const initBuf = toMP4BoxBuffer(initBytes.slice(0), 0);
      const offset1 = mp4.appendBuffer(initBuf);
      const mediaBuf = toMP4BoxBuffer(mediaBytes.slice(0), offset1);
      mp4.appendBuffer(mediaBuf);
      mp4.flush();
      mp4.stop();
    } catch (e) {
      info.sampleExtractError = String(e);
      return info;
    }

    info.totalSamples = samples.length;
    info.syncSampleCount = samples.filter((s) => s.is_sync).length;
    if (samples.length > 0) {
      const s = samples[0];
      info.firstSample = {
        size: s.size,
        isSync: s.is_sync,
        cts: s.cts,
        timescale: s.timescale,
      };
      // First 16 bytes: NAL unit header for diagnosis
      info.firstSampleNALU = Array.from(new Uint8Array(s.data).slice(0, 16))
        .map((b: number) => b.toString(16).padStart(2, "0"))
        .join(" ");
    }

    const syncSample = samples.find((s) => s.is_sync);
    if (!syncSample) {
      info.result = "FAILED: no sync sample in segment";
      return info;
    }

    // ── Step 5: Configure VideoDecoder ──
    let decodeOutputs: Array<{
      width: number;
      height: number;
      timestamp: number;
      format: string | null;
    }> = [];
    let decoderError: string | null = null;

    const config: VideoDecoderConfig = {
      codec: codecString,
      codedWidth: videoWidth,
      codedHeight: videoHeight,
      description,
    };
    info.decoderConfig = {
      codec: codecString,
      codedWidth: videoWidth,
      codedHeight: videoHeight,
      descriptionBytes: description.byteLength,
    };

    try {
      const decoder = new VideoDecoder({
        output: (frame: VideoFrame) => {
          decodeOutputs.push({
            width: frame.displayWidth,
            height: frame.displayHeight,
            timestamp: frame.timestamp,
            format: frame.format,
          });
          frame.close();
        },
        error: (e: DOMException) => {
          decoderError = `${e.name}: ${e.message}`;
        },
      });

      decoder.configure(config);
      info.state_afterConfigure = decoder.state;

      await new Promise((r) => setTimeout(r, 100));
      info.state_afterConfigureWait = decoder.state;
      info.error_afterConfigure = decoderError;

      if (decoder.state !== "configured") {
        info.result = `FAILED: decoder ${decoder.state} after configure`;
        try { decoder.close(); } catch { /* */ }
        return info;
      }

      // ── Step 6: Feed sync sample (keyframe) ──
      const timestamp = (syncSample.cts / syncSample.timescale) * 1_000_000;
      try {
        decoder.decode(
          new EncodedVideoChunk({
            type: "key",
            timestamp,
            data: new Uint8Array(syncSample.data),
          }),
        );
        info.syncDecode_accepted = true;
        info.syncDecode_chunkTimestamp = timestamp;
        info.syncDecode_chunkSize = syncSample.size;
      } catch (e) {
        info.syncDecode_error = String(e);
      }

      // ── Step 7: Flush ──
      try {
        await decoder.flush();
        info.syncFlush_ok = true;
      } catch (e) {
        info.syncFlush_error = String(e);
      }

      await new Promise((r) => setTimeout(r, 300));
      info.state_afterSyncFlush = decoder.state;
      info.error_afterSyncFlush = decoderError;
      info.syncOutputCount = decodeOutputs.length;
      if (decodeOutputs.length > 0) {
        info.syncFirstOutput = decodeOutputs[0];
      }

      // ── Step 8: If single keyframe failed, try ALL samples ──
      if (decodeOutputs.length === 0 && decoder.state === "configured") {
        info.retryAllSamples = true;
        decodeOutputs = [];
        decoderError = null;

        for (const s of samples) {
          try {
            decoder.decode(
              new EncodedVideoChunk({
                type: s.is_sync ? "key" : "delta",
                timestamp: (s.cts / s.timescale) * 1_000_000,
                data: new Uint8Array(s.data),
              }),
            );
          } catch (e) {
            info.allDecode_error = String(e);
            break;
          }
        }

        try {
          await decoder.flush();
          info.allFlush_ok = true;
        } catch (e) {
          info.allFlush_error = String(e);
        }

        await new Promise((r) => setTimeout(r, 500));
        info.allOutputCount = decodeOutputs.length;
        info.state_afterAll = decoder.state;
        info.error_afterAll = decoderError;
        if (decodeOutputs.length > 0) info.allFirstOutput = decodeOutputs[0];
      }

      try { decoder.close(); } catch { /* */ }
    } catch (e) {
      info.pipelineError = String(e);
    }

    info.result =
      decodeOutputs.length > 0
        ? `SUCCESS: ${decodeOutputs.length} frame(s) decoded`
        : `FAILED: 0 frames. Last error: ${decoderError}`;

    return info;
  });

  console.log(
    `\n=== Deep Probe: ${browserName} / ${process.platform} ===`,
  );
  for (const [key, value] of Object.entries(result)) {
    const v = typeof value === "object" ? JSON.stringify(value) : String(value);
    console.log(`  ${key}: ${v}`);
  }
  console.log("===\n");
});
