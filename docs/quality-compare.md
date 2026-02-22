# Quality Compare Mode

Split-slider rendition comparator running two Shaka Player instances side-by-side. The master video (right / B-side) has audio and is controlled by VideoControls; the slave (left / A-side) is muted and clipped via CSS `clip-path`.

## Layer Architecture

All compare UI lives inside `.vp-compare-overlay` (absolute, `inset: 0`, `pointer-events: none`). Children selectively enable `pointer-events: auto`.

| Z-Index | Class | Layer | Pointer Events |
|---------|-------|-------|----------------|
| 6 | `.vp-compare-error` | Load/DRM error overlay | auto |
| 5 | `.vp-compare-toolbar` | Quality selectors, labels, close button | auto |
| 5 | `.vp-compare-zoom-label` | Zoom percentage display | none |
| 5 | `.vp-key-overlay` | Slave DRM key prompt (dual-manifest) | auto |
| 4 | `.vp-compare-strip` | Slider drag zone (48 px wide, full height) | auto |
| 3 | `.vp-compare-interact` | Pan + double-click (when zoomed & paused) | auto |
| 3 | `.vp-compare-draw` | Highlight rectangle drawing layer | auto |
| 3 | `.vp-compare-draw-rect` | Rubber-band feedback during drawing | none |
| 3 | `.vp-compare-highlight-border` | Dashed gold border around highlight | none |
| 2 | `.vp-compare-spotlight` | Dim overlay with clip-path cutout | none |
| 2 | `.vp-compare-frame-border` | I/P/B frame type colored borders | none |
| 1 | `.vp-compare-video` | Slave video element | none |

The interact layer and draw layer occupy the same z-index slot (3) and are **mutually exclusive**: the draw layer renders when `zoom <= 1 && paused && slaveReady && !highlight`; the interact layer renders when `zoom > 1 && paused`.

## Interaction Modes

### Slider Drag

Always available. The `.vp-compare-strip` is a 48 px wide invisible hit zone centered on the divider line. It captures pointer events via `setPointerCapture` and constrains the slider to 5-95% of the container width.

Visual feedback: the line widens from 2 px to 4 px on hover/active; the handle circle goes from 0.7 to 1.0 opacity. Both use 150 ms CSS transitions.

The strip calls `e.stopPropagation()` on both `pointerdown` and `click` to prevent play/pause on the video beneath.

### Wheel Zoom

Document-level `wheel` event listener (`passive: false` to call `preventDefault` and block browser zoom). Only active when `paused && slaveReady` and cursor is inside the container.

Two modes:
- **Discrete scroll**: step zoom by factor 1.15 per notch
- **Pinch / Ctrl+scroll**: continuous zoom via `Math.exp(-deltaY * 0.002)`

Zoom range: 1x - 8x. The cursor point stays stationary via the formula:

```
vx = cursorScreenX / oldZoom - panX
panX_new = cursorScreenX / newZoom - vx
```

### Pan (Zoomed + Paused)

The interact layer (`.vp-compare-interact`) renders when `zoom > 1 && paused`. Pointer events drive pan in pre-scale coordinates: `delta / zoom`. Pan is clamped so the video never scrolls past its edges.

Minimal movement (< 5 px total) on pointer-up is treated as a click and triggers play.

### Highlight Rectangle Drawing

The draw layer (`.vp-compare-draw`, `cursor: crosshair`) renders when `zoom <= 1 && paused && slaveReady && !highlight`.

1. `onDrawPointerDown` records starting corner in container-local pixels
2. `onDrawPointerMove` updates a rubber-band preview (dashed white border)
3. `onDrawPointerUp`:
   - Movement < 5 px -> click -> play (preserves click-to-play)
   - Rectangle < 1% of container in either dimension -> ignored
   - Otherwise -> normalize to fractional [0,1] coordinates -> `applyHighlight()`

### Clearing Highlight

| Trigger | Action |
|---------|--------|
| Escape key | Clear highlight + reset zoom to 1x |
| Double-click on interact layer | Clear highlight + reset zoom |
| Play (any trigger) | Clear highlight + reset zoom |

## Spotlight Highlight + Auto-Zoom

### HighlightRect

Stored as fractional coordinates (0-1 of container dimensions): `{ x, y, w, h }`. Resolution-independent; scales correctly across window resize and fullscreen toggle.

### Auto-Zoom Math

