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

  // Wait for filmstrip thumbnails to render. Chromium/Edge decode H.264
  // reliably via WebCodecs — require thumbnails there. Firefox and WebKit
  // in Playwright's engine may or may not decode H.264 (the API exists but
  // codec support is inconsistent), so give them time but don't fail.
  const thumbnailCheck = expect(async () => {
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
  });
  if (browserName === "chromium") {
    await thumbnailCheck.toPass({ timeout: 30_000 });
  } else {
    // Best-effort: wait up to 15s for thumbnails on Firefox/WebKit.
    // Some engines (e.g. WebKit on Linux) partially decode thumbnails
    // given enough time. If decoding doesn't work, take the screenshot as-is.
    await thumbnailCheck.toPass({ timeout: 15_000 }).catch(() => {});
  }

  // Hover over the player to ensure controls are visible (resets the 3s auto-hide timer)
  const player = page.locator(".vp-container");
  await player.hover();
  await page.locator(".vp-controls-wrapper:not(.vp-hidden)").waitFor({ state: "visible" });

  const browser = test.info().project.name;
  const os = osName();
  await player.screenshot({ path: `e2e/screenshots/${browser}-${os}.png` });
});
