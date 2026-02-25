import { describe, it, expect } from "vitest";
import {
  blockMeanSquare,
  lufsFromMeanSquares,
  windowedLufs,
  channelWeight,
  createGatingState,
  addGatingBlock,
  computeIntegratedLoudness,
  resetGatingState,
  createLraState,
  addLraBlock,
  computeLra,
} from "./loudnessCompute";

describe("loudnessCompute", () => {
  describe("channelWeight", () => {
    it("mono/stereo channels all have weight 1.0", () => {
      expect(channelWeight(0, 1)).toBe(1.0);
      expect(channelWeight(0, 2)).toBe(1.0);
      expect(channelWeight(1, 2)).toBe(1.0);
    });

    it("5.1 surround: FL/FR/C = 1.0, LFE = 0, SL/SR = 1.41", () => {
      expect(channelWeight(0, 6)).toBe(1.0); // FL
      expect(channelWeight(1, 6)).toBe(1.0); // FR
      expect(channelWeight(2, 6)).toBe(1.0); // C
      expect(channelWeight(3, 6)).toBe(0.0); // LFE
      expect(channelWeight(4, 6)).toBe(1.41); // SL
      expect(channelWeight(5, 6)).toBe(1.41); // SR
    });
  });

  describe("blockMeanSquare", () => {
    it("computes mean square of samples", () => {
      const samples = new Float32Array([0.5, -0.5, 0.5, -0.5]);
      expect(blockMeanSquare(samples)).toBeCloseTo(0.25, 10);
    });

    it("silence gives 0", () => {
      expect(blockMeanSquare(new Float32Array(128))).toBe(0);
    });

    it("full-scale gives 1.0", () => {
      const samples = new Float32Array(128).fill(1.0);
      expect(blockMeanSquare(samples)).toBeCloseTo(1.0, 10);
    });
  });

  describe("lufsFromMeanSquares", () => {
    it("1 kHz sine at 0 dBFS mono ≈ -3.01 LUFS", () => {
      // A full-scale sine has RMS = 1/sqrt(2), so mean square = 0.5
      // LUFS = -0.691 + 10·log10(1.0 × 0.5) = -0.691 + (-3.010) = -3.701
      // But K-weighting at 1 kHz is ~0 dB, so without filtering:
      const meanSq = 0.5; // Sine at 0 dBFS: RMS² = 0.5
      const lufs = lufsFromMeanSquares([meanSq], 1);
      expect(lufs).toBeCloseTo(-3.701, 2);
    });

    it("full-scale stereo sine at 0 dBFS ≈ -0.691 LUFS", () => {
      // Two channels, each at mean square 0.5
      // LUFS = -0.691 + 10·log10(1.0×0.5 + 1.0×0.5) = -0.691 + 0 = -0.691
      const lufs = lufsFromMeanSquares([0.5, 0.5], 2);
      expect(lufs).toBeCloseTo(-0.691, 2);
    });

    it("silence gives -Infinity", () => {
      expect(lufsFromMeanSquares([0], 1)).toBe(-Infinity);
    });

    it("LFE channel is excluded in 5.1", () => {
      const ms = [0, 0, 0, 0.5, 0, 0]; // Only LFE has signal
      expect(lufsFromMeanSquares(ms, 6)).toBe(-Infinity);
    });
  });

  describe("windowedLufs", () => {
    it("averages blocks correctly", () => {
      // 2 blocks, stereo, each channel at ms=0.5
      const ring = [
        [0.5, 0.5],
        [0.5, 0.5],
      ];
      const lufs = windowedLufs(ring, 2, 2);
      expect(lufs).toBeCloseTo(-0.691, 2);
    });

    it("empty ring gives -Infinity", () => {
      expect(windowedLufs([], 0, 2)).toBe(-Infinity);
    });
  });

  describe("gating (integrated loudness)", () => {
    it("excludes blocks below -70 LUFS (absolute gate)", () => {
      const state = createGatingState(1);
      // Add a very quiet block (below -70 LUFS)
      // For mono: LUFS = -0.691 + 10·log10(ms)
      // -70 = -0.691 + 10·log10(ms) → ms = 10^(-6.9309) ≈ 1.17e-7
      addGatingBlock(state, [1e-9]); // Way below -70 LUFS
      // Add a normal block
      addGatingBlock(state, [0.01]); // ~ -20.691 LUFS

      const integrated = computeIntegratedLoudness(state);
      // Should only include the normal block
      expect(integrated).toBeCloseTo(-20.691, 1);
    });

    it("applies relative gate (-10 LU from Γ_a)", () => {
      const state = createGatingState(1);
      // Add several blocks at different levels
      // All above -70 LUFS so they pass absolute gate
      for (let i = 0; i < 10; i++) addGatingBlock(state, [0.1]); // ~-10.691 LUFS
      addGatingBlock(state, [0.001]); // ~-30.691 LUFS — might be gated out

      const integrated = computeIntegratedLoudness(state);
      // The quiet block should be filtered by relative gate
      expect(integrated).toBeGreaterThan(-12);
      expect(integrated).toBeLessThan(-9);
    });

    it("reset clears state", () => {
      const state = createGatingState(2);
      addGatingBlock(state, [0.1, 0.1]);
      resetGatingState(state);
      expect(state.blockLoudnesses).toHaveLength(0);
      expect(state.blockMeanSquares).toHaveLength(0);
    });
  });

  describe("LRA (loudness range)", () => {
    it("constant loudness gives LRA ≈ 0", () => {
      const state = createLraState(1);
      for (let i = 0; i < 100; i++) {
        addLraBlock(state, -14.0);
      }
      expect(computeLra(state)).toBeCloseTo(0, 0);
    });

    it("bimodal distribution gives non-zero LRA", () => {
      const state = createLraState(1);
      // 50 blocks at -20 LUFS, 50 blocks at -10 LUFS
      for (let i = 0; i < 50; i++) addLraBlock(state, -20);
      for (let i = 0; i < 50; i++) addLraBlock(state, -10);
      const lra = computeLra(state);
      // Should be roughly 10 LU (difference between -10 and -20)
      expect(lra).toBeGreaterThan(7);
      expect(lra).toBeLessThan(13);
    });

    it("not enough blocks returns 0", () => {
      const state = createLraState(1);
      addLraBlock(state, -14.0);
      expect(computeLra(state)).toBe(0);
    });
  });
});
