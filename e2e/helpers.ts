import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixturePath = join(__dirname, "fixtures", "test-video.mp4");
const videoBytes = readFileSync(fixturePath);

/**
 * Intercepts requests for the test video fixture and navigates to the player.
 * Waits until the controls overlay is visible (player fully loaded).
 */
export async function loadPlayerWithFixture(page: Page) {
  await page.route(
    (url) => url.pathname.endsWith("/test-video.mp4"),
    (route) => {
      route.fulfill({
        status: 200,
        contentType: "video/mp4",
        body: videoBytes,
      });
    },
  );

  await page.goto("/?v=/test-video.mp4");
  await page.locator(".vp-controls-wrapper").waitFor({
    state: "visible",
    timeout: 15_000,
  });
}

// --- DASH fixture support ---

const dashFixtureDir = process.env.DASH_FIXTURE_DIR ?? "";

export function isDashFixtureAvailable(): boolean {
  if (!dashFixtureDir) return false;
  return existsSync(join(dashFixtureDir, "manifest.mpd"));
}

const dashFiles = new Map<string, Buffer>();

if (isDashFixtureAvailable()) {
  const files = readdirSync(dashFixtureDir);
  for (const file of files) {
    const fullPath = join(dashFixtureDir, file);
    if (statSync(fullPath).isFile()) {
      dashFiles.set(file, readFileSync(fullPath));
    }
  }
}

function contentTypeFor(filename: string): string {
  if (filename.endsWith(".mpd")) return "application/dash+xml";
  if (filename.endsWith(".mp4") || filename.endsWith(".m4s"))
    return "video/mp4";
  return "application/octet-stream";
}

/**
 * Intercepts /dash/* requests, serves DASH fixture files from memory.
 * Navigates to the player with the DASH manifest, waits for controls,
 * then pauses and seeks to time 0 so frame "0000" is displayed.
 */
export async function loadPlayerWithDash(page: Page) {
  await page.route(
    (url) => url.pathname.startsWith("/dash/"),
    (route) => {
      const filename = route.request().url().split("/dash/").pop() ?? "";
      const body = dashFiles.get(filename);
      if (body) {
        route.fulfill({
          status: 200,
          contentType: contentTypeFor(filename),
          body,
        });
      } else {
        route.fulfill({ status: 404 });
      }
    },
  );

  await page.goto("/?v=/dash/manifest.mpd");
  await page.locator(".vp-controls-wrapper").waitFor({
    state: "visible",
    timeout: 30_000,
  });

  // Pause and seek to time 0 to ensure frame "0000" is rendered
  await page.evaluate(async () => {
    const video = document.querySelector("video")!;
    video.pause();
    if (video.currentTime !== 0) {
      const seeked = new Promise((resolve) =>
        video.addEventListener("seeked", resolve, { once: true }),
      );
      video.currentTime = 0;
      // Timeout prevents hanging on WebKitGTK where seeks can stall
      await Promise.race([seeked, new Promise((r) => setTimeout(r, 5000))]);
    }
  });
}

// --- Encrypted DASH fixture support ---

export const CLEAR_KEY_KID = "00112233445566778899aabbccddeeff";
export const CLEAR_KEY_HEX = "0123456789abcdef0123456789abcdef";

const encryptedDashFixtureDir = dashFixtureDir
  ? join(dashFixtureDir, "encrypted")
  : "";

export function isEncryptedDashFixtureAvailable(): boolean {
  if (!encryptedDashFixtureDir) return false;
  return existsSync(join(encryptedDashFixtureDir, "manifest.mpd"));
}

const encryptedDashFiles = new Map<string, Buffer>();

if (isEncryptedDashFixtureAvailable()) {
  const files = readdirSync(encryptedDashFixtureDir);
  for (const file of files) {
    const fullPath = join(encryptedDashFixtureDir, file);
    if (statSync(fullPath).isFile()) {
      encryptedDashFiles.set(file, readFileSync(fullPath));
    }
  }
}

/**
 * Intercepts /encrypted-dash/* requests, serves encrypted DASH fixture files.
 * Navigates to the player, enters the ClearKey decryption key when prompted,
 * then pauses and seeks to time 0.
 */