```
zoomX = containerWidth / (highlightWidth_px * 1.2)   // 10% padding each side
zoomY = containerHeight / (highlightHeight_px * 1.2)
zoom  = clamp(min(zoomX, zoomY), 1, 8)

// Center the rectangle in the viewport
panX = containerWidth  / (2 * zoom) - (highlightX_px + highlightWidth_px  / 2)
panY = containerHeight / (2 * zoom) - (highlightY_px + highlightHeight_px / 2)
```

After computing zoom and pan, `clampPan()` ensures the video doesn't scroll past edges, then `applyTransform()` updates both videos and all overlays.

### Spotlight Overlay

A full-size div (`background: rgba(0,0,0,0.5)`) with a CSS `clip-path: polygon()` cutout. The polygon winds clockwise around the container boundary, then counterclockwise around the highlight rectangle to create the inverse mask:

```
polygon(
  0 0, cw 0, cw ch, 0 ch, 0 0,
  sx sy, sx (sy+sh), (sx+sw) (sy+sh), (sx+sw) sy, sx sy
)
```

Where `(sx, sy, sw, sh)` are screen-space coordinates computed from fractional highlight + current zoom/pan via `(local + tx) * z`.

### Highlight Border

A separate positioned div with `border: 2px dashed rgba(255, 215, 0, 0.8)` and double box-shadow (outer + inner). Its `left`, `top`, `width`, `height` are set imperatively by `updateSpotlight()`, which is called from `applyTransform()` on every zoom/pan/resize change.

### Imperative Update Pattern

Both the spotlight clip-path and highlight border position are updated imperatively via refs (`spotlightRef`, `highlightBorderRef`) inside `updateSpotlight()`. This follows the same pattern as `updateClipPath()` for the slave video and avoids React re-renders on every wheel tick or pointer move.

The highlight value is tracked via both React state (`highlight`) for conditional rendering and a ref (`highlightRef`) for use inside callbacks without stale closures.

## Analysis Modes

Three modes controlled by icon buttons in the toolbar center. The `T` key cycles `split → diff → toggle → split`. The `D` key toggles between split and diff.

### Split (default)

A/B split with a draggable vertical divider. The slave video is clipped via `clip-path: inset()` to the left of the slider. When zoomed, the clip boundary is recalculated in local coordinates so it tracks the slider's screen position.

### Diff

Per-pixel difference map rendered via WebGL2 on an overlay canvas (`useDiffRenderer`). The slave video is hidden (`visibility: hidden`); the diff canvas replaces it visually.

#### Palette Dropdown

A dropdown button shows the current palette name plus a `▾` arrow. Clicking opens a popup menu grouped by category:

- **Perceptual metrics**: SSIM (default), MS-SSIM (indented sub-option), PSNR, VMAF (with submenu)
- **Separator**
- **Basic pixel diffs**: Grayscale, Temperature

VMAF has a hover submenu opening to the right with model options: HD (default), NEG, Phone, 4K. The 4K model is only shown when the B-side rendition height is >= 2160p. If the user has 4K selected and switches B-side below 2160p, the model resets to HD.

The amplification button (`1x → 2x → 4x → 8x`) cycles on click and scales the diff signal.

A metric value readout displays the current frame's computed metric (PSNR in dB, SSIM/MS-SSIM as 0-1, VMAF as 0-100).

### Toggle

Alternates slave visibility at a configurable flicker interval. The `A`/`B` indicator shows which side is visible. The speed button cycles `250ms → 500ms → 1s`.

## URL Parameter Scheme

| Param | Type | Example | Description |
|-------|------|---------|-------------|
| `v` | string | `manifest.mpd` | Master manifest URL |
| `t` | string | `12.345s` | Start time (millisecond precision) |
| `key` | string | `0123456...` | ClearKey hex |
| `compare` | string | `other.mpd` | Slave manifest URL |
| `qa` | int | `240` | Initial A-side (slave) height |
| `qb` | int | `1080` | Initial B-side (master) height |
| `zoom` | float | `2.50` | Zoom level (omitted if 1x) |
| `px` | float | `0.1234` | Pan X fraction |
| `py` | float | `-0.0567` | Pan Y fraction |
| `split` | int | `35` | Slider position % (omitted if 50) |
| `hx` | float | `0.2500` | Highlight X (fraction 0-1) |
| `hy` | float | `0.3000` | Highlight Y (fraction 0-1) |
| `hw` | float | `0.5000` | Highlight width (fraction 0-1) |
| `hh` | float | `0.4000` | Highlight height (fraction 0-1) |
| `cmode` | string | `diff` | Analysis mode (omitted if `split`) |
| `cfi` | int | `250` | Toggle flicker interval ms (omitted if 500) |
| `amp` | int | `4` | Diff amplification (omitted if 1) |
| `pal` | string | `psnr` | Diff palette (omitted if `ssim`) |
| `vmodel` | string | `neg` | VMAF model (omitted if `hd`; only when `pal=vmaf`) |

