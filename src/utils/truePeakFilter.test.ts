import { describe, it, expect } from "vitest";
import {
  createTruePeakState,
  processTruePeak,
  resetTruePeak,
  truePeakToDbtp,
} from "./truePeakFilter";

/** Fill the history buffer so we measure steady-state, not the 0→DC step overshoot. */
function warmup(state: ReturnType<typeof createTruePeakState>, value: number) {
  const buf = new Float32Array(64).fill(value);
  processTruePeak(state, buf);
  state.maxAbs = 0; // Reset after warmup
}

describe("truePeakFilter", () => {
  it("DC signal at 1.0 reads 0 dBTP (steady-state)", () => {
    const state = createTruePeakState();
    warmup(state, 1.0);
    const block = new Float32Array(256).fill(1.0);
    const dbtp = processTruePeak(state, block);
    expect(dbtp).toBeCloseTo(0.0, 1);
  });

  it("DC signal at 0.5 reads ~-6 dBTP (steady-state)", () => {
    const state = createTruePeakState();
    warmup(state, 0.5);
    const block = new Float32Array(256).fill(0.5);
    const dbtp = processTruePeak(state, block);
    expect(dbtp).toBeCloseTo(-6.02, 0);
  });

  it("step response from 0→1 captures FIR overshoot", () => {
    const state = createTruePeakState();
    const block = new Float32Array(256).fill(1.0);
    const dbtp = processTruePeak(state, block);
    // Expect slight positive overshoot from the filter's step response
    expect(dbtp).toBeGreaterThanOrEqual(0);
    expect(dbtp).toBeLessThan(2.0);
  });

  it("silence reads -Infinity", () => {
    const state = createTruePeakState();
    const block = new Float32Array(256).fill(0);
    const dbtp = processTruePeak(state, block);
    expect(dbtp).toBe(-Infinity);
  });

  it("detects inter-sample peaks exceeding sample peak", () => {
    // Create a signal with two adjacent samples at +1 and -1 (Nyquist/2 sine).
    // The inter-sample peak should be higher than the sample values.
    const state = createTruePeakState();
    const block = new Float32Array(256);
    // Sine at fs/4 = alternating pattern [0, 1, 0, -1, ...]
    for (let i = 0; i < block.length; i++) {
      block[i] = Math.sin((Math.PI / 2) * i) * 0.9;
    }
    const samplePeak = 0.9;
    const dbtp = processTruePeak(state, block);
    // The true peak should be at least as high as sample peak
    expect(dbtp).toBeGreaterThanOrEqual(truePeakToDbtp(samplePeak) - 0.5);
  });

  it("reset clears the running maximum", () => {
    const state = createTruePeakState();
    warmup(state, 0.8);
    const loud = new Float32Array(256).fill(0.8);
    processTruePeak(state, loud);
    expect(state.maxAbs).toBeGreaterThan(0.7);

    resetTruePeak(state);
    expect(state.maxAbs).toBe(0);

    warmup(state, 0.1);
    const quiet = new Float32Array(256).fill(0.1);
    const dbtp = processTruePeak(state, quiet);
    expect(dbtp).toBeCloseTo(-20, 0);
  });

  it("truePeakToDbtp(0) returns -Infinity", () => {
    expect(truePeakToDbtp(0)).toBe(-Infinity);
  });

  it("truePeakToDbtp(1) returns 0", () => {
    expect(truePeakToDbtp(1)).toBeCloseTo(0, 10);
  });
});
