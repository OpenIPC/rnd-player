/**
 * Diagnostic probe: tests H.264 WebCodecs decoding inside a Web Worker context.
 *
 * The previous main-thread probe showed decoding works on ALL platforms.
 * This probe tests the Worker context specifically, since thumbnailWorker.ts
 * runs in a Worker and filmstrip thumbnails fail on Linux WebKit/Firefox.
 *
 * Strategy: parse mp4 with mp4box in Node.js (the test runner), extract the
 * decoder config and sample bytes, then pass them into the browser and test
 * VideoDecoder in both main-thread and Worker contexts. This avoids any
 * browser-side mp4box loading issues (Firefox Playwright can't load modules
 * via dynamic script tags).
 *
 * Temporary file — remove after investigation.
 */
import { test, expect } from "@playwright/test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  createFile as mp4boxCreateFile,
  DataStream as Mp4DataStream,
  MP4BoxBuffer,
  Endianness as Mp4Endianness,
} from "mp4box";

const dashFixtureDir = process.env.DASH_FIXTURE_DIR ?? "";

test.skip(
  !dashFixtureDir || !existsSync(join(dashFixtureDir, "manifest.mpd")),
  "DASH fixture not generated — run: bash e2e/generate-dash-fixture.sh",
);

// ── Parse init + first media segment in Node.js ──

interface ParsedSegment {
  codec: string;
  codedWidth: number;
  codedHeight: number;
  description: Buffer;
  sampleData: Buffer;
  sampleTimestamp: number;
}

function parseSegmentInNode(): ParsedSegment | null {
  const initPath = join(dashFixtureDir, "init-stream4.m4s");
  const mediaPath = join(dashFixtureDir, "chunk-stream4-00001.m4s");
  if (!existsSync(initPath) || !existsSync(mediaPath)) return null;

  const initBuf = readFileSync(initPath);
  const mediaBuf = readFileSync(mediaPath);

  let result: ParsedSegment | null = null;

  const mp4File = mp4boxCreateFile();

  mp4File.onReady = (info: any) => {
    const vt = info.videoTracks[0];
    if (!vt) return;

    // Extract avcC description (same logic as thumbnailWorker)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const trak = mp4File.getTrackById(vt.id) as any;
    const entries = trak?.mdia?.minf?.stbl?.stsd?.entries;
    const entry = entries?.[0];
    const box = entry?.avcC ?? entry?.hvcC ?? entry?.vpcC ?? entry?.av1C;

    let description: Buffer | null = null;
    if (box) {
      const stream = new Mp4DataStream(
        undefined,
        0,
        Mp4Endianness.BIG_ENDIAN,
      );
      box.write(stream);
      const pos = stream.getPosition();
      description = Buffer.from(new Uint8Array(stream.buffer, 8, pos - 8));
    }

    mp4File.setExtractionOptions(vt.id, null, { nbSamples: 500 });

    mp4File.onSamples = (_id: number, _ref: unknown, samples: any[]) => {
      const sync = samples.find((s: any) => s.is_sync && s.data);
      if (sync && description) {
        result = {
          codec: vt.codec,
          codedWidth: vt.video?.width ?? 426,
          codedHeight: vt.video?.height ?? 240,
          description,
          sampleData: Buffer.from(new Uint8Array(sync.data)),
          sampleTimestamp: (sync.cts / sync.timescale) * 1_000_000,
        };
      }
    };

    mp4File.start();
  };

  mp4File.onError = () => {};

  // Feed init + media segment (same pattern as helpers.ts)
  const initAB = initBuf.buffer.slice(
    initBuf.byteOffset,
    initBuf.byteOffset + initBuf.byteLength,
  );
  const initSlice = MP4BoxBuffer.fromArrayBuffer(initAB, 0);
  const offset1 = mp4File.appendBuffer(initSlice);

  const mediaAB = mediaBuf.buffer.slice(
    mediaBuf.byteOffset,
    mediaBuf.byteOffset + mediaBuf.byteLength,
  );
  const mediaSlice = MP4BoxBuffer.fromArrayBuffer(mediaAB, offset1);
  mp4File.appendBuffer(mediaSlice);
  mp4File.flush();
  mp4File.stop();

  return result;
}

