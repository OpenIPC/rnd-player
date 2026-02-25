# Professional Audio Loudness Metering — EBU R128 / ITU-R BS.1770

## Overview

EBU R128 / ITU-R BS.1770 compliant loudness metering alongside the existing dBFS peak/RMS meters. Provides LUFS (Momentary/Short-term/Integrated), True Peak (dBTP), and Loudness Range (LRA).

## Architecture

```
source (shared via audioSourceCache.ts)
  |-> [useAudioAnalyser signal chain — unchanged]
  |   splitter -> AnalyserNode per ch (raw dBFS)
  |
  +-> [useLoudnessMeter signal chain — new]
      splitter -> [IIR shelf -> IIR HPF -> AnalyserNode] per ch (K-weighted)
               -> [AnalyserNode] per ch (raw, for True Peak)
```

Both hooks share the AudioContext/MediaElementAudioSourceNode via `audioSourceCache.ts`.

## K-Weighting Filters (ITU-R BS.1770-5)

Two cascaded IIR biquads per channel via `IIRFilterNode`:

- **Stage 1 — Pre-filter high shelf** (+4 dB, models head diffraction)
- **Stage 2 — RLB high-pass** (~38 Hz corner, low-frequency rolloff)

Reference coefficients at 48 kHz; for other sample rates, recomputed via bilinear transform (invert to analog at fs_ref=48000, re-discretize at target). Cached per sample rate.

## Measurement Windows

Ring buffers store per-block mean-square values. AnalyserNode fftSize = 2048.

| Window | Duration | Formula |
|--------|----------|---------|
| Momentary (M) | 400ms | avg of ring buffer |
| Short-term (S) | 3s | avg of ring buffer |
| Integrated (I) | Full program | BS.1770 gated accumulator |

LUFS formula: `L = -0.691 + 10 * log10(Sum(G_i * z_i))`

Channel weights: L/R/C = 1.0, SL/SR = 1.41 (+1.5 dB), LFE = excluded.

## Integrated Loudness Gating (BS.1770)

Every 400ms block:
1. Compute block loudness
2. **Absolute gate**: discard if < -70 LUFS
3. **Gamma_a** = mean of blocks above absolute gate
4. **Relative gate** = Gamma_a - 10 LU
5. **Integrated** = mean of blocks above relative gate

## True Peak (ITU-R BS.1770 Annex 2)

4x oversampling via polyphase FIR: 48-tap Kaiser-windowed sinc (beta=7.0) decomposed into 4 phases of 12 taps, per-phase normalized for unity DC gain. Tracks running max absolute across all interpolated values. dBTP = 20 * log10(maxVal).

## Loudness Range (EBU Tech 3342)

Histogram-based: 1000 bins covering -70 to +10 LUFS (0.08 LU resolution). LRA = 95th percentile - 10th percentile after absolute gate (-70 LUFS) and relative gate (mean - 20 LU).

## UI Layout

Panel width: 160px (expanded from 80px).

- **Left half**: dBFS channel bars (L/R/FL/FR/C/LFE/SL/SR) — existing logic
- **Right half**: Two LUFS bars (Momentary and Short-term), EBU +9 scale
- **LUFS color zones**: green (< target-2 LU), yellow (target +/- 2 LU), red (> target+2 LU)
- **Sparkline**: 60-second rolling momentary loudness line below meters
- **Bottom controls**: Integrated/TP/LRA readouts, target selector, reset button

## Target Presets

| Target | Standard |
|--------|----------|
| -14 LUFS | Spotify / YouTube (default) |
| -16 LUFS | Apple Music |
| -23 LUFS | EBU R128 |
| -24 LKFS | ATSC A/85 |
| -27 LUFS | Cinema |

## File Map

```
src/utils/audioSourceCache.ts     — Shared AudioContext/source WeakMap
src/utils/kWeighting.ts           — K-weighting IIR coefficients with bilinear transform
src/utils/kWeighting.test.ts      — Coefficient & frequency response tests
src/utils/truePeakFilter.ts       — 4x oversampling polyphase FIR
src/utils/truePeakFilter.test.ts  — True peak accuracy tests
src/utils/loudnessCompute.ts      — Pure LUFS/gating/LRA functions
src/utils/loudnessCompute.test.ts — Loudness computation tests
src/hooks/useAudioAnalyser.ts     — Modified: uses audioSourceCache import
src/hooks/useLoudnessMeter.ts     — K-weighted signal chain + readLoudness()
src/components/AudioLevels.tsx     — Dual-panel layout, LUFS bars, readouts, controls
src/components/ShakaPlayer.css     — Width 160px, loudness control classes
src/components/VideoControls.tsx   — loudnessTarget state + props
src/components/SettingsModal.tsx   — Updated description
```
