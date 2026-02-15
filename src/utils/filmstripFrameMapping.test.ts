/**
 * Comprehensive diagnostic test for filmstrip save-frame mapping.
 *
 * Simulates the full pipeline at every zoom level and reports mismatches
 * between the frame DISPLAYED in the filmstrip and the frame that would
 * be SAVED by the worker.
 *
 * Run with:
 *   npx vitest run src/utils/filmstripFrameMapping.test.ts
 */

import { describe, it, expect } from "vitest";
import {
  checkAllSlots,
  checkAllSlotsCrossStream,
  snapClickTimeCurrent,
  snapClickTimeWithCts,
  computeCaptureIndices,
  type PipelineParams,
  type CrossStreamParams,
  type SlotResult,
  type CrossStreamSlotResult,
} from "./filmstripFrameMapping";

// ── Video parameters ────────────────────────────────────────────────
const FPS = 30;
const SEG_DURATION = 2; // seconds
const TOTAL_FRAMES = SEG_DURATION * FPS; // 60
const THUMB_W = 80;
const MAX_PX = FPS * THUMB_W; // 2400

function summarize(
  label: string,
  results: SlotResult[],
  verbose: boolean,
): { mismatches: number; total: number } {
  const mismatches = results.filter((r) => !r.match);
  if (mismatches.length === 0) {
    if (verbose) console.log(`  ${label}: all ${results.length} slots ✓`);
  } else {
    console.log(
      `  ${label}: ${mismatches.length}/${results.length} MISMATCHES:`,
    );
    for (const m of mismatches.slice(0, 10)) {
      console.log(
        `    slot ${m.slotJ}: displayed=frame${m.displayedFrame} ` +
          `saved=frame${m.savedFrame} (raw would save frame${m.rawSavedFrame}) ` +
          `click=${m.clickTime.toFixed(4)} snap=${m.snappedTime.toFixed(4)}`,
      );
    }
    if (mismatches.length > 10) {
      console.log(`    ... and ${mismatches.length - 10} more`);
    }
  }
  return { mismatches: mismatches.length, total: results.length };
}

// ── Zoom levels to test ─────────────────────────────────────────────
// Covers packed mode, transition zone, and gap mode up to max zoom
const PX_PER_SEC_VALUES = [
  4, 8, 16, 20, 32, 40, 50, 60, 80, 100, 120, 150, 200, 250, 300,
  400, 500, 600, 750, 1000, 1200, 1500, 2000, MAX_PX,
];

