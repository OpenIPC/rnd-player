# ProRes Viewer

Direct Apple ProRes MOV playback in the browser without server-side transcoding. ProRes files can be up to 1.5 TB on network storage served via HTTPS. Since no browser supports ProRes via `<video>` + MSE or WebCodecs, this uses a fully custom pipeline: **HTTP Range requests → MOV demux → multi-worker WASM decode → WebGL2 render**.

## Architecture

```
HTTPS URL (.mov on network storage)
  → App.tsx: isMovUrl() check → mount ProResViewer
    → ProResViewer.tsx (coordinator)
      ├── Probe: Range-fetch moov atom → direct box parsing → sample table
      ├── Decode worker pool (N = hardwareConcurrency, max 16):
      │   ├── Worker 0: Range-fetch frame → WASM decode → transfer YUV planes
      │   ├── Worker 1: Range-fetch frame → WASM decode → transfer YUV planes
      │   └── ...
      ├── Frame ring buffer (adaptive: workerCount to 1 second of video)
      └── ProResCanvas.tsx: WebGL2 YUV 4:2:2 10-bit → RGB → fullscreen quad
```

## URL Detection

`App.tsx` checks if the URL has a `.mov` extension via `isMovUrl()`. If true and `moduleConfig.proresViewer` is enabled (requires WebGL2 + Workers), mounts `ProResViewer` instead of `ShakaPlayer`.

## MOV Probe (`proResProbe.ts`)

Parses the moov atom directly (no mp4box.js dependency):

