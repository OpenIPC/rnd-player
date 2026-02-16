import { existsSync, readFileSync, readdirSync } from "fs";
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

/**
 * Whether the current platform lacks reliable H.264 WebCodecs decoding for
 * the given browser. On macOS, both Firefox (VideoToolbox) and WebKit
 * (native frameworks) decode H.264 via WebCodecs. On Linux, Playwright's
 * Firefox and WebKit builds cannot reliably decode H.264 through WebCodecs.
 */
export function lacksWebCodecsH264(browserName: string): boolean {
  if (browserName === "chromium") return false;
  // macOS: VideoToolbox provides H.264 for Firefox; native frameworks for WebKit
  if (process.platform === "darwin") return false;
  // Linux Firefox / Linux WebKit: WebCodecs H.264 decoding is unreliable
  return browserName === "firefox" || browserName === "webkit";
}

// --- DASH fixture support ---

const dashFixtureDir = process.env.DASH_FIXTURE_DIR ?? "";

export function isDashFixtureAvailable(): boolean {
  if (!dashFixtureDir) return false;
  return existsSync(join(dashFixtureDir, "manifest.mpd"));
}

const dashFiles = new Map<string, Buffer>();

if (isDashFixtureAvailable()) {
  const files = readdirSync(dashFixtureDir);
  for (const file of files) {
    dashFiles.set(file, readFileSync(join(dashFixtureDir, file)));
  }
}

function contentTypeFor(filename: string): string {
  if (filename.endsWith(".mpd")) return "application/dash+xml";
  if (filename.endsWith(".mp4") || filename.endsWith(".m4s"))
    return "video/mp4";
  return "application/octet-stream";
}

/**
 * Intercepts /dash/* requests, serves DASH fixture files from memory.
 * Navigates to the player with the DASH manifest, waits for controls,
 * then pauses and seeks to time 0 so frame "0000" is displayed.
 */
export async function loadPlayerWithDash(page: Page) {
  await page.route(
    (url) => url.pathname.startsWith("/dash/"),
    (route) => {
      const filename = route.request().url().split("/dash/").pop() ?? "";
      const body = dashFiles.get(filename);
      if (body) {
        route.fulfill({
          status: 200,
          contentType: contentTypeFor(filename),
          body,
        });
      } else {
        route.fulfill({ status: 404 });
      }
    },
  );

  await page.goto("/?v=/dash/manifest.mpd");
  await page.locator(".vp-controls-wrapper").waitFor({
    state: "visible",
    timeout: 30_000,
  });

  // Pause and seek to time 0 to ensure frame "0000" is rendered
  await page.evaluate(async () => {
    const video = document.querySelector("video")!;
    video.pause();
    if (video.currentTime !== 0) {
      const seeked = new Promise((resolve) =>
        video.addEventListener("seeked", resolve, { once: true }),
      );
      video.currentTime = 0;
      await seeked;
    }
  });
}