export async function loadPlayerWithEncryptedDash(page: Page) {
  // Shaka Packager produces single-segment MP4 files with SegmentBase in MPD.
  // Shaka Player fetches segments via byte-range requests (Range header).
  await page.route(
    (url) => url.pathname.startsWith("/encrypted-dash/"),
    (route) => {
      const filename =
        route.request().url().split("/encrypted-dash/").pop() ?? "";
      const body = encryptedDashFiles.get(filename);
      if (!body) {
        route.fulfill({ status: 404 });
        return;
      }

      const rangeHeader = route.request().headers()["range"];
      if (rangeHeader) {
        // Parse "bytes=START-END"
        const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
        if (match) {
          const start = parseInt(match[1], 10);
          const end = match[2] ? parseInt(match[2], 10) : body.length - 1;
          const slice = body.subarray(start, end + 1);
          route.fulfill({
            status: 206,
            headers: {
              "Content-Type": contentTypeFor(filename),
              "Content-Range": `bytes ${start}-${end}/${body.length}`,
              "Content-Length": String(slice.length),
              "Accept-Ranges": "bytes",
            },
            body: slice,
          });
          return;
        }
      }

      route.fulfill({
        status: 200,
        contentType: contentTypeFor(filename),
        body,
      });
    },
  );

  await page.goto("/?v=/encrypted-dash/manifest.mpd");

  // Wait for the DRM key prompt overlay
  await page.locator(".vp-key-overlay").waitFor({
    state: "visible",
    timeout: 30_000,
  });

  // Enter the decryption key and submit
  await page.locator(".vp-key-input").fill(CLEAR_KEY_HEX);
  await page.locator(".vp-key-submit").click();

  // Wait for controls (player loaded successfully after key entry)
  await page.locator(".vp-controls-wrapper").waitFor({
    state: "visible",
    timeout: 30_000,
  });

  // Wait for video to become playable (readyState >= 2).
  // On browsers where ClearKey EME silently fails, the player detects
  // this in the background and reloads with software decryption.
  // This wait ensures the reload completes before the test proceeds.
  await page.evaluate(async () => {
    const video = document.querySelector("video")!;
    const start = Date.now();
    while (video.readyState < 2 && Date.now() - start < 10_000) {
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  // Pause and seek to time 0
  await page.evaluate(async () => {
    const video = document.querySelector("video")!;
    video.pause();
    if (video.currentTime !== 0) {
      const seeked = new Promise((resolve) =>
        video.addEventListener("seeked", resolve, { once: true }),
      );
      video.currentTime = 0;
      // Timeout prevents hanging on WebKitGTK where seeks can stall
      await Promise.race([seeked, new Promise((r) => setTimeout(r, 5000))]);
    }
  });
}

// --- HEVC DASH fixture support ---

const hevcDashFixtureDir = dashFixtureDir
  ? join(dashFixtureDir, "hevc")
  : "";

export function isHevcDashFixtureAvailable(): boolean {
  if (!hevcDashFixtureDir) return false;
  return existsSync(join(hevcDashFixtureDir, "manifest.mpd"));
}

const hevcDashFiles = new Map<string, Buffer>();

if (isHevcDashFixtureAvailable()) {
  const files = readdirSync(hevcDashFixtureDir);
  for (const file of files) {
    const fullPath = join(hevcDashFixtureDir, file);
    if (statSync(fullPath).isFile()) {
      hevcDashFiles.set(file, readFileSync(fullPath));
    }
  }
}

/**
 * Intercepts /hevc-dash/* requests, serves HEVC DASH fixture files from memory.
 * Navigates to the player with the HEVC DASH manifest, waits for controls,
 * then pauses and seeks to time 0 so frame "0000" is displayed.
 */
export async function loadPlayerWithHevcDash(page: Page) {
  await page.route(
    (url) => url.pathname.startsWith("/hevc-dash/"),
    (route) => {
      const filename =
        route.request().url().split("/hevc-dash/").pop() ?? "";
      const body = hevcDashFiles.get(filename);
      if (body) {
        route.fulfill({
          status: 200,
          contentType: contentTypeFor(filename),
          body,
        });
      } else {
        route.fulfill({ status: 404 });
      }
    },
  );

  await page.goto("/?v=/hevc-dash/manifest.mpd");
  await page.locator(".vp-controls-wrapper").waitFor({
    state: "visible",
    timeout: 30_000,
  });

  // Pause and seek to time 0 to ensure frame "0000" is rendered
  await page.evaluate(async () => {
    const video = document.querySelector("video")!;
    video.pause();
    if (video.currentTime !== 0) {
      const seeked = new Promise((resolve) =>
        video.addEventListener("seeked", resolve, { once: true }),
      );
      video.currentTime = 0;
      // Timeout prevents hanging on WebKitGTK where seeks can stall
      await Promise.race([seeked, new Promise((r) => setTimeout(r, 5000))]);
    }
  });
}

/**
 * Probe whether the browser supports HEVC via MSE (MediaSource.isTypeSupported).
 * Returns true if either hvc1 or hev1 sample entry type is supported.
 */
export async function probeHevcMseSupport(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    if (typeof MediaSource === "undefined") return false;
    return (
      MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L93.B0"') ||
      MediaSource.isTypeSupported('video/mp4; codecs="hev1.1.6.L93.B0"')
    );
  });
}

/**
 * Probe whether the browser supports HEVC via WebCodecs (VideoDecoder.isConfigSupported).
 * Returns true if the VideoDecoder reports support for hvc1 codec.
 */
export async function probeHevcWebCodecsSupport(
  page: Page,
): Promise<boolean> {
  return page.evaluate(async () => {
    if (typeof VideoDecoder === "undefined") return false;
    try {
      const result = await VideoDecoder.isConfigSupported({
        codec: "hvc1.1.6.L93.B0",
        codedWidth: 1920,
        codedHeight: 1080,
      });
      return result.supported === true;
    } catch {
      return false;
    }
  });
}

// --- Shared OCR / seek utilities ---

/**
 * Crop a screenshot to the center of the video and run Tesseract OCR
 * to read the 4-digit frame counter.
 * Accepts a pre-initialized Tesseract worker instance.
 */
export async function readFrameNumber(
  page: Page,
  ocr: Awaited<ReturnType<typeof import("tesseract.js").createWorker>>,
): Promise<string> {
  const video = page.locator("video");
  const box = await video.boundingBox();
  if (!box) throw new Error("video element not visible");

  // Crop to the center 30x15 % of the video where the frame counter is drawn.
  const cropW = box.width * 0.3;
  const cropH = box.height * 0.15;
  const screenshot = await page.screenshot({
    clip: {
      x: box.x + (box.width - cropW) / 2,
      y: box.y + (box.height - cropH) / 2,
      width: cropW,
      height: cropH,
    },
  });

  const {
    data: { text },
  } = await ocr.recognize(screenshot);
  // Tesseract may drop leading zeros on some platforms (e.g. Windows/Edge).
  // The frame counter is always 4 digits, so pad back to 4.
  return text.trim().padStart(4, "0");
}

/**
 * Seek to the given time and wait for the frame to be painted.
 * Uses polling instead of seeked-event listeners to avoid races
 * with Shaka Player's internal seeks during DASH stream init.
 */
export async function seekTo(page: Page, time: number) {
  await page.evaluate(async (t: number) => {
    const video = document.querySelector("video")!;
    // Shaka may do internal seeks during DASH init that override ours.
    // Retry until currentTime actually lands at the target.
    for (let attempt = 0; attempt < 10; attempt++) {
      video.currentTime = t;
      // Per-attempt timeout prevents hanging on WebKitGTK where
      // video.seeking can get stuck as true under CI VM load.
      const deadline = Date.now() + 3000;
      while (video.seeking && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 16));
      }
      if (t === 0 || Math.abs(video.currentTime - t) < 0.5) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    // Double rAF to ensure the decoded frame is composited
    await new Promise((r) =>
      requestAnimationFrame(() => requestAnimationFrame(r)),
    );
  }, time);
}