describe("Filmstrip save-frame mapping diagnostic", () => {
  // ── Test 1: Current snap logic at all zoom levels ─────────────────
  describe("Current snap logic (snapClickTimeCurrent)", () => {
    let totalMismatches = 0;
    let totalSlots = 0;

    for (const pxPerSec of PX_PER_SEC_VALUES) {
      const segWidth = SEG_DURATION * pxPerSec;
      const mode = segWidth <= THUMB_W ? "packed" : "gap";

      it(`pxPerSec=${pxPerSec} (${mode})`, () => {
        const params: PipelineParams = {
          segStart: 0,
          segEnd: SEG_DURATION,
          fps: FPS,
          totalFrames: TOTAL_FRAMES,
          pxPerSec,
          thumbW: THUMB_W,
        };

        const results = checkAllSlots(params, snapClickTimeCurrent);
        const { mismatches, total } = summarize(
          `pxPerSec=${pxPerSec}`,
          results,
          true,
        );
        totalMismatches += mismatches;
        totalSlots += total;

        // Don't fail — this is diagnostic
      });
    }

    it("SUMMARY", () => {
      console.log(
        `\n=== CURRENT SNAP: ${totalMismatches} mismatches out of ${totalSlots} total slots ===\n`,
      );
      if (totalMismatches > 0) {
        console.log("⚠️  Current snap logic has mismatches!\n");
      }
    });
  });

  // ── Test 2: Improved snap with exact CTS ──────────────────────────
  describe("Improved snap logic (snapClickTimeWithCts)", () => {
    let totalMismatches = 0;
    let totalSlots = 0;

    for (const pxPerSec of PX_PER_SEC_VALUES) {
      const segWidth = SEG_DURATION * pxPerSec;
      const mode = segWidth <= THUMB_W ? "packed" : "gap";

      it(`pxPerSec=${pxPerSec} (${mode})`, () => {
        const params: PipelineParams = {
          segStart: 0,
          segEnd: SEG_DURATION,
          fps: FPS,
          totalFrames: TOTAL_FRAMES,
          pxPerSec,
          thumbW: THUMB_W,
        };

        const results = checkAllSlots(params, snapClickTimeWithCts);
        const { mismatches, total } = summarize(
          `pxPerSec=${pxPerSec}`,
          results,
          true,
        );
        totalMismatches += mismatches;
        totalSlots += total;
      });
    }

    it("SUMMARY", () => {
      console.log(
        `\n=== CTS SNAP: ${totalMismatches} mismatches out of ${totalSlots} total slots ===\n`,
      );
      if (totalMismatches > 0) {
        console.log("⚠️  CTS snap logic has mismatches!\n");
      } else {
        console.log("✅  CTS snap logic: all slots match!\n");
      }
    });
  });

  // ── Test 3: No snap (old behavior) baseline ───────────────────────
  describe("No snap (raw click time — old behavior)", () => {
    let totalMismatches = 0;
    let totalSlots = 0;

    for (const pxPerSec of PX_PER_SEC_VALUES) {
      const segWidth = SEG_DURATION * pxPerSec;
      const mode = segWidth <= THUMB_W ? "packed" : "gap";

      it(`pxPerSec=${pxPerSec} (${mode})`, () => {
        const params: PipelineParams = {
          segStart: 0,
          segEnd: SEG_DURATION,
          fps: FPS,
          totalFrames: TOTAL_FRAMES,
          pxPerSec,
          thumbW: THUMB_W,
        };

        // No snap = just return the raw click time
        const results = checkAllSlots(params, (p) => p.clickTime);
        const { mismatches, total } = summarize(
          `pxPerSec=${pxPerSec}`,
          results,
          false, // less verbose since we know it's broken
        );
        totalMismatches += mismatches;
        totalSlots += total;
      });
    }

    it("SUMMARY", () => {
      console.log(
        `\n=== NO SNAP (old): ${totalMismatches} mismatches out of ${totalSlots} total slots ===\n`,
      );
    });
  });

  // ── Test 4: Non-zero segment offset ───────────────────────────────
  describe("Non-zero segment offset (segment 5 at 10s)", () => {
    const segStart = 10;
    const segEnd = 12;

    for (const pxPerSec of [100, 500, MAX_PX]) {
      it(`pxPerSec=${pxPerSec}`, () => {
        const params: PipelineParams = {
          segStart,
          segEnd,
          fps: FPS,
          totalFrames: TOTAL_FRAMES,
          pxPerSec,
          thumbW: THUMB_W,
        };

        const resultsCurrent = checkAllSlots(params, snapClickTimeCurrent);
        const resultsCts = checkAllSlots(params, snapClickTimeWithCts);

        const mc = resultsCurrent.filter((r) => !r.match).length;
        const mCts = resultsCts.filter((r) => !r.match).length;

        console.log(
          `  pxPerSec=${pxPerSec}: current=${mc} mismatches, cts=${mCts} mismatches (out of ${resultsCurrent.length})`,
        );
      });
    }
  });

  // ── Test 5: 29.97fps (1001/30000 timescale) ──────────────────────
  describe("29.97fps with 1001/30000 frame duration", () => {
    const realFps = 30000 / 1001; // 29.97002997...
    const segDur = 2.002; // 60 frames * 1001/30000
    const totalFr = 60;

    for (const pxPerSec of [100, 500, 1000, realFps * THUMB_W]) {
      it(`pxPerSec=${pxPerSec.toFixed(1)}`, () => {
        const params: PipelineParams = {
          segStart: 0,
          segEnd: segDur,
          fps: realFps,
          totalFrames: totalFr,
          pxPerSec,
          thumbW: THUMB_W,
        };

        const resultsCurrent = checkAllSlots(params, snapClickTimeCurrent);
        const resultsCts = checkAllSlots(params, snapClickTimeWithCts);

        const mc = resultsCurrent.filter((r) => !r.match).length;
        const mCts = resultsCts.filter((r) => !r.match).length;

        console.log(
          `  pxPerSec=${pxPerSec.toFixed(1)}: current=${mc} mismatches, cts=${mCts} mismatches (out of ${resultsCurrent.length})`,
        );
      });
    }
  });

  // ── Test 6: Edge clicks (left/right edges of each slot) ──────────
  describe("Edge clicks within slots", () => {
    it("pxPerSec=500 — left/center/right of each slot", () => {
      const pxPerSec = 500;
      const segStart = 0;
      const segEnd = SEG_DURATION;
      const segWidth = SEG_DURATION * pxPerSec;
      const count = Math.max(2, Math.ceil(segWidth / THUMB_W));
      const slotW = segWidth / count;
      const capturedIndices = computeCaptureIndices(count, TOTAL_FRAMES);
      const frameCts = Array.from(
        { length: TOTAL_FRAMES },
        (_, i) => i / FPS,
      );
      const intraCtsSeconds = capturedIndices.map((idx) => frameCts[idx]);

      let mismatches = 0;
      for (let j = 0; j < Math.min(count, 20); j++) {
        const displayedFrame = capturedIndices[
          Math.round((j / (count - 1)) * (capturedIndices.length - 1))
        ];

        for (const [label, frac] of [
          ["left", 0.01],
          ["center", 0.5],
          ["right", 0.99],
        ] as const) {
          const clickTime = segStart + (j + frac) * slotW / pxPerSec;

          const snapped = snapClickTimeWithCts({
            clickTime,
            segStart,
            segEnd,
            pxPerSec,
            thumbW: THUMB_W,
            fps: FPS,
            intraCount: capturedIndices.length,
            intraCtsSeconds,
          });

          const savedFrame = frameCts.reduce(
            (best, cts, idx) =>
              Math.abs(cts - snapped) < Math.abs(frameCts[best] - snapped)
                ? idx
                : best,
            0,
          );

          if (savedFrame !== displayedFrame) {
            console.log(
              `    slot ${j} ${label}: displayed=${displayedFrame} saved=${savedFrame} click=${clickTime.toFixed(4)} snap=${snapped.toFixed(4)} ❌`,
            );
            mismatches++;
          }
        }
      }

      if (mismatches === 0) {
        console.log(`  All edge clicks match ✓`);
      } else {
        console.log(`  ${mismatches} edge click mismatches`);
      }
    });
  });

  // ── Test 7: captureIndices dedup check ────────────────────────────
  describe("Capture index deduplication", () => {
    for (const [count, total] of [
      [2, 60],
      [5, 60],
      [10, 60],
      [25, 60],
      [60, 60],
      [80, 60],
      [100, 60],
      [120, 60],
    ] as const) {
      it(`count=${count}, totalFrames=${total}`, () => {
        const indices = computeCaptureIndices(count, total);
        console.log(
          `  requested=${count} total=${total} → captured=${indices.length} ` +
            `indices=[${indices.slice(0, 10).join(",")}${indices.length > 10 ? "..." : ""}]`,
        );
        expect(indices.length).toBeLessThanOrEqual(total);
        expect(indices.length).toBeGreaterThan(0);
      });
    }
  });

  // ── Test 8: Composition time offset (CTTS v0 with B-frames) ────────
  // This is the critical test: with B-frame reordering, the actual CTS
  // from mp4box is shifted by N frame durations. The snap must account
  // for this or it will produce systematic off-by-N errors.
  describe("CTTS composition delay (B-frame offset)", () => {
    for (const ctsOffset of [1, 2, 3]) {
      describe(`ctsOffset=${ctsOffset} frames`, () => {
        let currentMismatches = 0;
        let ctsMismatches = 0;
        let totalSlots = 0;

        for (const pxPerSec of [20, 100, 500, 1000, MAX_PX]) {
          it(`pxPerSec=${pxPerSec}`, () => {
            const params: PipelineParams = {
              segStart: 0,
              segEnd: SEG_DURATION,
              fps: FPS,
              totalFrames: TOTAL_FRAMES,
              pxPerSec,
              thumbW: THUMB_W,
              ctsOffsetFrames: ctsOffset,
            };

            const resultsCurrent = checkAllSlots(params, snapClickTimeCurrent);
            const resultsCts = checkAllSlots(params, snapClickTimeWithCts);

            const mc = resultsCurrent.filter((r) => !r.match).length;
            const mCts = resultsCts.filter((r) => !r.match).length;
            currentMismatches += mc;
            ctsMismatches += mCts;
            totalSlots += resultsCurrent.length;

            if (mc > 0) {
              console.log(
                `  pxPerSec=${pxPerSec}: CURRENT has ${mc} mismatches:`,
              );
              for (const m of resultsCurrent
                .filter((r) => !r.match)
                .slice(0, 5)) {
                console.log(
                  `    slot ${m.slotJ}: displayed=frame${m.displayedFrame} ` +
                    `saved=frame${m.savedFrame} snap=${m.snappedTime.toFixed(4)}`,
                );
              }
            }
            if (mCts > 0) {
              console.log(`  pxPerSec=${pxPerSec}: CTS has ${mCts} mismatches`);
            }
          });
        }

        it("SUMMARY", () => {
          console.log(
            `  ctsOffset=${ctsOffset}: current=${currentMismatches}/${totalSlots} mismatches, ` +
              `cts=${ctsMismatches}/${totalSlots} mismatches`,
          );
          if (currentMismatches > 0 && ctsMismatches === 0) {
            console.log(
              `  ✅ CTS snap fixes ALL mismatches from composition delay!`,
            );
          }
        });
      });
    }
  });

  // ── Test 9: Final assertion — CTS snap must have zero mismatches ─
  for (const ctsOffset of [0, 1, 2, 3]) {
    it(`CTS snap: zero mismatches (ctsOffset=${ctsOffset}, first segment)`, () => {
      let totalMismatches = 0;

      for (const pxPerSec of PX_PER_SEC_VALUES) {
        const params: PipelineParams = {
          segStart: 0,
          segEnd: SEG_DURATION,
          fps: FPS,
          totalFrames: TOTAL_FRAMES,
          pxPerSec,
          thumbW: THUMB_W,
          ctsOffsetFrames: ctsOffset,
        };
        const results = checkAllSlots(params, snapClickTimeWithCts);
        totalMismatches += results.filter((r) => !r.match).length;
      }

      expect(totalMismatches).toBe(0);
    });

    it(`CTS snap: zero mismatches (ctsOffset=${ctsOffset}, mid segment)`, () => {
      let totalMismatches = 0;

      for (const pxPerSec of PX_PER_SEC_VALUES) {
        const params: PipelineParams = {
          segStart: 10,
          segEnd: 12,
          fps: FPS,
          totalFrames: TOTAL_FRAMES,
          pxPerSec,
          thumbW: THUMB_W,
          ctsOffsetFrames: ctsOffset,
        };
        const results = checkAllSlots(params, snapClickTimeWithCts);
        totalMismatches += results.filter((r) => !r.match).length;
      }

      expect(totalMismatches).toBe(0);
    });
  }

  // ── Test 10: Cross-stream CTS mismatch ──────────────────────────────
  // This is the key test: the thumbnail stream (used for display + snap)
  // may have a different CTTS offset than the active stream (used for
  // save). For example, thumbnail 240p may have no B-frames (offset=0)
  // while the active 1080p stream has IBBP (offset=2). The CTS-based
  // snap sends a time from the thumbnail CTS space, but the worker
  // searches for it in the active CTS space → systematic off-by-N.
  describe("Cross-stream CTS mismatch (thumbnail vs active stream)", () => {
    function summarizeCrossStream(
      label: string,
      results: CrossStreamSlotResult[],
    ) {
      const ctsMismatches = results.filter((r) => !r.match);
      const posMismatches = results.filter((r) => !r.positionMatch);
      console.log(
        `  ${label}: CTS-save=${ctsMismatches.length}/${results.length} mismatches, ` +
          `position-save=${posMismatches.length}/${results.length} mismatches`,
      );
      if (ctsMismatches.length > 0) {
        for (const m of ctsMismatches.slice(0, 5)) {
          console.log(
            `    slot ${m.slotJ}: displayed=frame${m.displayedFrame} ` +
              `cts-saved=frame${m.savedFrame} pos-saved=frame${m.positionSavedFrame}`,
          );
        }
      }
      return {
        ctsMismatches: ctsMismatches.length,
        posMismatches: posMismatches.length,
        total: results.length,
      };
    }

    // Scenario: thumbnail=0 (no B-frames), active=2 (IBBP) — the user's exact case
    describe("thumb offset=0, active offset=2", () => {
      let totalCtsMismatches = 0;
      let totalPosMismatches = 0;
      let totalSlots = 0;

      for (const pxPerSec of [100, 500, 1000, MAX_PX]) {
        it(`pxPerSec=${pxPerSec}`, () => {
          const params: CrossStreamParams = {
            segStart: 0,
            segEnd: SEG_DURATION,
            fps: FPS,
            totalFrames: TOTAL_FRAMES,
            pxPerSec,
            thumbW: THUMB_W,
            thumbCtsOffset: 0,
            activeCtsOffset: 2,
          };
          const results = checkAllSlotsCrossStream(params);
          const { ctsMismatches, posMismatches, total } =
            summarizeCrossStream(`pxPerSec=${pxPerSec}`, results);
          totalCtsMismatches += ctsMismatches;
          totalPosMismatches += posMismatches;
          totalSlots += total;
        });
      }

      it("SUMMARY", () => {
        console.log(
          `\n  thumb=0, active=2: CTS-save has ${totalCtsMismatches}/${totalSlots} mismatches, ` +
            `position-save has ${totalPosMismatches}/${totalSlots} mismatches`,
        );
        if (totalCtsMismatches > 0 && totalPosMismatches === 0) {
          console.log(
            `  ✅ Position-based save fixes ALL cross-stream mismatches!`,
          );
        }
      });
    });

    // Scenario: both streams have B-frames but different offsets
    describe("thumb offset=1, active offset=3", () => {
      let totalCtsMismatches = 0;
      let totalPosMismatches = 0;
      let totalSlots = 0;

      for (const pxPerSec of [100, 500, 1000, MAX_PX]) {
        it(`pxPerSec=${pxPerSec}`, () => {
          const params: CrossStreamParams = {
            segStart: 0,
            segEnd: SEG_DURATION,
            fps: FPS,
            totalFrames: TOTAL_FRAMES,
            pxPerSec,
            thumbW: THUMB_W,
            thumbCtsOffset: 1,
            activeCtsOffset: 3,
          };
          const results = checkAllSlotsCrossStream(params);
          const { ctsMismatches, posMismatches, total } =
            summarizeCrossStream(`pxPerSec=${pxPerSec}`, results);
          totalCtsMismatches += ctsMismatches;
          totalPosMismatches += posMismatches;
          totalSlots += total;
        });
      }

      it("SUMMARY", () => {
        console.log(
          `\n  thumb=1, active=3: CTS-save has ${totalCtsMismatches}/${totalSlots} mismatches, ` +
            `position-save has ${totalPosMismatches}/${totalSlots} mismatches`,
        );
      });
    });

    // Non-zero segment start
    describe("thumb offset=0, active offset=2, segment at 10s", () => {
      for (const pxPerSec of [500, MAX_PX]) {
        it(`pxPerSec=${pxPerSec}`, () => {
          const params: CrossStreamParams = {
            segStart: 10,
            segEnd: 12,
            fps: FPS,
            totalFrames: TOTAL_FRAMES,
            pxPerSec,
            thumbW: THUMB_W,
            thumbCtsOffset: 0,
            activeCtsOffset: 2,
          };
          const results = checkAllSlotsCrossStream(params);
          summarizeCrossStream(`seg@10s pxPerSec=${pxPerSec}`, results);
        });
      }
    });
  });

  // ── Test 11: Position-based save must have zero cross-stream mismatches ─
  for (const [thumbOff, activeOff] of [[0, 0], [0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]] as const) {
    it(`Position-based save: zero mismatches (thumb=${thumbOff}, active=${activeOff})`, () => {
      let totalMismatches = 0;

      for (const pxPerSec of PX_PER_SEC_VALUES) {
        const params: CrossStreamParams = {
          segStart: 0,
          segEnd: SEG_DURATION,
          fps: FPS,
          totalFrames: TOTAL_FRAMES,
          pxPerSec,
          thumbW: THUMB_W,
          thumbCtsOffset: thumbOff,
          activeCtsOffset: activeOff,
        };
        const results = checkAllSlotsCrossStream(params);
        totalMismatches += results.filter((r) => !r.positionMatch).length;
      }

      expect(totalMismatches).toBe(0);
    });
  }
});
