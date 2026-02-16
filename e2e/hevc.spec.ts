import { test, expect } from "@playwright/test";
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
  test.beforeEach(async ({ page }) => {
    const supported = await probeHevcMseSupport(page);
    test.skip(!supported, "Browser does not support HEVC via MSE");
  });

  for (const [seekTime, expectedFrame] of [
    [0, "0000"],
    [5, "0150"],
  ] as const) {
    test(`displays frame ${expectedFrame} at t=${seekTime}s`, async ({
      page,
    }) => {
      await loadPlayerWithHevcDash(page);
      await seekTo(page, seekTime);
      expect(await readFrameNumber(page, ocr)).toBe(expectedFrame);
    });
  }

  test("ArrowRight steps forward one frame", async ({ page }) => {
    await loadPlayerWithHevcDash(page);
    await seekTo(page, 0);
    await pressKeyAndSettle(page, "ArrowRight");
    expect(await readFrameNumber(page, ocr)).toBe("0001");
  });

  test("playing advances frames", async ({ page }) => {
    await loadPlayerWithHevcDash(page);
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
  test("thumbnails render after loading", async ({ page }) => {
    const webCodecsSupport = await probeHevcWebCodecsSupport(page);
    test.skip(
      !webCodecsSupport,
      "Browser does not support HEVC via WebCodecs",
    );

    const mseSupport = await probeHevcMseSupport(page);
    test.skip(!mseSupport, "Browser does not support HEVC via MSE");

    await loadPlayerWithHevcDash(page);
    await openFilmstrip(page);
    await waitForThumbnails(page);
  });
});
