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

  test("ten consecutive ArrowRight steps reach frame 10", async ({ page }) => {
    await loadPlayerWithDash(page);
    await seekTo(page, 0);
    for (let i = 0; i < 10; i++) {
      await pressKeyAndSettle(page, "ArrowRight");
    }
    expect(await readFrameNumber(page)).toBe("0010");
  });

  test("ArrowRight from mid-frame time advances correctly", async ({
    page,
  }) => {
    await loadPlayerWithDash(page);
    // 0.5s at 30fps = frame 15, mid-frame lands between 15 and 16
    // ArrowRight should advance to the next frame: 16
    await seekTo(page, 0.5);
    await pressKeyAndSettle(page, "ArrowRight");
    expect(await readFrameNumber(page)).toBe("0016");
  });

  test("ArrowLeft from mid-frame time retreats correctly", async ({
    page,
  }) => {
    await loadPlayerWithDash(page);
    // 5.5s at 30fps = frame 165, mid-frame lands between 165 and 166
    // ArrowLeft should retreat to the previous frame: 164
    await seekTo(page, 5.5);
    await pressKeyAndSettle(page, "ArrowLeft");
    expect(await readFrameNumber(page)).toBe("0164");
  });

  test("forward then backward returns to original frame", async ({ page }) => {
    await loadPlayerWithDash(page);
    // 10s × 30fps = frame 300
    await seekTo(page, 10);
    for (let i = 0; i < 5; i++) {
      await pressKeyAndSettle(page, "ArrowRight");
    }
    for (let i = 0; i < 5; i++) {
      await pressKeyAndSettle(page, "ArrowLeft");
    }
    expect(await readFrameNumber(page)).toBe("0300");
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

// ── Filmstrip click synchronization ──────────────────────────────────

test.describe("filmstrip click sync", () => {
  test.skip(
    ({ browserName }) => browserName === "firefox" || browserName === "webkit",
    "Requires functional VideoDecoder (Chromium-based only)",
  );

  /**
   * Open the filmstrip panel via the right-click context menu.
   * Same approach as filmstrip.spec.ts.
   */
  async function openFilmstrip(page: Page) {
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
   * Wait until the filmstrip canvas shows real thumbnail content.
   */
  async function waitForThumbnails(page: Page, timeout = 30_000) {
    await expect(async () => {
      const bright = await page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>(
          ".vp-filmstrip-panel canvas",
        );
        if (!canvas) throw new Error("no canvas");

        const dpr = window.devicePixelRatio || 1;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("no 2d context");

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
      expect(bright).toBeGreaterThan(0.05);
    }).toPass({ timeout });
  }

  /**
   * Click on the filmstrip canvas at a horizontal fraction, wait for the
   * video to seek, then OCR the frame number and verify it matches.
   */
  async function clickFilmstripAndVerify(
    page: Page,
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

    // Wait for seek to settle
    await page.evaluate(async () => {
      const video = document.querySelector("video")!;
      while (video.seeking) {
        await new Promise((r) => setTimeout(r, 16));
      }
      await new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r)),
      );
    });

    const frame = await readFrameNumber(page);
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

    const frame = await readFrameNumber(page);
    const n = parseInt(frame, 10);
    // Should have advanced past frame 0 — at 30 fps, expect roughly 20–40
    expect(n).toBeGreaterThan(0);
  });
});
