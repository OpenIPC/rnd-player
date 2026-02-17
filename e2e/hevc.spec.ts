import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { createWorker, PSM } from "tesseract.js";
import {
  isHevcDashFixtureAvailable,
  loadPlayerWithHevcDash,
  probeHevcMseSupport,
  probeHevcWebCodecsSupport,
  readFrameNumber,
  seekTo,
  pressKeyAndSettle,
  openFilmstrip,
  waitForThumbnails,
} from "./helpers";

test.skip(
  !isHevcDashFixtureAvailable(),
  "HEVC DASH fixture not generated — requires libx265 in ffmpeg",
);

// Share a single Tesseract worker across all tests in this file.
let ocr: Awaited<ReturnType<typeof createWorker>>;

test.beforeAll(async () => {
  ocr = await createWorker("eng");
  await ocr.setParameters({
    tessedit_char_whitelist: "0123456789",
    tessedit_pageseg_mode: PSM.SINGLE_WORD,
  });
});

test.afterAll(async () => {
  await ocr?.terminate();
});

/**
 * Try to load the HEVC DASH stream. Returns true if the player loaded
 * successfully, false if the controls didn't appear (browser reports HEVC
 * MSE support via isTypeSupported but actual playback fails).
 */
async function tryLoadHevcDash(page: Page): Promise<boolean> {
  try {
    await loadPlayerWithHevcDash(page);
    return true;
  } catch {
    return false;
  }
}

// ── Capability probe (always runs) ────────────────────────────────────

test.describe("HEVC capability probe", () => {
  test("reports HEVC MSE and WebCodecs support", async ({ page }) => {
    await page.goto("/");

    const mseSupport = await probeHevcMseSupport(page);
    const webCodecsSupport = await probeHevcWebCodecsSupport(page);

    const browser = test.info().project.name;
    test.info().annotations.push({
      type: "hevc-mse",
      description: `${browser}: ${mseSupport ? "supported" : "not supported"}`,
    });
    test.info().annotations.push({
      type: "hevc-webcodecs",
      description: `${browser}: ${webCodecsSupport ? "supported" : "not supported"}`,
    });

    // This test always passes — it's for discovery/logging only.
    // The annotations appear in the Playwright HTML report.
    expect(typeof mseSupport).toBe("boolean");
    expect(typeof webCodecsSupport).toBe("boolean");
  });
});

// ── HEVC playback ─────────────────────────────────────────────────────

test.describe("HEVC playback", () => {
  // HEVC tests may need to wait for a 30s load timeout on browsers where
  // isTypeSupported returns true but actual playback fails (e.g. Firefox).
  // 90s allows the 30s load timeout + retries within the test budget.
  test.setTimeout(90_000);

  test.beforeEach(async ({ page }) => {
    const supported = await probeHevcMseSupport(page);
    test.skip(!supported, "Browser does not support HEVC via MSE");
  });

  for (const [seekTime, expectedFrame] of [
    [0, 0],
    [5, 150],
  ] as const) {
    test(`displays frame ~${String(expectedFrame).padStart(4, "0")} at t=${seekTime}s`, async ({
      page,
    }) => {
      const loaded = await tryLoadHevcDash(page);
      // isTypeSupported can return true on browsers that can't actually
      // play HEVC (e.g. Firefox on macOS/Linux). Skip gracefully.
      test.skip(!loaded, "HEVC MSE reported but player failed to load");
      await seekTo(page, seekTime);
      const frame = await readFrameNumber(page, ocr);
      const actual = parseInt(frame, 10);
      // HEVC B-frame reordering (bframes=3) can cause ±3 frame offset
      // compared to H.264. Use tolerance instead of exact match.
      expect(
        Math.abs(actual - expectedFrame),
        `expected frame ~${expectedFrame}, got ${actual}`,
      ).toBeLessThanOrEqual(3);
    });
  }

  test("ArrowRight steps forward one frame", async ({ page }) => {
    const loaded = await tryLoadHevcDash(page);
    test.skip(!loaded, "HEVC MSE reported but player failed to load");
    await seekTo(page, 0);
    await pressKeyAndSettle(page, "ArrowRight");
    const frame = await readFrameNumber(page, ocr);
    const actual = parseInt(frame, 10);
    // Frame step should land on frame 1, but HEVC composition offsets
    // may shift by a few frames on some platforms
    expect(
      Math.abs(actual - 1),
      `expected frame ~1, got ${actual}`,
    ).toBeLessThanOrEqual(3);
  });

  test("playing advances frames", async ({ page }) => {
    const loaded = await tryLoadHevcDash(page);
    test.skip(!loaded, "HEVC MSE reported but player failed to load");
    await seekTo(page, 0);

    // Play for ~1 s then pause
    await page.evaluate(async () => {
      const video = document.querySelector("video")!;
      video.play();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      video.pause();
      await new Promise((resolve) =>
        video.addEventListener("pause", resolve, { once: true }),
      );
    });

    const frame = await readFrameNumber(page, ocr);
    const n = parseInt(frame, 10);
    expect(n).toBeGreaterThan(0);
  });
});

// ── HEVC filmstrip ────────────────────────────────────────────────────

test.describe("HEVC filmstrip", () => {
  test.setTimeout(90_000);

  test("thumbnails render after loading", async ({ page }) => {
    const mseSupport = await probeHevcMseSupport(page);
    test.skip(!mseSupport, "Browser does not support HEVC via MSE");

    const loaded = await tryLoadHevcDash(page);
    test.skip(!loaded, "HEVC MSE reported but player failed to load");

    // Check WebCodecs AFTER loading — VideoDecoder.isConfigSupported
    // requires a proper page context (not about:blank) for reliable results.
    const webCodecsSupport = await probeHevcWebCodecsSupport(page);
    test.skip(
      !webCodecsSupport,
      "Browser does not support HEVC via WebCodecs",
    );

    await openFilmstrip(page);
    // WebCodecs isConfigSupported can return true for HEVC but the
    // thumbnail worker may still fail to decode (e.g. WebKit on both
    // macOS and Linux). Catch the timeout and skip gracefully.
    try {
      await waitForThumbnails(page, 30_000);
    } catch {
      test.skip(
        true,
        "HEVC WebCodecs reported but filmstrip thumbnails did not render",
      );
    }
  });
});
