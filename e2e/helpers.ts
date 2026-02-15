import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { Page } from "@playwright/test";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixturePath = join(__dirname, "fixtures", "test-video.mp4");
const videoBytes = readFileSync(fixturePath);

/**
 * Intercepts requests for the test video fixture and navigates to the player.
 * Waits until the controls overlay is visible (player fully loaded).
 */
export async function loadPlayerWithFixture(page: Page) {
  await page.route(
    (url) => url.pathname.endsWith("/test-video.mp4"),
    (route) => {
      route.fulfill({
        status: 200,
        contentType: "video/mp4",
        body: videoBytes,
      });
    },
  );

  await page.goto("/?v=/test-video.mp4");
  await page.locator(".vp-controls-wrapper").waitFor({
    state: "visible",
    timeout: 15_000,
  });
}
