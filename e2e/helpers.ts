import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { Page } from "@playwright/test";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixturesDir = join(__dirname, "fixtures");
const mp4Bytes = readFileSync(join(fixturesDir, "test-video.mp4"));
const webmBytes = readFileSync(join(fixturesDir, "test-video.webm"));

/**
 * Intercepts requests for the test video fixture and navigates to the player.
 * Waits until the controls overlay is visible (player fully loaded).
 *
 * Firefox on Linux CI lacks H.264 system codecs, so we serve a VP8 WebM
 * fixture for Firefox and an H.264 MP4 for Chromium/WebKit.
 */
export async function loadPlayerWithFixture(
  page: Page,
  browserName: string,
) {
  const useWebm = browserName === "firefox";
  const fileName = useWebm ? "test-video.webm" : "test-video.mp4";
  const contentType = useWebm ? "video/webm" : "video/mp4";
  const body = useWebm ? webmBytes : mp4Bytes;

  await page.route(
    (url) => url.pathname.endsWith(`/${fileName}`),
    (route) => {
      route.fulfill({ status: 200, contentType, body });
    },
  );

  await page.goto(`/?v=/${fileName}`);
  await page.locator(".vp-controls-wrapper").waitFor({
    state: "visible",
    timeout: 15_000,
  });
}
