# ProRes Viewer

Direct Apple ProRes MOV playback in the browser without server-side transcoding. ProRes files can be up to 1.5 TB on network storage served via HTTPS. Since no browser supports ProRes via `<video>` + MSE or WebCodecs, this uses a fully custom pipeline: **HTTP Range requests → MOV demux → multi-worker WASM decode → WebGL2 render**.

## Architecture

```
HTTPS URL (.mov on network storage)
  → App.tsx: isMovUrl() check → mount ProResViewer
    → ProResViewer.tsx (coordinator)
      ├── Probe: Range-fetch moov atom → direct box parsing → sample table
      ├── WASM compile: compileStreaming() runs in parallel with probe
      ├── Main-thread fetch pipeline:
      │   Single Range request → arrayBuffer() → extract frames
      ├── Decode worker pool (N = 3, decode-only, pre-compiled WASM):
      │   ├── Worker 0: WASM decode → transfer YUV planes
      │   ├── Worker 1: WASM decode → transfer YUV planes
      │   └── Worker 2: WASM decode → transfer YUV planes
      ├── Frame ring buffer (up to 500 MB / ~62 frames for 1080p)
      └── ProResCanvas.tsx: WebGL2 YUV 4:2:2 10-bit → RGB → fullscreen quad
```

See [prores-network-fetch.md](./prores-network-fetch.md) for fetch strategy research, Chrome trace debugging methodology, and performance optimization history.

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

- WASM compiled once on main thread via `compileStreaming()` (parallel with moov probe)
- Pre-compiled `WebAssembly.Module` passed to workers via `postMessage`
- Workers call `WebAssembly.instantiate(precompiledModule, ...)` — instant, no fetch/compile
- Fallback: lazy fetch + compile if no pre-compiled module provided
- WASI stubs (args, environ, proc_exit → WasiExit throw, fd_write reports bytes written)
- `_start()` call wrapped in try/catch for WasiExit
- Decode output: planar YUV422P10LE or YUV444P10LE — copies from AVFrame planes to output buffers handling linesize stride

### Validation (`wasm/test-prores.mjs`)

```bash
node wasm/test-prores.mjs
```

Reads the test fixture MOV, extracts a raw ProRes frame, feeds it to the WASM decoder, and verifies Y/Cb/Cr plane values are in 10-bit range.

## Fetch + Decode Pipeline (`useProResPlayback`)

ProRes is intra-only — every frame is independently decodable with zero inter-frame dependencies. This makes decode trivially parallelizable.

### Main-Thread Fetch

- Single Range request for the entire buffer window (~62 frames, ~55 MB)
- `await response.arrayBuffer()` — browser downloads at full internal speed
- Frames extracted and dispatched to decode workers in one fast loop
- WASM module pre-compiled on main thread via `compileStreaming()` during moov probe

### Decode Workers

- 3 decode-only workers (no network access)
- Each receives pre-compiled `WebAssembly.Module` via `postMessage` (structured-clonable)
- Round-robin frame dispatch from the main thread
- ~7ms per frame decode = ~440 fps aggregate capacity with 3 workers

### Ring Buffer

- Memory-limited: `MAX_BUFFER_MEMORY / estimatedFrameBytes` (~62 frames for 1080p)
- Hard cap: 500 MB total decoded frame memory
- Frames evicted when outside the prefetch window
- Consumed frames feed the WebGL2 renderer at target FPS via rAF loop

### Pre-Buffer

Playback starts only after 15 consecutive frames are decoded. Prevents immediate buffer underruns after pressing play.

### Seek

1. If target frame is in ring buffer: render instantly, no pipeline cancellation
2. If target frame is not buffered: cancel fetch pipeline, flush buffer, re-dispatch from new position

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
