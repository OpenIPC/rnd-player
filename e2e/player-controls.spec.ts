import { test, expect } from "@playwright/test";
import { loadPlayerWithFixture } from "./helpers";

test.describe("Player controls", () => {
  test.beforeEach(async ({ page, browserName }) => {
    await loadPlayerWithFixture(page, browserName);
  });

  test("controls overlay renders", async ({ page }) => {
    await expect(page.locator(".vp-controls-wrapper")).toBeVisible();
    await expect(page.locator(".vp-btn-play")).toBeVisible();
  });

  test("play button toggles playback", async ({ page }) => {
    // Ensure video is paused first
    await page.evaluate(() => {
      const v = document.querySelector("video")!;
      v.pause();
    });

    const playBtn = page.locator(".vp-btn-play");
    await playBtn.click();
    const playingAfterClick = await page.evaluate(() => !document.querySelector("video")!.paused);
    expect(playingAfterClick).toBe(true);

    await playBtn.click();
    const pausedAfterClick = await page.evaluate(() => document.querySelector("video")!.paused);
    expect(pausedAfterClick).toBe(true);
  });

  test("timecode displays time", async ({ page }) => {
    const timecode = page.locator(".vp-timecode");
    await expect(timecode).toBeVisible();
    await expect(timecode).toContainText("/");
  });

  test("speed selector", async ({ page }) => {
    // Hide debug panel (DEV-only) that can overlap the popup
    await page.evaluate(() => {
      document.querySelector<HTMLElement>(".vp-debug-panel")?.style.setProperty("display", "none");
    });

    // Find the speed button — it has a label showing "1x"
    const speedLabel = page.locator(".vp-popup-anchor .vp-btn-label", { hasText: "1x" });
    await expect(speedLabel).toBeVisible();

    // Click the speed button to open the popup
    await speedLabel.click();

    const popup = page.locator(".vp-popup", { has: page.locator(".vp-popup-header", { hasText: "Speed" }) });
    await expect(popup).toBeVisible();

    // Select 2x speed
    await popup.locator(".vp-popup-item", { hasText: "2x" }).click();

    // Label should now show 2x
    await expect(page.locator(".vp-popup-anchor .vp-btn-label", { hasText: "2x" })).toBeVisible();

    // Video playbackRate should be 2
    const rate = await page.evaluate(() => document.querySelector("video")!.playbackRate);
    expect(rate).toBe(2);
  });

  test("volume mute toggle", async ({ page }) => {
    const muteBtn = page.locator(".vp-volume-group .vp-btn");
    await expect(muteBtn).toBeVisible();

    // Get initial muted state
    const initialMuted = await page.evaluate(() => document.querySelector("video")!.muted);

    await muteBtn.click();
    const afterFirstClick = await page.evaluate(() => document.querySelector("video")!.muted);
    expect(afterFirstClick).toBe(!initialMuted);

    await muteBtn.click();
    const afterSecondClick = await page.evaluate(() => document.querySelector("video")!.muted);
    expect(afterSecondClick).toBe(initialMuted);
  });

  test("volume slider", async ({ page }) => {
    const slider = page.locator(".vp-volume-slider");
    await expect(slider).toBeVisible();

    await slider.fill("0.5");
    const volume = await page.evaluate(() => document.querySelector("video")!.volume);
    expect(volume).toBeCloseTo(0.5, 1);
  });

  test("seek bar present", async ({ page }) => {
    const seekBar = page.locator(".vp-progress-input");
    await expect(seekBar).toBeVisible();
    await expect(seekBar).toHaveAttribute("type", "range");

    const max = await seekBar.getAttribute("max");
    expect(Number(max)).toBeGreaterThan(0);
  });

  test("right-click context menu", async ({ page }) => {
    const videoArea = page.locator(".vp-video-area");
    await videoArea.click({ button: "right" });

    const menu = page.locator(".vp-context-menu");
    await expect(menu).toBeVisible();

    const items = menu.locator(".vp-context-menu-item");
    await expect(items.filter({ hasText: "Copy video URL" }).first()).toBeVisible();
    await expect(items.filter({ hasText: "Stats for nerds" })).toBeVisible();
    await expect(items.filter({ hasText: "Set in-point" })).toBeVisible();
    await expect(items.filter({ hasText: "Set out-point" })).toBeVisible();
  });

  test("context menu closes on outside click", async ({ page }) => {
    const videoArea = page.locator(".vp-video-area");
    await videoArea.click({ button: "right" });
    await expect(page.locator(".vp-context-menu")).toBeVisible();

    // Click elsewhere to dismiss
    await page.locator(".vp-controls-wrapper").click({ position: { x: 10, y: 10 } });
    await expect(page.locator(".vp-context-menu")).toBeHidden();
  });

  test("stats panel toggle", async ({ page }) => {
    // Open context menu and click "Stats for nerds"
    await page.locator(".vp-video-area").click({ button: "right" });
    await page.locator(".vp-context-menu-item", { hasText: "Stats for nerds" }).click();
    await expect(page.locator(".vp-stats-panel")).toBeVisible();

    // Open context menu again — should now say "Hide stats for nerds"
    await page.locator(".vp-video-area").click({ button: "right" });
    await page.locator(".vp-context-menu-item", { hasText: "Hide stats for nerds" }).click();
    await expect(page.locator(".vp-stats-panel")).toBeHidden();
  });

  test("keyboard Space toggles playback", async ({ page }) => {
    // Ensure paused
    await page.evaluate(() => document.querySelector("video")!.pause());

    await page.keyboard.press("Space");
    const playing = await page.evaluate(() => !document.querySelector("video")!.paused);
    expect(playing).toBe(true);

    await page.keyboard.press("Space");
    const paused = await page.evaluate(() => document.querySelector("video")!.paused);
    expect(paused).toBe(true);
  });

  test("keyboard M toggles mute", async ({ page }) => {
    const initialMuted = await page.evaluate(() => document.querySelector("video")!.muted);

    await page.keyboard.press("m");
    const afterM = await page.evaluate(() => document.querySelector("video")!.muted);
    expect(afterM).toBe(!initialMuted);

    await page.keyboard.press("m");
    const afterM2 = await page.evaluate(() => document.querySelector("video")!.muted);
    expect(afterM2).toBe(initialMuted);
  });

  test("auto-hide controls", async ({ page }) => {
    // Loop the video so it stays playing through the 3s hide timer
    await page.evaluate(() => {
      const v = document.querySelector("video")!;
      v.loop = true;
      v.play();
    });

    // Move mouse away
    await page.mouse.move(0, 0);

    // Wait for auto-hide (HIDE_DELAY = 3000ms + buffer)
    // vp-hidden uses opacity:0, so check class presence instead of visibility
    await expect(page.locator(".vp-controls-wrapper")).toHaveClass(/vp-hidden/, { timeout: 5_000 });

    // Move mouse back over the player to reveal controls
    const container = page.locator(".vp-container");
    const box = await container.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    }
    await expect(page.locator(".vp-controls-wrapper")).not.toHaveClass(/vp-hidden/, { timeout: 3_000 });
  });
});
