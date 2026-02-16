import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { isDashFixtureAvailable, loadPlayerWithDash } from "./helpers";

test.skip(
  !isDashFixtureAvailable(),
  "DASH fixture not generated — run: bash e2e/generate-dash-fixture.sh",
);

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Open the filmstrip panel via the right-click context menu.
 */
async function openFilmstrip(page: Page) {
  // Hide debug panel (DEV-only) that can overlap the context menu
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

      // Sample a horizontal strip in the thumbnail row midpoint.
      // Ruler is 22px top, so thumbnails start around y=22.
      // Sample at ~35px below top, scaled by DPR.
      const y = Math.round(35 * dpr);
      const w = canvas.width;
      const stripH = 2;
      if (y + stripH > canvas.height) throw new Error("canvas too small");

      const data = ctx.getImageData(0, y, w, stripH).data;
      let brightCount = 0;
      const totalPixels = (w * stripH);
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
 * Press a key N times, then wait for a double-rAF paint settle.
 */
async function pressKeyRepeatedly(page: Page, key: string, count: number) {
  for (let i = 0; i < count; i++) {
    await page.keyboard.press(key);
  }
  // Double rAF to ensure repaint
  await page.evaluate(
    () =>
      new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r)),
      ),
  );
}

/**
 * Check if bright pixels exist at a horizontal fraction (0..1) of the
 * filmstrip canvas thumbnail row.
 */
async function hasBrightPixelsInRegion(
  page: Page,
  xFraction: number,
): Promise<boolean> {
  return page.evaluate((frac) => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      ".vp-filmstrip-panel canvas",
    );
    if (!canvas) return false;

    const dpr = window.devicePixelRatio || 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return false;

    const y = Math.round(35 * dpr);
    const sampleW = Math.max(1, Math.round(canvas.width * 0.05));
    const x = Math.round(frac * canvas.width - sampleW / 2);
    const clampedX = Math.max(0, Math.min(canvas.width - sampleW, x));

    if (y + 2 > canvas.height) return false;
    const data = ctx.getImageData(clampedX, y, sampleW, 2).data;

    let bright = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 80 || data[i + 1] > 80 || data[i + 2] > 80) {
        bright++;
      }
    }
    return bright / (sampleW * 2) > 0.05;
  }, xFraction);
}

/**
 * Scan the filmstrip canvas for blue P-frame border pixels.
 * Blue borders (rgba(60,130,255,0.8)) only appear in gap (per-frame) mode.
 * After alpha compositing on dark background: B > 180, R < 100.
 */
async function hasColoredFrameBorders(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      ".vp-filmstrip-panel canvas",
    );
    if (!canvas) return false;

    const dpr = window.devicePixelRatio || 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return false;

    // Scan the thumbnail area (below ruler, above bitrate graph)
    const yStart = Math.round(22 * dpr);
    const yEnd = Math.min(canvas.height, Math.round(120 * dpr));
    if (yStart >= yEnd) return false;

    const data = ctx.getImageData(0, yStart, canvas.width, yEnd - yStart).data;
    let blueCount = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], b = data[i + 2];
      // Blue P-frame border: high blue, low red
      if (b > 180 && r < 100) {
        blueCount++;
      }
    }
    // Need at least a few blue pixels to confirm gap mode
    return blueCount > 10;
  });
}

// ── Toggle tests ─────────────────────────────────────────────────────

test.describe("filmstrip panel", () => {
  test.describe("toggle", () => {
    test.skip(
      ({ browserName }) => browserName === "firefox",
      "Firefox lacks WebCodecs",
    );

    test("opens via context menu", async ({ page }) => {
      await loadPlayerWithDash(page);
      await openFilmstrip(page);
      await expect(page.locator(".vp-filmstrip-panel")).toBeVisible();
      await expect(
        page.locator(".vp-filmstrip-panel canvas"),
      ).toBeAttached();
    });

    test("closes via context menu", async ({ page }) => {
      await loadPlayerWithDash(page);
      await openFilmstrip(page);

      // Re-open context menu — should now say "Hide filmstrip"
      await page.locator(".vp-video-area").click({ button: "right" });
      await page
        .locator(".vp-context-menu-item", { hasText: "Hide filmstrip" })
        .click();

      await expect(page.locator(".vp-filmstrip-panel")).toBeHidden();
    });

    test("closes via close button", async ({ page }) => {
      await loadPlayerWithDash(page);
      await openFilmstrip(page);

      await page.locator(".vp-filmstrip-close").click();
      await expect(page.locator(".vp-filmstrip-panel")).toBeHidden();
    });
  });

  // ── Thumbnail loading ────────────────────────────────────────────

  test.describe("thumbnail loading", () => {
    test.skip(
      ({ browserName }) => browserName === "firefox" || browserName === "webkit",
      "Requires functional VideoDecoder (Chromium-based only)",
    );

    test("thumbnails render after loading", async ({ page }) => {
      await loadPlayerWithDash(page);
      await openFilmstrip(page);
      await waitForThumbnails(page);
    });
  });

  // ── Zoom ─────────────────────────────────────────────────────────

  test.describe("zoom", () => {
    test.skip(
      ({ browserName }) => browserName === "firefox" || browserName === "webkit",
      "Requires functional VideoDecoder (Chromium-based only)",
    );

    test("zoom in with = key", async ({ page }) => {
      await loadPlayerWithDash(page);
      await openFilmstrip(page);
      await waitForThumbnails(page);

      const canvas = page.locator(".vp-filmstrip-panel canvas");
      const s1 = await canvas.screenshot();

      await pressKeyRepeatedly(page, "=", 15);
      const s2 = await canvas.screenshot();

      expect(s1.equals(s2)).toBe(false);
    });

    test("zoom out with - key", async ({ page }) => {
      await loadPlayerWithDash(page);
      await openFilmstrip(page);
      await waitForThumbnails(page);

      // First zoom in so there's room to zoom out
      await pressKeyRepeatedly(page, "=", 20);
      const s1 = await page.locator(".vp-filmstrip-panel canvas").screenshot();

      await pressKeyRepeatedly(page, "-", 15);
      const s2 = await page.locator(".vp-filmstrip-panel canvas").screenshot();

      expect(s1.equals(s2)).toBe(false);
    });

    test("max zoom-out shows full timeline", async ({ page }) => {
      await loadPlayerWithDash(page);
      await openFilmstrip(page);
      await waitForThumbnails(page);

      // Zoom in first, then fully out
      await pressKeyRepeatedly(page, "=", 25);
      await pressKeyRepeatedly(page, "-", 60);

      // At max zoom-out the entire 60s timeline fits in the viewport,
      // so the right edge (x=0.85) should contain thumbnail content
      await expect(async () => {
        const hasBright = await hasBrightPixelsInRegion(page, 0.85);
        expect(hasBright).toBe(true);
      }).toPass({ timeout: 10_000 });
    });

    test("max zoom-in shows per-frame view", async ({ page }) => {
      await loadPlayerWithDash(page);
      await openFilmstrip(page);
      await waitForThumbnails(page);

      // Zoom in to per-frame level
      await pressKeyRepeatedly(page, "=", 50);

      // Poll for blue P-frame borders that only appear in gap mode
      await expect(async () => {
        const hasBlue = await hasColoredFrameBorders(page);
        expect(hasBlue).toBe(true);
      }).toPass({ timeout: 15_000 });
    });
  });

});