Highlight params are only serialized when all four are present. They are parsed in `App.tsx`, threaded through `ShakaPlayer` as `compareHx/Hy/Hw/Hh`, and passed to `QualityCompare` as `initialHighlightX/Y/W/H`. A one-time `useEffect` (gated on `slaveReady`) restores the highlight from URL.

The `CompareViewState` interface (shared via `viewStateRef`) carries all view state including highlight fields. `VideoControls.copyVideoUrl()` reads the ref and serializes to URL params.

## Sync Strategy

### Paused (Frame-Accurate)

All sync flows through the master's `seeked` event:

```
masterVideo seeks -> seeked fires -> slaveVideo.currentTime = masterVideo.currentTime
```

Click-to-pause re-asserts the master's position (`masterVideo.currentTime = masterVideo.currentTime`) to force a `seeked` event, avoiding the race condition of seeking a video transitioning from play to pause.

### Playing (Drift Correction)

A `requestAnimationFrame` loop adjusts the slave's `playbackRate`:

| Drift | Action |
|-------|--------|
| > 200 ms | Hard seek `slaveVideo.currentTime = masterTime` |
| 16-200 ms | Rate adjust +/-3% (`masterRate * 0.97` or `* 1.03`) |
| < 16 ms | Match rates exactly |

Rate-based correction avoids decoder flicker that hard seeks cause.

### Duration Mismatch

When manifests have different durations, the slave is clamped to its own duration. Seeks beyond the slave's duration pause it; playback past the slave's end pauses it.

## DRM / Encrypted Content

### Slave Key Detection (Dual-Manifest Mode)

When `slaveSrc !== src`, the slave manifest is fetched independently to detect `cenc:default_KID`:
- Same KID as master + master has key -> reuse key
- Different KID + user already provided key -> use it
- Different KID + no key -> show key prompt overlay

### EME Fallback

Two-layer detection from `softwareDecrypt.ts`:
1. **Pre-check**: `hasClearKeySupport()` probes `navigator.requestMediaKeySystemAccess`. If absent (Linux WebKitGTK), skip EME entirely.
2. **Post-load**: `waitForDecryption()` polls `video.readyState` for 1.5 s. If stuck at `HAVE_METADATA` despite buffered data, EME silently failed (macOS WebKit). Reload with software decryption.

## Frame Type Detection

When paused and slave is ready, `getFrameTypeAtTime()` runs independently on both players. Frame types are classified from the active rendition's segment data using mp4box sample extraction and a max-CTS heuristic (see CLAUDE.md). Results are displayed as colored borders and badges:

| Type | Color | CSS |
|------|-------|-----|
| I (Intra) | Red | `rgb(255, 50, 50)` |
| P (Predicted) | Blue | `rgb(60, 130, 255)` |
| B (Bi-directional) | Green | `rgb(50, 200, 50)` |

A GOP bar visualization shows relative frame sizes when the GOP has more than one frame.

## Dual-Manifest Mode

### Rendition Defaults

| Scenario | A-side default | B-side default |
|----------|----------------|----------------|
| Same manifest | Lowest quality | Highest quality |
| Dual-manifest | Highest common resolution | Highest common resolution |

### Domain Labels

In dual-manifest mode, domain labels appear above each quality dropdown. When both URLs share the same second-level domain, the distinguishing subdomain prefix is shown instead (e.g. "msk2-cdp4" vs "pre-edge-cdp1"). Clicking a label copies the URL.

### ABR Management

The master's ABR state is saved on compare entry and disabled immediately (prevents the master from adapting during slave initialization). Both sides remain locked to user-selected renditions. ABR is restored on compare close.

## Responsiveness

A `ResizeObserver` on the container scales pan proportionally on resize (`panX_new = panX_old * newWidth / oldWidth`) to preserve the viewport center. This handles fullscreen toggle, window resize, and orientation change.

---

## Caveats and Known Issues

### 1. Trackpad Spurious Play on Slider Drag

