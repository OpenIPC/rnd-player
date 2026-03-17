# Film Grain Synthesis

Codec-agnostic, real-time film grain synthesis overlay using WebGL2.

## Background

Film grain is a key part of creative intent in motion picture content. Encoding it
directly wastes massive bitrate (up to 50% overhead) because grain is random and
defeats prediction/DCT. Modern codecs strip grain at the encoder, transmit compact
parameters, and re-synthesize at the decoder.

For **AV1** content, grain synthesis is mandatory — browser decoders (dav1d, libgav1)
apply it automatically from `film_grain_params` in the OBU frame header.

For **H.264/H.265**, film grain SEI messages (type 17) exist but are almost never
decoded by browser decoders. This feature fills that gap by providing a user-controllable
grain overlay that works with any codec.

## Research: Three Approaches from the Literature

| Aspect | AV1 (DCC 2018, Netflix/Google) | H.264 SEI (JVT-H022, Thomson) | H.264 SEI (JVT-I034, Panasonic) |
|--------|------|------|------|
| **Status** | Mandatory in AV1 spec | Optional SEI, rarely decoded | Optional SEI, rarely decoded |
| **Grain model** | AR process, lag L=0..3 | Two models: (1) 2nd-order AR, (2) low-pass filtered Gaussian | Encode one real grain macroblock |
| **Template** | 64x64 luma, 32x32 chroma | Parameterized per intensity level | 16x16 macroblock + 8 mirror/rotate variants |
| **Intensity scaling** | Piece-wise linear LUT (256 entries), f(Y) per color component | Per-intensity-level parameter sets, additive or multiplicative | `a * grain_ori(x,y)` where `a` depends on local statistics |
| **Tiling** | 32x32 blocks with random (s_x, s_y) offsets into 64x64 template | Not specified (decoder choice) | Cycle shift: `grain((x-x0)%s, (y-y0)%s)` |
| **Block overlap** | 34x34 actual, 2-pixel blend with weights 27/17 | Not specified | Not specified |
| **PRNG** | 16-bit LFSR, polynomial x^16+x^15+x^13+x^4+1 | Not specified | Not specified |
| **Param size** | <=145 bytes/frame (64B scaling + 74B AR coefficients) | Variable (depends on model + intensity levels) | One macroblock per frame/sequence |
| **Bitrate savings** | Up to 50% on heavy grain | ~50% demonstrated (QP28 vs QP22 at same visual quality) | Similar to Thomson |

Our implementation follows the AV1 approach — it is the most precisely specified,
mandated by a shipping codec, and the AR template + block tiling design maps cleanly
to a GPU fragment shader.

## Algorithm

Based on the AV1 film grain synthesis algorithm (DCC 2018, Netflix/Google):

1. **CPU** generates a 64x64 grain template via AR (autoregressive) process
   - Lag L controls spatial correlation: L=0 (fine/white noise), L=1 (medium), L=2 (coarse)
   - Template is normalized to [-1, 1] range
   - Regenerated only when grain size parameter changes (~0.1ms)

2. **GPU fragment shader** per frame:
   - Uploads video frame via `texImage2D(video)` (~0.3ms)
   - Divides frame into 32x32 blocks, each block gets a pseudo-random offset into the
     64x64 template (hash-based, varies per frame for temporal variation)
   - Reads luminance from video pixel, applies intensity-dependent scaling:
     piece-wise linear ramp (shadows < 0.15 and highlights > 0.85 get less grain)
   - Blends grain: additive `Y' = Y + f(Y) * G` or multiplicative `Y' = Y * (1 + f(Y) * G)`
   - Optional 2-pixel overlap blending at block boundaries (weights 27/17 per AV1 spec)

3. Canvas renders the complete `video + grain` composite (alpha: false, fully opaque)

## Parameters

| Parameter | Range | Default | Description |
|-----------|-------|---------|-------------|
| Intensity | 0-100 | 50 | Grain strength (maps to sigma 0.0-0.15) |
| Grain size | Fine/Medium/Coarse | Medium | AR lag L=0/1/2 (spatial correlation) |
| Color | Mono/Chromatic | Mono | Same grain all channels vs independent |
| Blend mode | Additive/Multiplicative | Additive | How grain combines with video |
| Overlap | On/Off | On | 2-pixel block boundary blending |

Parameters are persisted to `localStorage` key `vp_film_grain_params`.

## Performance

| Operation | Cost per frame | Notes |
|-----------|---------------|-------|
| Video texture upload | ~0.3ms | Single `texImage2D` call |
| Fragment shader | ~0.2ms | Texture lookups + arithmetic at 1080p |
| Grain template regen | ~0.1ms | Only on size parameter change |
| **Total** | **~0.5ms** | Well within 16.6ms budget for 60fps |

Memory: 16KB grain texture + 1 video-sized texture. No CPU readback.

## Module Config

- Module key: `filmGrain`
- Hard gate: `!profile.webGL2` (same as `qualityCompare`)
- Disabled in `production` and `minimal` build presets
- Toggle via Settings modal or right-click context menu

## Files

- `src/types/filmGrain.ts` — `FilmGrainParams` type, defaults, localStorage persistence
- `src/utils/grainTemplate.ts` — AR-process template generator (CPU)
- `src/utils/grainTemplate.test.ts` — Unit tests (zero-mean, variance, spatial correlation)
- `src/hooks/useFilmGrainRenderer.ts` — WebGL2 hook (shader compilation, rAF loop, context loss)
- `src/components/FilmGrainOverlay.tsx` — Canvas overlay (portaled into `.vp-video-area`)
- `src/components/FilmGrainOverlay.css` — Canvas positioning (z-index: 2, above watermark)
- `src/components/FilmGrainPanel.tsx` — Parameter controls
