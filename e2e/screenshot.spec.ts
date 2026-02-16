import { test, expect } from "@playwright/test";
import { isDashFixtureAvailable, loadPlayerWithDash } from "./helpers";

const osName = (): string => {
  switch (process.platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
};

test.skip(
  !isDashFixtureAvailable(),
  "DASH fixture not generated — run: bash e2e/generate-dash-fixture.sh",
);

test("capture player screenshot", async ({ page, browserName }) => {
  await loadPlayerWithDash(page);

  // Hide dev-only debug panel so it doesn't appear in the screenshot
  await page.evaluate(() => {
    document.querySelector<HTMLElement>(".vp-debug-panel")?.style.setProperty("display", "none");
  });

  // Open filmstrip panel via context menu
  const videoArea = page.locator(".vp-video-area");
  await videoArea.click({ button: "right" });
  await page.locator(".vp-context-menu-item", { hasText: "Filmstrip timeline" }).click();
  await page.locator(".vp-filmstrip-panel").waitFor({ state: "visible", timeout: 5_000 });

  // On Chromium-based browsers, wait for thumbnails to render.
  // WebKit/Firefox have VideoDecoder API but don't reliably decode H.264
  // in Playwright's engine — the panel still shows (empty canvas or fallback).
  if (browserName === "chromium") {
    await expect(async () => {
      const bright = await page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>(".vp-filmstrip-panel canvas");
        if (!canvas) throw new Error("no canvas");
        const dpr = window.devicePixelRatio || 1;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("no 2d context");
        const y = Math.round(35 * dpr);
        const data = ctx.getImageData(0, y, canvas.width, 2).data;
        let count = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] > 80 || data[i + 1] > 80 || data[i + 2] > 80) count++;
        }
        return count / (canvas.width * 2);
      });
      expect(bright).toBeGreaterThan(0.05);
    }).toPass({ timeout: 30_000 });
  }

  // Hover over the player to ensure controls are visible (resets the 3s auto-hide timer)
  const player = page.locator(".vp-container");
  await player.hover();
  await page.locator(".vp-controls-wrapper:not(.vp-hidden)").waitFor({ state: "visible" });

  const browser = test.info().project.name;
  const os = osName();
  await player.screenshot({ path: `e2e/screenshots/${browser}-${os}.png` });
});