**Problem**: On MacBook trackpads, releasing the comparison slider sporadically triggered play (approximately 1 in 10 drags). The root cause was secondary touch events (palm, finger bounce, second finger) generating independent `click` events on `.vp-video-area` while the first finger was still dragging.

**Why standard approaches failed**:
- `setPointerCapture` captures pointer events but `click` is synthesized after capture release, based on the nearest common ancestor of `mousedown`/`mouseup` targets
- A one-shot capture-phase click suppressor installed on `pointerup` missed clicks from secondary pointers that fired before `pointerup` for the first pointer
- The overlay has `pointer-events: none`, so secondary clicks hit `.vp-video-area` directly

**Fix**: `style={dragging ? { pointerEvents: "auto" } : undefined}` on the overlay div. When dragging, the overlay intercepts all clicks over the video area. React batches `setDragging(false)` so the re-render hasn't happened by the time the post-drag click fires (~15 ms gap).

**Lesson**: On macOS trackpads, multiple simultaneous touches generate independent pointer sequences. Any drag interaction on an overlay with `pointer-events: none` must account for secondary touches generating clicks on underlying elements.

### 2. Self-Assignment Lint Warning

`masterVideo.currentTime = masterVideo.currentTime` triggers `no-self-assign`. This is intentional: re-asserting the position forces the browser to fire a `seeked` event, which is the sole reliable sync path. The lint warning is a known pre-existing issue across the codebase.

### 3. Highlight Ref + State Dual Tracking

The highlight is tracked via both React state (`highlight` for conditional rendering of draw layer / spotlight visibility) and a ref (`highlightRef` for use inside `useCallback` closures without stale closure issues). This dual-tracking is necessary because:
- `applyTransform` and `updateSpotlight` are stable callbacks that read the ref
- React render logic needs the state to decide which layers to show

Forgetting to update both will cause UI desync.

### 4. Initial Highlight vs Initial Zoom/Pan Ordering

When restoring from URL, zoom/pan are applied via `initialPanApplied` on mount, and the highlight is restored via a separate `useEffect` gated on `slaveReady`. The highlight `useEffect` only calls `updateSpotlight()` (not `applyHighlight()`) because the zoom/pan from URL are already correct. If `applyHighlight()` were called, it would recompute zoom from the highlight and overwrite the URL-provided zoom/pan, which might differ if the user manually adjusted zoom after drawing.

### 5. Clip-Path Polygon Winding Order

The spotlight's `clip-path: polygon()` requires the outer boundary to wind clockwise and the cutout to wind counterclockwise (or vice versa depending on the fill rule). Reversing the winding order makes the cutout fill solid instead of transparent. The current implementation winds outer CW, inner CCW.

### 6. Container Resize During Highlight

The highlight is stored as fractions, so it scales correctly on resize. However, `updateSpotlight()` converts fractions to screen pixels using `container.getBoundingClientRect()` at call time. The `ResizeObserver` calls `applyTransform()` which calls `updateSpotlight()`, so the spotlight tracks resize correctly. But if `getBoundingClientRect()` returns stale values during a resize animation, the spotlight may briefly lag by one frame.

### 7. Draw Layer Blocks Slider Interaction

The draw layer (z-index 3) is below the slider strip (z-index 4), so the slider remains usable while the draw layer is visible. However, the draw layer covers the same area as frame type borders (z-index 2), meaning users cannot interact with frame badges while in draw mode. This is acceptable because badges are non-interactive.

### 8. Very Small Highlight Causing Maximum Zoom

Drawing a very small rectangle (e.g. 2% x 2% of container) computes a zoom that exceeds 8x. The zoom is clamped to `MAX_ZOOM = 8`, so the rectangle will not fill the viewport. This is by design -- allowing higher zoom would make the video too pixelated.

---

## Action Items: Future Features

### Annotation Shapes

Extend highlight from a single rectangle to multiple shapes (rectangles, circles, arrows) with optional colors. Requires:
- A mini-toolbar for shape selection
- Serialization format for multiple annotations in URL params (e.g. comma-separated tuples)
- Per-shape spotlight cutouts (multiple polygon holes)

### Side-by-Side Crop Panel

Extract the highlighted region and show it in a floating panel at 1:1 pixel scale. Useful for pixel-peeping compression artifacts. Could use `canvas.drawImage()` to crop from the video element (note: this does NOT work with EME-protected content -- the browser returns black pixels).

### Edit Existing Highlight

Currently there is no way to adjust a drawn highlight without clearing and redrawing. Future options:
- Drag corners/edges to resize
- Drag interior to reposition
- Store as state that can be modified in-place

