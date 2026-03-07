import { test, expect } from "@playwright/test";
import { createWorker, PSM } from "tesseract.js";
import {
  isDashFixtureAvailable,
  loadPlayerWithDash,
  readFrameNumber,
  seekTo,
  pressKeyAndSettle,
  pressKeyNTimesAndSettle,
  openFilmstrip,
  waitForThumbnails,
} from "./helpers";

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
      expect(await readFrameNumber(page, ocr)).toBe(expectedFrame);
    });
  }
});

// ── Frame stepping (ArrowRight / ArrowLeft) ──────────────────────────

test.describe("frame stepping", () => {
  test("ArrowRight steps forward one frame", async ({ page }) => {
    await loadPlayerWithDash(page);
    await seekTo(page, 0);
    await pressKeyAndSettle(page, "ArrowRight");
    expect(await readFrameNumber(page, ocr)).toBe("0001");
  });

  test("ArrowLeft steps backward one frame", async ({ page }) => {
    await loadPlayerWithDash(page);
    await seekTo(page, 5);
    await pressKeyAndSettle(page, "ArrowLeft");
    expect(await readFrameNumber(page, ocr)).toBe("0149");
  });

  test("three ArrowRight steps advance by three frames", async ({ page }) => {
    await loadPlayerWithDash(page);
    await seekTo(page, 0);
    await pressKeyNTimesAndSettle(page, "ArrowRight", 3);
    expect(await readFrameNumber(page, ocr)).toBe("0003");
  });

  test("ArrowLeft at start stays at frame 0000", async ({ page }) => {
    await loadPlayerWithDash(page);
    await seekTo(page, 0);
    await pressKeyAndSettle(page, "ArrowLeft");
    expect(await readFrameNumber(page, ocr)).toBe("0000");
  });

  test("ten consecutive ArrowRight steps reach frame 10", async ({ page }) => {
    // Edge's MSE pipeline on Windows CI returns stale currentTime after
    // rapid consecutive seeks — only the first seek takes effect. This is
    // an Edge/MSE issue, not a player bug; the handler is verified by the
    // single-step and 3-step tests which pass on Edge.
    test.skip(
      test.info().project.name === "edge",
      "Edge MSE drops rapid consecutive seeks on Windows CI",
    );
    await loadPlayerWithDash(page);
    await seekTo(page, 0);
    await pressKeyNTimesAndSettle(page, "ArrowRight", 10);
    expect(await readFrameNumber(page, ocr)).toBe("0010");
  });

  test("ArrowRight from mid-frame time advances correctly", async ({
    page,
  }) => {
    await loadPlayerWithDash(page);
    // 0.5s at 30fps = frame 15, mid-frame lands between 15 and 16
    // ArrowRight should advance to the next frame: 16
    await seekTo(page, 0.5);
    await pressKeyAndSettle(page, "ArrowRight");
    expect(await readFrameNumber(page, ocr)).toBe("0016");
  });

  test("ArrowLeft from mid-frame time retreats correctly", async ({
    page,
  }) => {
    await loadPlayerWithDash(page);
    // 5.5s at 30fps = frame 165, mid-frame lands between 165 and 166
    // ArrowLeft should retreat to the previous frame: 164
    await seekTo(page, 5.5);
    await pressKeyAndSettle(page, "ArrowLeft");
    expect(await readFrameNumber(page, ocr)).toBe("0164");
  });

  test("forward then backward returns to original frame", async ({ page }) => {
    await loadPlayerWithDash(page);
    // 10s × 30fps = frame 300
    await seekTo(page, 10);
    await pressKeyNTimesAndSettle(page, "ArrowRight", 5);
    await pressKeyNTimesAndSettle(page, "ArrowLeft", 5);
    expect(await readFrameNumber(page, ocr)).toBe("0300");
  });
});

// ── Navigation keys ──────────────────────────────────────────────────

test.describe("navigation keys", () => {
  test("Home seeks to first frame", async ({ page }) => {
    await loadPlayerWithDash(page);
    await seekTo(page, 5);
    await pressKeyAndSettle(page, "Home");
    expect(await readFrameNumber(page, ocr)).toBe("0000");
  });

  test("near-end seek displays correct frame", async ({ page }) => {
    await loadPlayerWithDash(page);
    // 59 s × 30 fps = frame 1770
    await seekTo(page, 59);
    expect(await readFrameNumber(page, ocr)).toBe("1770");
  });

  test("ArrowRight steps forward near end of video", async ({ page }) => {
    await loadPlayerWithDash(page);
    await seekTo(page, 59);
    await pressKeyAndSettle(page, "ArrowRight");
    expect(await readFrameNumber(page, ocr)).toBe("1771");
  });

  test("Shift+ArrowUp jumps forward one second", async ({ page }) => {
    await loadPlayerWithDash(page);
    await seekTo(page, 0);
    await pressKeyAndSettle(page, "ArrowUp", true);
    // 1 s × 30 fps = 30 frames ahead
    expect(await readFrameNumber(page, ocr)).toBe("0030");
  });

  test("Shift+ArrowDown jumps backward one second", async ({ page }) => {
    await loadPlayerWithDash(page);
    await seekTo(page, 5);
    await pressKeyAndSettle(page, "ArrowDown", true);
    // 5 s − 1 s = 4 s × 30 fps = frame 120
    expect(await readFrameNumber(page, ocr)).toBe("0120");
  });
});

// ── Filmstrip click synchronization ──────────────────────────────────

test.describe("filmstrip click sync", () => {

  /**
   * Click on the filmstrip canvas at a horizontal fraction, wait for the
   * video to seek, then OCR the frame number and verify it matches.
   */
  async function clickFilmstripAndVerify(
    page: Parameters<typeof readFrameNumber>[0],
    xFraction: number,
    expectedFrame: number,
  ) {
    const canvas = page.locator(".vp-filmstrip-panel canvas");
    const box = await canvas.boundingBox();
    if (!box) throw new Error("filmstrip canvas not visible");

    // Click in the thumbnail row (y ≈ 35px below canvas top, below the 22px ruler)
    const x = box.x + box.width * xFraction;
    const y = box.y + 35;
    await page.mouse.click(x, y);

    // Wait for seek to settle (with timeout to avoid hanging on WebKitGTK)
    await page.evaluate(async () => {
      const video = document.querySelector("video")!;
      const deadline = Date.now() + 5000;
      while (video.seeking && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 16));
      }
      await new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r)),
      );
    });

    const frame = await readFrameNumber(page, ocr);
    const actual = parseInt(frame, 10);
    // ±1 frame tolerance for pixel→time→frame rounding
    expect(
      Math.abs(actual - expectedFrame),
      `expected frame ~${expectedFrame}, got ${actual}`,
    ).toBeLessThanOrEqual(1);
  }

  for (const [label, xFraction, expectedFrame] of [
    ["start", 0.05, 90],
    ["midpoint", 0.5, 900],
    ["near end", 0.9, 1620],
  ] as const) {
    test(`filmstrip click at ${label} seeks to frame ${expectedFrame}`, async ({
      page,
    }) => {
      await loadPlayerWithDash(page);
      await openFilmstrip(page);
      await waitForThumbnails(page);
      await clickFilmstripAndVerify(page, xFraction, expectedFrame);
    });
  }
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

    const frame = await readFrameNumber(page, ocr);
    const n = parseInt(frame, 10);
    // Should have advanced past frame 0 — at 30 fps, expect roughly 20–40
    expect(n).toBeGreaterThan(0);
  });
});
