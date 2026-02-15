import { test } from "@playwright/test";
import { loadPlayerWithFixture } from "./helpers";

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

test("capture player screenshot", async ({ page }) => {
  await loadPlayerWithFixture(page);
  const browser = test.info().project.name;
  const os = osName();
  await page.screenshot({ path: `e2e/screenshots/${browser}-${os}.png` });
});