### Highlight in Non-Compare Mode

The spotlight feature currently only works in compare mode. It could be extended to the single-video view for sharing "look at this region" URLs without requiring compare mode.

### Multiple Highlights

Support drawing several highlight regions at once. Each gets its own spotlight cutout and URL encoding. Useful for comparing artifacts in multiple areas of the same frame.

---

## Action Items: Auto-Testing Approach

### Unit Tests

#### Highlight Auto-Zoom Math

Test `applyHighlight()` logic in isolation. Extract the zoom/pan computation into a pure function:

```typescript
function computeHighlightZoomPan(
  containerW: number, containerH: number,
  rect: HighlightRect,
  minZoom: number, maxZoom: number
): { zoom: number; panX: number; panY: number }
```

Test cases:
- Center rectangle -> pan should be ~0
- Small rectangle -> zoom near max
- Full-size rectangle (0,0,1,1) -> zoom stays at 1
- Edge rectangle (touching container boundary) -> pan clamped correctly
- Extremely small rectangle -> zoom clamped to MAX_ZOOM
- Wide rectangle (w >> h) -> zoom limited by width, centered vertically
- Tall rectangle (h >> w) -> zoom limited by height, centered horizontally

#### Spotlight Clip-Path Generation

Extract clip-path polygon string generation into a pure function and test:
- Highlight fully inside viewport -> standard polygon with cutout
- Highlight partially off-screen (zoomed + panned) -> clipped coordinates
- No highlight -> empty/none clip-path

#### URL Param Round-Trip

Test that highlight params survive a serialize -> parse round-trip:

```typescript
test("highlight round-trips through URL params", () => {
  const state: CompareViewState = {
    zoom: 2.5, panXFrac: 0.1, panYFrac: -0.05, sliderPct: 40,
    highlightX: 0.25, highlightY: 0.3, highlightW: 0.5, highlightH: 0.4,
  };
  const url = serializeToUrl(state);
  const parsed = parseUrlParams(url);
  expect(parsed.compareHx).toBeCloseTo(0.25, 3);
  // ... etc
});
```

### E2E Tests (Playwright)

#### Highlight Drawing and Spotlight Visibility

```
e2e/compare-highlight.spec.ts
```

Requires the DASH fixture. Test flow:
1. Load player with DASH fixture
2. Enter compare mode (right-click -> Quality compare -> Same source)
3. Pause video
4. Draw rectangle via pointer events (pointerdown + pointermove + pointerup)
5. Assert `.vp-compare-spotlight` is visible and has a non-empty `clip-path`
6. Assert `.vp-compare-highlight-border` is visible
7. Assert zoom increased from 1x (read `.vp-compare-zoom-label` text)

#### Highlight Clearing

Three sub-tests:
1. **Escape**: Draw highlight, press Escape, assert spotlight hidden, zoom label gone
2. **Double-click**: Draw highlight, double-click interact layer, assert cleared
3. **Play**: Draw highlight, click video to play, assert cleared

#### URL Persistence

1. Draw highlight
2. Copy URL via context menu -> "Copy video URL at current time"
3. Read clipboard, parse URL params
4. Assert `hx`, `hy`, `hw`, `hh` are present and within expected ranges
5. Navigate to the copied URL
6. Assert spotlight is visible with matching position

#### Draw Layer Visibility Conditions

1. Not paused -> draw layer absent (`page.locator('.vp-compare-draw').count() === 0`)
2. Paused, zoom > 1 -> draw layer absent, interact layer present
3. Paused, zoom = 1, no highlight -> draw layer present
4. Paused, zoom = 1, highlight exists -> draw layer absent

#### Minimal Movement Click-to-Play

1. Pause video in compare mode
2. Click (pointerdown + pointerup at same position) on draw layer
3. Assert video is playing (draw layer triggers play on minimal movement)

#### Slider Interaction During Draw Mode

1. Pause video at zoom 1x (draw layer visible)
2. Drag slider strip
3. Assert slider position changed (slider z-index 4 > draw z-index 3)

### Visual Regression Tests

Screenshot comparison before/after highlight drawing:
1. Capture baseline screenshot of paused compare mode
2. Draw highlight rectangle
3. Capture screenshot with spotlight + zoom
4. Compare against reference (golden image) with pixel tolerance

This would catch regressions in:
- Spotlight dimming opacity
- Border color and style
- Zoom centering accuracy
- Clip-path rendering across browsers
