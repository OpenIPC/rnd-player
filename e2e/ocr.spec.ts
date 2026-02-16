import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { createWorker, PSM } from "tesseract.js";
import { isDashFixtureAvailable, loadPlayerWithDash } from "./helpers";

test.skip(
  !isDashFixtureAvailable(),
  "DASH fixture not generated — run: bash e2e/generate-dash-fixture.sh",
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

async function readFrameNumber(page: Page): Promise<string> {
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
async function seekTo(page: Page, time: number) {
  await page.evaluate(async (t: number) => {
    const video = document.querySelector("video")!;
    // Shaka may do internal seeks during DASH init that override ours.
    // Retry until currentTime actually lands at the target.
    for (let attempt = 0; attempt < 10; attempt++) {
      video.currentTime = t;
      while (video.seeking) {
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
async function pressKeyAndSettle(
  page: Page,
  key: string,
  shiftKey = false,
) {
  await page.evaluate(
    async ({ key, shiftKey }) => {
      const video = document.querySelector("video")!;
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          shiftKey,
          bubbles: true,
          cancelable: true,
        }),
      );
      // Poll until any resulting seek completes
      while (video.seeking) {
        await new Promise((r) => setTimeout(r, 16));
      }
      // Double rAF to ensure the decoded frame is composited
      await new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r)),
      );
    },
    { key, shiftKey },
  );
}

// ── Seek verification ────────────────────────────────────────────────

test.describe("seek verification", () => {
  for (const [seekTime, expectedFrame] of [
    [0, "0000"],
    [5, "0150"],
  ] as const) {
    test(`displays frame ${expectedFrame} at t=${seekTime}s`, async ({
      page,
    }) => {
      await loadPlayerWithDash(page);
      await seekTo(page, seekTime);
      expect(await readFrameNumber(page)).toBe(expectedFrame);
    });
  }
});

// ── Frame stepping (ArrowRight / ArrowLeft) ──────────────────────────

test.describe("frame stepping", () => {
  test("ArrowRight steps forward one frame", async ({ page }) => {
    await loadPlayerWithDash(page);
    await seekTo(page, 0);
    await pressKeyAndSettle(page, "ArrowRight");
    expect(await readFrameNumber(page)).toBe("0001");
  });

  test("ArrowLeft steps backward one frame", async ({ page }) => {
    await loadPlayerWithDash(page);
    await seekTo(page, 5);
    await pressKeyAndSettle(page, "ArrowLeft");
    expect(await readFrameNumber(page)).toBe("0149");
  });

  test("three ArrowRight steps advance by three frames", async ({ page }) => {
    await loadPlayerWithDash(page);
    await seekTo(page, 0);
    for (let i = 0; i < 3; i++) {
      await pressKeyAndSettle(page, "ArrowRight");
    }
    expect(await readFrameNumber(page)).toBe("0003");
  });

  test("ArrowLeft at start stays at frame 0000", async ({ page }) => {
    await loadPlayerWithDash(page);
    await seekTo(page, 0);
    await pressKeyAndSettle(page, "ArrowLeft");
    expect(await readFrameNumber(page)).toBe("0000");
  });
});

// ── Navigation keys ──────────────────────────────────────────────────

test.describe("navigation keys", () => {
  test("Home seeks to first frame", async ({ page }) => {
    await loadPlayerWithDash(page);
    await seekTo(page, 5);
    await pressKeyAndSettle(page, "Home");
    expect(await readFrameNumber(page)).toBe("0000");
  });

  test("near-end seek displays correct frame", async ({ page }) => {
    await loadPlayerWithDash(page);
    // 59 s × 30 fps = frame 1770
    await seekTo(page, 59);
    expect(await readFrameNumber(page)).toBe("1770");
  });

  test("ArrowRight steps forward near end of video", async ({ page }) => {
    await loadPlayerWithDash(page);
    await seekTo(page, 59);
    await pressKeyAndSettle(page, "ArrowRight");
    expect(await readFrameNumber(page)).toBe("1771");
  });

  test("Shift+ArrowUp jumps forward one second", async ({ page }) => {
    await loadPlayerWithDash(page);
    await seekTo(page, 0);
    await pressKeyAndSettle(page, "ArrowUp", true);
    // 1 s × 30 fps = 30 frames ahead
    expect(await readFrameNumber(page)).toBe("0030");
  });

  test("Shift+ArrowDown jumps backward one second", async ({ page }) => {
    await loadPlayerWithDash(page);
    await seekTo(page, 5);
    await pressKeyAndSettle(page, "ArrowDown", true);
    // 5 s − 1 s = 4 s × 30 fps = frame 120
    expect(await readFrameNumber(page)).toBe("0120");
  });
});

// ── Playback ─────────────────────────────────────────────────────────

test.describe("playback", () => {
  test("playing advances frames", async ({ page }) => {
    await loadPlayerWithDash(page);
    await seekTo(page, 0);

    // Play for ~1 s then pause
    await page.evaluate(async () => {
      const video = document.querySelector("video")!;
      video.play();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      video.pause();
      // Wait for pause to settle
      await new Promise((resolve) =>
        video.addEventListener("pause", resolve, { once: true }),
      );
    });

    const frame = await readFrameNumber(page);
    const n = parseInt(frame, 10);
    // Should have advanced past frame 0 — at 30 fps, expect roughly 20–40
    expect(n).toBeGreaterThan(0);
  });
});