/**
 * Dispatch a keyboard event directly in the browser and wait for any
 * resulting seek to settle. Bypasses Playwright's keyboard simulation
 * to guarantee modifier keys (shiftKey) are propagated correctly.
 */
export async function pressKeyAndSettle(
  page: Page,
  key: string,
  shiftKey = false,
) {
  await page.evaluate(
    async ({ key, shiftKey }) => {
      const video = document.querySelector("video")!;
      // Register seeked listener BEFORE dispatch so we don't miss fast seeks
      const seeked = new Promise<void>((resolve) => {
        video.addEventListener("seeked", () => resolve(), { once: true });
      });
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          shiftKey,
          bubbles: true,
          cancelable: true,
        }),
      );
      // Wait for the seek pipeline to complete. On Edge/Windows with
      // MSE, the currentTime getter doesn't update until the media
      // pipeline finishes decoding the target frame. Polling rAF or
      // currentTime is unreliable — wait for the actual seeked event.
      // Timeout handles no-op keys (e.g. ArrowLeft at t=0) where no
      // seek is initiated.
      await Promise.race([seeked, new Promise((r) => setTimeout(r, 1000))]);
      // Double rAF to ensure the decoded frame is composited
      await new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r)),
      );
    },
    { key, shiftKey },
  );
}

