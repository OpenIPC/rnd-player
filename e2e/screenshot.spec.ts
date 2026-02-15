import { test } from "@playwright/test";
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

test("capture player screenshot", async ({ page }) => {
  await loadPlayerWithDash(page);

  // Hide dev-only debug panel so it doesn't appear in the screenshot
  await page.evaluate(() => {
    document.querySelector<HTMLElement>(".vp-debug-panel")?.style.setProperty("display", "none");
  });

  // Hover over the player to ensure controls are visible (resets the 3s auto-hide timer)
  const player = page.locator(".vp-container");
  await player.hover();
  await page.locator(".vp-controls-wrapper:not(.vp-hidden)").waitFor({ state: "visible" });

  const browser = test.info().project.name;
  const os = osName();
  await player.screenshot({ path: `e2e/screenshots/${browser}-${os}.png` });
});
