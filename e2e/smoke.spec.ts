import { test, expect } from "@playwright/test";

test.describe("Smoke tests", () => {
  test("page title", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle("R&D Player");
  });

  test("URL input form visible", async ({ page }) => {
    await page.goto("/");
    const input = page.locator("input.url-input");
    await expect(input).toBeVisible();
    await expect(input).toHaveAttribute(
      "placeholder",
      "Enter manifest URL (.mpd, .m3u8)",
    );
    await expect(input).toHaveAttribute("type", "url");
  });

  test("Load button visible", async ({ page }) => {
    await page.goto("/");
    const button = page.locator("button.url-submit");
    await expect(button).toBeVisible();
    await expect(button).toHaveText("Load");
  });

  test("accepts URL input", async ({ page }) => {
    await page.goto("/");
    const input = page.locator("input.url-input");
    await input.fill("https://example.com/stream.mpd");
    await expect(input).toHaveValue("https://example.com/stream.mpd");
  });

  test("form submission shows player", async ({ page }) => {
    await page.goto("/");
    const input = page.locator("input.url-input");
    await input.fill("https://example.com/stream.mpd");
    await page.locator("button.url-submit").click();

    await expect(page.locator("form.url-form")).toBeHidden();
    await expect(page.locator(".vp-container")).toBeVisible();
  });

  test("query parameter bypasses form", async ({ page }) => {
    await page.goto("/?v=https://example.com/stream.mpd");
    await expect(page.locator("form.url-form")).toHaveCount(0);
    await expect(page.locator(".vp-container")).toBeVisible();
  });

  test("empty submission rejected", async ({ page }) => {
    await page.goto("/");
    await page.locator("button.url-submit").click();
    await expect(page.locator("form.url-form")).toBeVisible();
  });
});