/**
 * Press a key N times inside a single page.evaluate(), waiting for each
 * seek to complete before pressing again. Running all steps in one
 * evaluate avoids Playwright round-trips that can cause stale
 * currentTime reads on some browsers.
 */
export async function pressKeyNTimesAndSettle(
  page: Page,
  key: string,
  count: number,
) {
  await page.evaluate(
    async ({ key, count }) => {
      const video = document.querySelector("video")!;
      for (let i = 0; i < count; i++) {
        const prevTime = video.currentTime;
        const seeked = new Promise<void>((resolve) => {
          video.addEventListener("seeked", () => resolve(), { once: true });
        });
        document.dispatchEvent(
          new KeyboardEvent("keydown", {
            key,
            bubbles: true,
            cancelable: true,
          }),
        );
        await Promise.race([
          seeked,
          new Promise((r) => setTimeout(r, 1000)),
        ]);
        // Poll until currentTime actually changed (guards against stale getter)
        for (let j = 0; j < 50; j++) {
          if (video.currentTime !== prevTime) break;
          await new Promise((r) => setTimeout(r, 16));
        }
        // Double rAF to ensure the decoded frame is composited
        await new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        );
      }
    },
    { key, count },
  );
}

// --- Shared filmstrip utilities ---

/**
 * Open the filmstrip panel via the right-click context menu.
 * Hides the dev-only debug panel first to avoid overlap.
 */
export async function openFilmstrip(page: Page) {
  await page.evaluate(() => {
    document
      .querySelector<HTMLElement>(".vp-debug-panel")
      ?.style.setProperty("display", "none");
  });

  const videoArea = page.locator(".vp-video-area");
  await videoArea.click({ button: "right" });

  await page
    .locator(".vp-context-menu-item", { hasText: "Filmstrip timeline" })
    .click();

  await page
    .locator(".vp-filmstrip-panel")
    .waitFor({ state: "visible", timeout: 5_000 });
}

/**
 * Poll until the filmstrip canvas shows real thumbnail content.
 * The DASH fixture has a white frame counter on black, so decoded
 * thumbnails contain bright pixels (RGB channel > 80).
 * Placeholder tiles use rgba(255,255,255,0.05) which is nearly invisible.
 */
export async function waitForThumbnails(page: Page, timeout = 30_000) {
  await expect(async () => {
    const bright = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>(
        ".vp-filmstrip-panel canvas",
      );
      if (!canvas) throw new Error("no canvas");

      const dpr = window.devicePixelRatio || 1;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("no 2d context");

      // Sample a horizontal strip in the thumbnail row midpoint.
      // Ruler is 22px top, so thumbnails start around y=22.
      // Sample at ~35px below top, scaled by DPR.
      const y = Math.round(35 * dpr);
      const w = canvas.width;
      const stripH = 2;
      if (y + stripH > canvas.height) throw new Error("canvas too small");

      const data = ctx.getImageData(0, y, w, stripH).data;
      let brightCount = 0;
      const totalPixels = w * stripH;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > 80 || data[i + 1] > 80 || data[i + 2] > 80) {
          brightCount++;
        }
      }
      return brightCount / totalPixels;
    });
    // 2% threshold: "no thumbnails" gives ~0% (placeholder is nearly
    // invisible rgba(255,255,255,0.05)). At high DPR (macOS 2×) the sample
    // strip intersects fewer bright pixels of the frame counter digits,
    // yielding ~3% vs ~6% at DPR 1.
    expect(bright).toBeGreaterThan(0.02);
  }).toPass({ timeout });
}
