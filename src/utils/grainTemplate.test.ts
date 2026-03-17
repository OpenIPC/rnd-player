import { describe, it, expect } from "vitest";
import { generateGrainTemplate, GRAIN_TEXTURE_SIZE } from "./grainTemplate";

describe("generateGrainTemplate", () => {
  it("returns a Float32Array of correct size", () => {
    const t = generateGrainTemplate("medium");
    expect(t).toBeInstanceOf(Float32Array);
    expect(t.length).toBe(GRAIN_TEXTURE_SIZE * GRAIN_TEXTURE_SIZE);
  });

  it("values are bounded to [-1, 1]", () => {
    for (const size of ["fine", "medium", "coarse"] as const) {
      const t = generateGrainTemplate(size);
      let min = Infinity, max = -Infinity;
      for (let i = 0; i < t.length; i++) {
        if (t[i] < min) min = t[i];
        if (t[i] > max) max = t[i];
      }
      expect(min).toBeGreaterThanOrEqual(-1);
      expect(max).toBeLessThanOrEqual(1);
    }
  });

  it("has non-trivial variance (not all zeros)", () => {
    const t = generateGrainTemplate("fine");
    let sumSq = 0;
    for (let i = 0; i < t.length; i++) sumSq += t[i] * t[i];
    const variance = sumSq / t.length;
    expect(variance).toBeGreaterThan(0.01);
  });

  it("coarse grain has higher spatial correlation than fine", () => {
    const measure = (t: Float32Array) => {
      let sum = 0;
      let count = 0;
      const N = GRAIN_TEXTURE_SIZE;
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N - 1; x++) {
          sum += Math.abs(t[y * N + x] - t[y * N + x + 1]);
          count++;
        }
      }
      return sum / count;
    };

    const fine = generateGrainTemplate("fine", 42);
    const coarse = generateGrainTemplate("coarse", 42);

    const fineDiff = measure(fine);
    const coarseDiff = measure(coarse);

    // Coarse should have smaller adjacent differences (more correlated)
    expect(coarseDiff).toBeLessThan(fineDiff);
  });

  it("different seeds produce different templates", () => {
    const a = generateGrainTemplate("medium", 100);
    const b = generateGrainTemplate("medium", 200);
    let same = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] === b[i]) same++;
    }
    expect(same).toBeLessThan(a.length * 0.1);
  });

  it("is seamlessly tileable (edge differences ≤ 2x interior)", () => {
    const N = GRAIN_TEXTURE_SIZE;
    const t = generateGrainTemplate("coarse", 42);

    // Measure seam differences (wrap-around edges)
    let seamDiff = 0;
    let seamCount = 0;
    // Left↔Right: column 0 vs column N-1
    for (let y = 0; y < N; y++) {
      seamDiff += Math.abs(t[y * N] - t[y * N + N - 1]);
      seamCount++;
    }
    // Top↔Bottom: row 0 vs row N-1
    for (let x = 0; x < N; x++) {
      seamDiff += Math.abs(t[x] - t[(N - 1) * N + x]);
      seamCount++;
    }
    const avgSeam = seamDiff / seamCount;

    // Measure interior adjacent differences
    let intDiff = 0;
    let intCount = 0;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N - 1; x++) {
        intDiff += Math.abs(t[y * N + x] - t[y * N + x + 1]);
        intCount++;
      }
    }
    const avgInterior = intDiff / intCount;

    expect(avgSeam).toBeLessThan(avgInterior * 2);
  });

  it("has approximately Gaussian distribution (sigma-clipped)", () => {
    const t = generateGrainTemplate("medium", 12345);
    let sum = 0;
    for (let i = 0; i < t.length; i++) sum += t[i];
    const mean = sum / t.length;
    expect(Math.abs(mean)).toBeLessThan(0.05);

    // Fraction in [-0.5, 0.5] should be ≈ 0.68 for Gaussian-like distribution
    let inMiddle = 0;
    for (let i = 0; i < t.length; i++) {
      if (t[i] >= -0.5 && t[i] <= 0.5) inMiddle++;
    }
    const frac = inMiddle / t.length;
    expect(frac).toBeGreaterThan(0.55);
    expect(frac).toBeLessThan(0.85);
  });

  it("AR process is stable (no NaN/Infinity)", () => {
    for (const size of ["fine", "medium", "coarse"] as const) {
      const t = generateGrainTemplate(size);
      for (let i = 0; i < t.length; i++) {
        expect(Number.isFinite(t[i])).toBe(true);
      }
    }
  });
});
