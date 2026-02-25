import { describe, it, expect } from "vitest";
import { getKWeightCoeffs, kWeightMagnitudeDb, biquadMagnitudeDb } from "./kWeighting";

describe("kWeighting", () => {
  describe("48 kHz reference coefficients", () => {
    it("returns reference shelf coefficients at 48 kHz", () => {
      const { shelf } = getKWeightCoeffs(48000);
      expect(shelf.b[0]).toBeCloseTo(1.53512485958697, 10);
      expect(shelf.b[1]).toBeCloseTo(-2.69169618940638, 10);
      expect(shelf.b[2]).toBeCloseTo(1.19839281085285, 10);
      expect(shelf.a[0]).toBe(1.0);
      expect(shelf.a[1]).toBeCloseTo(-1.69065929318241, 10);
      expect(shelf.a[2]).toBeCloseTo(0.73248077421585, 10);
    });

    it("returns reference HPF coefficients at 48 kHz", () => {
      const { highpass } = getKWeightCoeffs(48000);
      expect(highpass.b[0]).toBe(1.0);
      expect(highpass.b[1]).toBe(-2.0);
      expect(highpass.b[2]).toBe(1.0);
      expect(highpass.a[0]).toBe(1.0);
      expect(highpass.a[1]).toBeCloseTo(-1.99004745483398, 10);
      expect(highpass.a[2]).toBeCloseTo(0.99007225036621, 10);
    });
  });

  describe("caching", () => {
    it("returns the same object for repeated calls", () => {
      const a = getKWeightCoeffs(44100);
      const b = getKWeightCoeffs(44100);
      expect(a).toBe(b);
    });
  });

  describe("frequency response at 48 kHz", () => {
    // ITU-R BS.1770-5 combined K-weighting response.
    // The shelf adds ~+0.7 dB at 1 kHz and ~+4 dB at high frequencies.

    it("small positive gain at 1 kHz (~+0.7 dB from shelf)", () => {
      const gain = kWeightMagnitudeDb(1000, 48000);
      expect(gain).toBeGreaterThan(0);
      expect(gain).toBeLessThan(1.5);
    });

    it("approximately +4 dB near 10 kHz (head diffraction shelf)", () => {
      const gain = kWeightMagnitudeDb(10000, 48000);
      expect(gain).toBeGreaterThan(2.5);
      expect(gain).toBeLessThan(5.0);
    });

    it("strong rolloff below 50 Hz", () => {
      const gain = kWeightMagnitudeDb(30, 48000);
      expect(gain).toBeLessThan(-5);
    });

    it("shelf contributes ~0 dB at 100 Hz", () => {
      const { shelf } = getKWeightCoeffs(48000);
      const shelfGain = biquadMagnitudeDb(shelf, 100, 48000);
      expect(Math.abs(shelfGain)).toBeLessThan(0.5);
    });

    it("HPF attenuates at 38 Hz", () => {
      const { highpass } = getKWeightCoeffs(48000);
      const gain = biquadMagnitudeDb(highpass, 38, 48000);
      // The RLB filter has significant attenuation around 38 Hz
      expect(gain).toBeLessThan(-3);
    });
  });

  describe("frequency response at 44100 Hz", () => {
    it("small positive gain at 1 kHz (consistent with 48 kHz)", () => {
      const gain = kWeightMagnitudeDb(1000, 44100);
      expect(gain).toBeGreaterThan(0);
      expect(gain).toBeLessThan(1.5);
    });

    it("shelf boost above 2 kHz", () => {
      const gain = kWeightMagnitudeDb(5000, 44100);
      expect(gain).toBeGreaterThan(1.0);
    });
  });

  describe("frequency response at 96000 Hz", () => {
    it("small positive gain at 1 kHz (consistent with 48 kHz)", () => {
      const gain = kWeightMagnitudeDb(1000, 96000);
      expect(gain).toBeGreaterThan(0);
      expect(gain).toBeLessThan(1.5);
    });

    it("shelf boost at 10 kHz", () => {
      const gain = kWeightMagnitudeDb(10000, 96000);
      expect(gain).toBeGreaterThan(2.0);
    });
  });
});