const parsed = parseSegmentInNode();

test("WebCodecs H.264 decoding in Worker context", async ({
  page,
  browserName,
}) => {
  test.skip(!parsed, "Failed to parse DASH segment in Node.js");

  // Navigate to Vite dev server — WebCodecs requires a secure context
  // (HTTPS or localhost). about:blank doesn't qualify.
  await page.goto("/");

  // Capture console messages for debugging
  const consoleLogs: string[] = [];
  page.on("console", (msg) => {
    consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
  });

  // Pass pre-parsed data to the browser
  const result = await page.evaluate(
    async ({
      codec,
      codedWidth,
      codedHeight,
      descriptionB64,
      sampleDataB64,
      sampleTimestamp,
    }) => {
      // Decode base64 to ArrayBuffer
      const b64ToBuffer = (b64: string): ArrayBuffer => {
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        return bytes.buffer;
      };

      const description = b64ToBuffer(descriptionB64);
      const sampleData = b64ToBuffer(sampleDataB64);

      // ── Test 1: Main thread decode ──
      let mainThreadResult: Record<string, unknown> = {
        success: false,
        hasVideoDecoder: typeof VideoDecoder !== "undefined",
      };

      if (typeof VideoDecoder !== "undefined") {
        try {
          const config = {
            codec,
            codedWidth,
            codedHeight,
            description: new Uint8Array(description),
          };

          let frameCount = 0;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let lastFrame: any = null;

          const decoder = new VideoDecoder({
            output: (frame: VideoFrame) => {
              frameCount++;
              lastFrame = {
                width: frame.codedWidth,
                height: frame.codedHeight,
                format: frame.format,
              };
              frame.close();
            },
            error: () => {},
          });

          decoder.configure(config);

          decoder.decode(
            new EncodedVideoChunk({
              type: "key",
              timestamp: sampleTimestamp,
              data: new Uint8Array(sampleData.slice(0)),
            }),
          );

          await decoder.flush();
          try {
            decoder.close();
          } catch {}

          mainThreadResult = {
            success: frameCount > 0,
            hasVideoDecoder: true,
            frameCount,
            frameWidth: lastFrame?.width,
            frameHeight: lastFrame?.height,
            frameFormat: lastFrame?.format ?? "unknown",
          };
        } catch (err) {
          mainThreadResult.error =
            err instanceof Error ? err.message : String(err);
        }
      }

      // ── Test 2: Worker decode ──
      const workerCode = `
        self.onmessage = async (e) => {
          const { codec, description, sampleData, sampleTimestamp, codedWidth, codedHeight } = e.data;
          const result = {
            success: false,
            hasVideoDecoder: typeof VideoDecoder !== "undefined",
            hasEncodedVideoChunk: typeof EncodedVideoChunk !== "undefined",
          };

          try {
            if (typeof VideoDecoder === "undefined") {
              result.error = "VideoDecoder not available in Worker scope";
              self.postMessage(result);
              return;
            }

            // Diagnostic: check isConfigSupported
            try {
              const support = await VideoDecoder.isConfigSupported({
                codec,
                codedWidth,
                codedHeight,
                description: new Uint8Array(description),
              });
              result.isConfigSupported = support.supported;
            } catch (e) {
              result.isConfigSupportedError = e instanceof Error ? e.message : String(e);
            }

            // Configure + decode (matching thumbnailWorker — no isConfigSupported gate)
            const config = {
              codec,
              codedWidth,
              codedHeight,
              description: new Uint8Array(description),
            };

            let frameCount = 0;
            let lastFrame = null;
            let decoderError = null;

            const decoder = new VideoDecoder({
              output: (frame) => {
                frameCount++;
                lastFrame = {
                  width: frame.codedWidth,
                  height: frame.codedHeight,
                  format: frame.format,
                };
                frame.close();
              },
              error: (err) => {
                decoderError = err.message;
              },
            });

            decoder.configure(config);
            result.decoderState = decoder.state;

            decoder.decode(
              new EncodedVideoChunk({
                type: "key",
                timestamp: sampleTimestamp,
                data: new Uint8Array(sampleData),
              }),
            );

            await decoder.flush();

            try { decoder.close(); } catch {}

            result.success = frameCount > 0;
            result.frameCount = frameCount;
            result.decoderError = decoderError;
            if (lastFrame) {
              result.frameWidth = lastFrame.width;
              result.frameHeight = lastFrame.height;
              result.frameFormat = lastFrame.format ?? "unknown";
            }
            if (frameCount === 0 && !decoderError) {
              result.error = "Decoder produced 0 frames after flush";
            }
          } catch (err) {
            result.error = "Exception: " + (err instanceof Error ? err.message : String(err));
          }

          self.postMessage(result);
        };
      `;

      const blob = new Blob([workerCode], {
        type: "application/javascript",
      });
      const workerUrl = URL.createObjectURL(blob);

      const workerResult = await new Promise<Record<string, unknown>>(
        (resolve) => {
          const worker = new Worker(workerUrl);

          const timeout = setTimeout(() => {
            worker.terminate();
            URL.revokeObjectURL(workerUrl);
            resolve({ success: false, error: "Worker timed out after 15s" });
          }, 15_000);

          worker.onmessage = (ev) => {
            clearTimeout(timeout);
            worker.terminate();
            URL.revokeObjectURL(workerUrl);
            resolve(ev.data);
          };

          worker.onerror = (ev) => {
            clearTimeout(timeout);
            worker.terminate();
            URL.revokeObjectURL(workerUrl);
            resolve({
              success: false,
              error: `Worker error: ${ev.message ?? "unknown"}`,
            });
          };

          // Send data (use slice to avoid detach issues)
          worker.postMessage({
            codec,
            description: description.slice(0),
            sampleData: sampleData.slice(0),
            sampleTimestamp,
            codedWidth,
            codedHeight,
          });
        },
      );

      return { mainThread: mainThreadResult, worker: workerResult };
    },
    {
      codec: parsed!.codec,
      codedWidth: parsed!.codedWidth,
      codedHeight: parsed!.codedHeight,
      descriptionB64: parsed!.description.toString("base64"),
      sampleDataB64: parsed!.sampleData.toString("base64"),
      sampleTimestamp: parsed!.sampleTimestamp,
    },
  );

  // Log detailed results for CI analysis
  console.log(`\n=== Worker WebCodecs Probe: ${browserName} ===`);
  console.log(JSON.stringify(result, null, 2));
  if (consoleLogs.length > 0) {
    console.log("Browser console:\n" + consoleLogs.join("\n"));
  }
  console.log("===\n");

  const mainThread = result.mainThread as Record<string, unknown>;
  const workerDecode = result.worker as Record<string, unknown>;

  if (mainThread?.success) {
    console.log(
      `Main thread: PASS ${mainThread.frameCount} frame(s) ${mainThread.frameWidth}x${mainThread.frameHeight} ${mainThread.frameFormat}`,
    );
  } else {
    console.log(`Main thread: FAIL ${mainThread?.error ?? "no VideoDecoder"}`);
  }

  if (workerDecode?.success) {
    console.log(
      `Worker:      PASS ${workerDecode.frameCount} frame(s) ${workerDecode.frameWidth}x${workerDecode.frameHeight} ${workerDecode.frameFormat}`,
    );
  } else {
    console.log(`Worker:      FAIL ${workerDecode?.error}`);
  }

  // Always pass — this is a diagnostic probe
  expect(true).toBe(true);
});
