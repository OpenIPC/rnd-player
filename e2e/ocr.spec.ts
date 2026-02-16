import { test, expect } from "@playwright/test";
import { createWorker, PSM } from "tesseract.js";
import { isDashFixtureAvailable, loadPlayerWithDash } from "./helpers";

test.skip(
  !isDashFixtureAvailable(),
  "DASH fixture not generated — run: bash e2e/generate-dash-fixture.sh",
);

// Share a single Tesseract worker across all tests in this file.
let ocr: Awaited<ReturnType<typeof createWorker>>;

test.beforeAll(async () => {
  ocr = await createWorker("eng");
  await ocr.setParameters({
    tessedit_char_whitelist: "0123456789",
    tessedit_pageseg_mode: PSM.SINGLE_WORD,
  });
});

test.afterAll(async () => {
  await ocr?.terminate();
});

async function readFrameNumber(
  page: import("@playwright/test").Page,
): Promise<string> {
  const video = page.locator("video");
  const box = await video.boundingBox();
  if (!box) throw new Error("video element not visible");

  // Crop to the center 30×15% of the video where the frame counter is drawn.
  const cropW = box.width * 0.3;
  const cropH = box.height * 0.15;
  const screenshot = await page.screenshot({
    clip: {
      x: box.x + (box.width - cropW) / 2,
      y: box.y + (box.height - cropH) / 2,
      width: cropW,
      height: cropH,
    },
  });

  const {
    data: { text },
  } = await ocr.recognize(screenshot);
  return text.trim();
}

// Frame counter runs at 30 fps, formatted as 4-digit zero-padded.
// Keyframes every 30 frames (1 s). Seek to integer seconds for reliability.
const cases: [number, string][] = [
  [0, "0000"],
  [5, "0150"],
];

for (const [seekTime, expectedFrame] of cases) {
  test(`displays frame ${expectedFrame} at t=${seekTime}s`, async ({
    page,
  }) => {
    await loadPlayerWithDash(page);

    // Seek (even t=0 needs an explicit seek to guarantee the frame is painted)
    await page.evaluate(async (t: number) => {
      const video = document.querySelector("video")!;
      const seeked = new Promise((resolve) =>
        video.addEventListener("seeked", resolve, { once: true }),
      );
      video.currentTime = t;
      await seeked;
    }, seekTime);

    const frameNumber = await readFrameNumber(page);
    expect(frameNumber).toBe(expectedFrame);
  });
}
