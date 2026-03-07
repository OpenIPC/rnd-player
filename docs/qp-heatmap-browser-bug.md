# QP Heatmap H.264 Browser Bug — Investigation Notes

## Status: ROOT CAUSE FOUND — mp4box.js sample reordering

The JM H.264 WASM decoder works perfectly in **both** Node.js and Chrome's main thread. The failure was isolated to the Web Worker, where **mp4box.js reorders samples by CTS (presentation order) instead of preserving trun order (decode order)**. This feeds B-frames out of order to the JM decoder, which expects decode order.

## Root Cause

**mp4box.js `onSamples` returns samples in presentation order (CTS), not decode order (DTS/trun order).**

DASH segments with B-frames store samples in decode order in the trun box. JM (and any H.264 decoder) expects NALUs in decode order. When mp4box.js reorders samples by CTS, B-frames are fed before their reference frames, causing the entire decode to fail.

Evidence:
- Same segment (Rep 5 seg 0, 1,265,899 bytes) → same Annex B size (1,252,809 bytes)
- Manual trun/mdat parsing: checksum `88989468` → **72/72 frames decode, 0 errors**
- mp4box.js extraction: checksum `822970487` → **0/72 frames complete, IDR gets only 230/6120 MBs**
- Same WASM binary, same Chrome browser — only the Annex B content differs

## Fix Applied

Replaced mp4box.js sample extraction with direct trun/mdat parsing in `qpMapWorker.ts` for the H.264/H.265 path. The new `extractSamplesDirectly()` function reads sample sizes from the trun box and extracts NALUs directly from mdat in trun order (decode order).

mp4box.js is still used for:
- AV1 path (no decode-order dependency for OBU concatenation)
- Sample count logging

## Investigation Timeline

### Phase 1: Wrong hypothesis — WASM EH
- Initial observation: Node.js works, browser Worker fails
- Hypothesis: `SUPPORT_LONGJMP=wasm` (WASM Exception Handling) behaves differently in Chrome Worker vs Node.js
- **Disproven**: Rebuilt with `SUPPORT_LONGJMP=0`, removed all setjmp/longjmp → still fails
- Also tried: `error()` just returns (no exit/longjmp), `exit()` override to skip atexit → no effect

### Phase 2: Data verification
- Added C-side checksum of Annex B buffer inside WASM
- JS-side checksum before `memory.set()` matches C-side checksum → data transfer is correct
- Head bytes match: `0000000167640028` (SPS start)
- Verified WASM memory readback matches source

### Phase 3: Isolation test
- Created `public/test-jm264.html` — standalone test page that:
  - Fetches the same DASH segment (Rep 5 seg 0)
  - Uses manual trun/mdat parsing (same as Node.js test)
  - Runs WASM decoder in Chrome's main thread
  - **Result: 72/72 frames decode perfectly, 0 errors**
- This proved: NOT a V8 bug, NOT a WASM bug, NOT a Worker bug
- The ONLY difference: test page uses manual parsing, Worker uses mp4box.js

### Phase 4: Checksum comparison
- Test page Annex B: `len=1252809 cksum=88989468` → works
- Worker Annex B: `len=1252809 cksum=822970487` → fails
- Same segment, same size, same head bytes, **different content** → mp4box.js reorders samples

## Key Diagnostic Data

### Working (manual parser, main thread or Worker)
```
NALU[0]: type=5 size=45484 head=65888400  (IDR)
NALU[1]: type=1 size=42733 head=419a236c
NALU[2]: type=1 size=19108 head=219e4178
F1:mb=6120/6120✓  F2:mb=6120/6120✓ ... F72:mb=6120/6120✓
72 iters, 72 complete, 0 errors
```

### Failing (mp4box.js, Worker)
```
F1:mb=230/6120  F2:mb=250/6120  F3:mb=422/6120 ...
72 iters, 0 complete, 0 errors, frame_ready=0
```

## Changes Made

### Build changes
- `SUPPORT_LONGJMP=0` (was `wasm`) — no WASM EH overhead
- `exit()` override → calls `_Exit()` directly, skipping atexit handlers
- `error()` override → just `fprintf + return` (no exit, no longjmp)

### Worker changes
- Added `extractSamplesDirectly()` — direct trun/mdat parser
- H.264/H.265 path uses direct parser instead of mp4box.js
- AV1 path still uses mp4box.js (no decode-order issue)

### Diagnostics (to be removed after verification)
- `public/test-jm264.html` — standalone browser test page
- C-side: per-frame `num_dec_mb` logging, `error()` call counter, Annex B checksum
- JS-side: `devLog()` relay to Vite dev server via `/__log` POST endpoint
- Vite plugin `devLogRelay()` in `vite.config.ts`

## File Inventory

| File | Role |
|------|------|
| `wasm/build-jm264.sh` | Build script with 11 patches |
| `wasm/jm264_wrapper.c` | C wrapper: decode loop, QP capture, error() override |
| `src/wasm/jm264Decoder.ts` | TypeScript WASM loader + instance wrapper |
| `src/workers/qpMapWorker.ts` | Web Worker: direct trun/mdat parsing, Annex B building |
| `src/hooks/useQpHeatmap.ts` | React hook: triggers QP decode on pause |
| `wasm/test-realworld.mjs` | Node.js test: FFmpeg-generated streams (8 tests) |
| `wasm/test-realworld-dash.mjs` | Node.js test: real DASH segments from CDN (9 tests) |
| `wasm/test-validate-qp.mjs` | Node.js test: QP value validation (32 tests) |
| `public/jm264-qp.wasm` | Compiled WASM binary (~424K) |
| `public/test-jm264.html` | Standalone browser test (diagnostic) |

## Cleanup TODO

After verifying the fix works end-to-end:
1. Remove diagnostic logging from `jm264_wrapper.c` (frame counter, per-frame fprintf, checksum)
2. Remove `devLog()` and `/__log` relay from `jm264Decoder.ts` and `vite.config.ts`
3. Remove `public/test-jm264.html`
4. Remove `exit()` override if not needed (test if _start atexit matters)
5. Consider whether `error()` returning is safe enough or if longjmp should be restored
6. Remove unused mp4box.js imports if H.264/H.265 path no longer needs them