1. Range-fetch first 64 KB → scan for `ftyp` + `moov` top-level boxes
2. If moov not at start (common for large MOV files), Range-fetch last 64 KB → byte-scan for "moov" FourCC signature (can't parse boxes sequentially because the buffer starts mid-`mdat`)
3. If moov extends beyond fetched range, issue a targeted Range request for the full moov
4. Parse moov box tree: `trak` → `mdia` → `mdhd` (timescale) → `minf` → `stbl`
5. Extract from stbl: `stsd` (codec FourCC + dimensions), `stsz` (sample sizes), `stco`/`co64` (chunk offsets), `stsc` (sample-to-chunk mapping), `stts` (sample durations)
6. Build flat sample table: `{ offset, size, duration }` for every frame
7. Check codec FourCC against ProRes variants: `apch`/`apcn`/`apcs`/`apco`/`ap4h`/`ap4x`

File size is extracted from the `Content-Range` header of the first Range response (more reliable than HEAD, which some servers don't handle well).

## WASM Decoder

### Build (`wasm/build-prores.sh`)

- Reuses existing FFmpeg n7.1 checkout in `wasm/build/ffmpeg/`
- `emconfigure ./configure --disable-all --enable-avcodec --enable-avutil --enable-decoder=prores`
- FFmpeg auto-selects `blockdsp`, `idctdsp`, `proresdsp` dependencies
- C wrapper `prores_wrapper.c`: `prores_create(codec_tag)`, `prores_decode(...)`, `prores_destroy()`
- Output: `public/prores-decoder.wasm` (~288 KB)
- `emcc -O2 -s STANDALONE_WASM=1 -s TOTAL_MEMORY=67108864 -s ALLOW_MEMORY_GROWTH=1`

### JS Wrapper (`proresDecoder.ts`)

Follows `ec3Decoder.ts` pattern:

- Lazy WASM loading with module-level cache
- WASI stubs (args, environ, proc_exit → WasiExit throw, fd_write reports bytes written)
- `_start()` call wrapped in try/catch for WasiExit
- Each worker instantiates its own WASM instance from the shared compiled module
- Decode output: planar YUV422P10LE or YUV444P10LE — copies from AVFrame planes to output buffers handling linesize stride

### Validation (`wasm/test-prores.mjs`)

```bash
node wasm/test-prores.mjs
```

Reads the test fixture MOV, extracts a raw ProRes frame, feeds it to the WASM decoder, and verifies Y/Cb/Cr plane values are in 10-bit range.

## Multi-Worker Decode Pool (`useProResPlayback`)

ProRes is intra-only — every frame is independently decodable with zero inter-frame dependencies. This makes it trivially parallelizable.

### Worker Pool

- `N = navigator.hardwareConcurrency` workers (capped at 16)
- Each worker has its own WASM ProRes decoder instance
- Workers are long-lived (created on init, destroyed on unmount)
- Each worker independently fetches (Range request) and decodes

### Ring Buffer

- Adaptive size: up to 1 second of video (e.g. 30 frames at 30fps)
- Hard cap: 500 MB total decoded frame memory
- Frames evicted when outside the prefetch window
- Consumed frames feed the WebGL2 renderer at target FPS via rAF loop

### Seek

1. Cancel all pending worker decodes (AbortController on fetch + ignore stale requestIds)
2. Flush ring buffer
3. Decode target frame with highest priority
4. Resume prefetching forward from new position

## WebGL2 Renderer (`useProResRenderer`)

### YUV 4:2:2 10-bit Textures

- 3 textures: Y (full resolution), Cb (half-width for 4:2:2), Cr (half-width for 4:2:2)
- Internal format: `R16UI`, format: `RED_INTEGER`, type: `UNSIGNED_SHORT`
- `usampler2D` + `texelFetch()` in fragment shader (integer textures don't support filtering)
- BT.709 studio-range YCbCr → RGB color matrix, normalizing from 10-bit [0, 1023]

### Viewport

Letterboxed to maintain aspect ratio (same pattern as `useDiffRenderer`): compute video aspect vs canvas aspect, adjust viewport X/Y/W/H.

## Controls (`ProResControls`)

- Play/pause toggle (Space key)
- Frame step forward/backward (Arrow keys)
- Scrubber bar with click-to-seek
- Timecode display (HH:MM:SS.mmm)
- Frame counter ("Frame 127 / 54000")
- Buffer health indicator
- Playback speed selector (0.25x, 0.5x, 1x, 2x)
- Metadata badge: "ProRes HQ · 1920x1080 · 10-bit 4:2:2"

## Module Config

`proresViewer: boolean` in `PlayerModuleConfig`. Hard-gated on WebGL2 (for rendering) and Workers (for decode pool). Disabled in `production` and `minimal` build presets.

## Memory Budget

| Resolution | Y Plane | Cb + Cr | Total per frame |
|---|---|---|---|
| 1080p (1920x1080) | 4.0 MB | 2.0 + 2.0 MB | ~6.2 MB |
| 4K (3840x2160) | 15.8 MB | 7.9 + 7.9 MB | ~24.9 MB |

Hard cap: 500 MB total decoded frame memory. Frames transferred via `Transferable` (zero-copy). Ring buffer evicts consumed frames immediately.

## Test Fixture

```bash
ffmpeg -f lavfi -i "testsrc2=size=320x240:duration=1:rate=30" \
  -c:v prores_ks -profile:v 3 -pix_fmt yuv422p10le \
  e2e/fixtures/test-prores-hq.mov
```

Copy to `public/` for dev testing: `cp e2e/fixtures/test-prores-hq.mov public/`

## File Map

| File | Purpose |
|---|---|
| `wasm/build-prores.sh` | Emscripten build script |
| `wasm/test-prores.mjs` | WASM validation test |
| `src/types/proResWorker.types.ts` | Message types, SampleTableEntry, DecodedFrame, ProResTrackInfo |
| `src/wasm/proresDecoder.ts` | WASM loader + JS wrapper |
| `src/workers/proResWorker.ts` | Range-fetch + decode worker |
| `src/utils/proResProbe.ts` | MOV probe (direct moov box parsing) |
| `src/hooks/useProResRenderer.ts` | WebGL2 YUV→RGB renderer |
| `src/hooks/useProResPlayback.ts` | Worker pool, ring buffer, rAF playback loop |
| `src/components/ProResViewer.tsx` | Top-level coordinator |
| `src/components/ProResCanvas.tsx` | WebGL2 canvas component |
| `src/components/ProResControls.tsx` | Playback controls UI |
| `src/components/ProResViewer.css` | Styles |
