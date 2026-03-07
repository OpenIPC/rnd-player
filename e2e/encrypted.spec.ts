import { test, expect } from "@playwright/test";
import { createWorker, PSM } from "tesseract.js";
import {
  isEncryptedDashFixtureAvailable,
  loadPlayerWithEncryptedDash,
  readFrameNumber,
  seekTo,
  pressKeyAndSettle,
  openFilmstrip,
  waitForThumbnails,
} from "./helpers";

test.skip(
  !isEncryptedDashFixtureAvailable(),
  "Encrypted DASH fixture not generated — requires Shaka Packager",
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

// ── Encrypted seek verification ──────────────────────────────────────

test.describe("encrypted seek verification", () => {
  for (const [seekTime, expectedFrame] of [
    [0, "0000"],
    [5, "0150"],
  ] as const) {
    test(`displays frame ${expectedFrame} at t=${seekTime}s`, async ({
      page,
    }) => {
      await loadPlayerWithEncryptedDash(page);
      await seekTo(page, seekTime);
      expect(await readFrameNumber(page, ocr)).toBe(expectedFrame);
    });
  }
});

// ── Encrypted frame stepping ─────────────────────────────────────────

test.describe("encrypted frame stepping", () => {
  test("ArrowRight steps forward one frame", async ({ page }) => {
    await loadPlayerWithEncryptedDash(page);
    await seekTo(page, 0);
    await pressKeyAndSettle(page, "ArrowRight");
    expect(await readFrameNumber(page, ocr)).toBe("0001");
  });
});

// ── Encrypted continuous playback ────────────────────────────────────

test.describe("encrypted continuous playback", () => {
  test("plays across segment boundary without errors", async ({ page }) => {
    await loadPlayerWithEncryptedDash(page);
    // Play for ~3.5s to cross at least one 2s segment boundary
    await page.evaluate(async () => {
      const video = document.querySelector("video")!;
      video.currentTime = 0;
      video.play();
      await new Promise((r) => setTimeout(r, 3500));
      video.pause();
      // Double rAF to ensure the decoded frame is composited
      await new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r)),
      );
    });
    const frame = await readFrameNumber(page, ocr);
    const frameNum = parseInt(frame, 10);
    // At 30fps, ~3.5s of playback should produce frame >= 60
    // (allowing for startup latency, buffering, etc.)
    expect(frameNum).toBeGreaterThanOrEqual(60);
  });
});

// ── Encrypted filmstrip ──────────────────────────────────────────────

test.describe("encrypted filmstrip", () => {
  test("thumbnails render after loading", async ({ page }) => {
    await loadPlayerWithEncryptedDash(page);
    await openFilmstrip(page);
    await waitForThumbnails(page);
  });
});
