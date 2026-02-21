# ABR Adaptation Toast — Technical Reference

How the player notifies users about adaptive bitrate (ABR) quality switches in Auto mode, including the two-phase confirmation system that distinguishes between the ABR decision and the actual visible change.

## The Problem

Shaka Player's `adaptation` event fires when the ABR algorithm **decides** to switch renditions, not when the new quality is actually visible. At decision time, the video element is still displaying frames from previously buffered segments. Depending on buffer depth, the visible switch can lag the decision by several seconds.

Showing "720p → 1080p" immediately on the ABR decision is misleading — the user still sees 720p for a while. The toast needs to communicate both the intent and the actual moment of change.

## Two-Phase Design

### Phase 1 — Pending (ABR decision)

Triggered by Shaka's `adaptation` event (500 ms debounce to coalesce rapid ABR hunting).

The toast appears with the "to" value and arrow **pulsing** (opacity cycles 1 → 0.4 at 1.5 s period). This communicates: "a switch is in progress but you're still watching the old quality."

Arrow symbol: `→`

### Phase 2 — Confirmed (visible on screen)

The pulsing stops, the arrow changes to `✓`, and the 4-second auto-dismiss timer begins. This communicates: "the new quality is now what you see."

## Confirmation Detection

Two strategies are used depending on whether the resolution changed:

### Resolution Changes — `resize` Event

The `HTMLVideoElement` fires a `resize` event when its intrinsic dimensions (`videoWidth` / `videoHeight`) change. This happens exactly when the decoder starts outputting frames from the new rendition.

```
adaptation fires → toast appears (pending)
       ...buffer draining...
video.resize fires, videoHeight matches target → confirmed
```

**Edge case**: if the `resize` already fired during the 500 ms debounce window, the component checks `videoEl.videoHeight` immediately after showing the toast.

**Fallback**: a buffer-ahead timeout (see below) + 1 second margin, in case `resize` never fires.

### Same-Resolution Bitrate Changes — Buffer-Ahead Heuristic

When only the bitrate changes (e.g. 1080p 5 Mbps → 1080p 2 Mbps), `videoWidth`/`videoHeight` don't change, so no `resize` event fires. The browser provides no signal for when the new bitrate's segments start rendering.

Instead, the component computes how long the old-quality buffer will take to drain:

```
bufferedAhead = video.buffered.end(currentRange) - video.currentTime
switchDelay   = max(500ms, bufferedAhead / playbackRate * 1000)
```

After `switchDelay` milliseconds, the toast transitions to confirmed. This is a heuristic — it can be off by up to one segment duration (~1–2 s) if Shaka had already started fetching an old-rendition segment before the ABR decision. For a UI notification, this accuracy is acceptable.

**Limitations**:
- If the video is paused, the buffer doesn't drain, so the timeout fires prematurely. This is cosmetic — the user isn't watching the quality change while paused.
- If `playbackRate` changes after the timeout is set, the estimate is slightly off. Acceptable for UI purposes.

## Interaction Model

| User action | Behavior |
|---|---|
| No interaction | Toast auto-dismisses 4 s after confirmation (fade-out 300 ms) |
| Hover (mouseenter) | Pins the toast — cancels auto-dismiss timer. Toast stays until clicked |
| Click | Dismisses immediately (300 ms fade-out). `stopPropagation()` prevents play/pause toggle |
| New ABR switch | Replaces current toast entirely — resets pin, confirmation, and timers |

The toast is `pointer-events: auto` so it receives hover/click events. During the exit animation, `pointer-events: none` prevents interaction with a fading element. The `.vp-adaptation-toast` class is in the container's click-to-play exclusion list.

## Event Flow

```
Shaka adaptation event
  └─ 500ms debounce
       └─ Read active variant from player.getVariantTracks()
       └─ Compare against previous variant (stored in ref)
       └─ If changed:
            ├─ Show toast (pending phase, pulsing)
            ├─ Resolution changed?
            │   ├─ Yes: listen for video resize event (+ buffer-ahead fallback)
            │   └─ No:  set buffer-ahead timeout
            └─ On confirmation:
                 ├─ Stop pulsing, show ✓
                 └─ Start 4s auto-dismiss timer
```

## Content Formatting

### Video line

```
[from resolution] [from bitrate]  →  [to resolution] [to bitrate]
```

Example: `720p 2.5 Mbps → 1080p 5.0 Mbps`

Codec names (H.264, HEVC, AV1, etc.) are shown **only when the codec changes** between from and to — which is rare in ABR switching. Raw codec strings like `avc1.4d401f` are mapped to friendly names.

### Audio line (conditional)

Shown only when the audio codec or channel count actually changed:

```
[from codec] [from channels]  →  [to codec] [to channels]
```

Example: `AAC stereo → AAC 5.1`

Channel counts are mapped: 1→mono, 2→stereo, 6→5.1, 8→7.1.

### Direction indicator

The arrow color indicates upgrade vs downgrade:
- **Green** (`rgb(74, 222, 128)`) — higher resolution or higher bitrate at same resolution
- **Amber** (`rgb(251, 191, 36)`) — lower resolution or lower bitrate at same resolution

## CSS Architecture

| Class | Purpose |
|---|---|
| `.vp-adaptation-toast` | Base styles — top-right position, z-index 25, monospace font, enter animation |
| `.vp-adaptation-pending` | Applies pulse animation to `.vp-adaptation-to` and `.vp-adaptation-arrow` |
| `.vp-adaptation-pinned` | `cursor: pointer` (indicates clickability) |
| `.vp-adaptation-exiting` | Fade-out animation, `pointer-events: none` |

Three `@keyframes`:
- `vp-adaptation-enter` — slide in from right + fade in (200 ms)
- `vp-adaptation-exit` — fade out (300 ms)
- `vp-adaptation-pulse` — opacity 1 → 0.4 → 1 (1.5 s, infinite, pending phase only)

## Component Props

| Prop | Type | Source |
|---|---|---|
| `player` | `shaka.Player` | Shaka Player instance — for `adaptation` event and `getVariantTracks()` |
| `videoEl` | `HTMLVideoElement` | For `resize` event, `buffered` ranges, `videoHeight`, `playbackRate` |

The component is only mounted when `isAutoQuality === true` (parent gates rendering in `VideoControls.tsx`). Unmounting naturally clears all state and timers.

## Why Not Just Delay the Toast?

An alternative would be to delay showing the toast until the new quality is confirmed. This was rejected because:

1. **Immediate feedback matters** — the user should know the ABR algorithm acted, even before the visible change. If bandwidth drops and the player decides to switch from 1080p to 240p, the user benefits from knowing this is coming.
2. **The pending phase is informative** — the pulsing animation communicates "this is in progress," which is a different (and more accurate) signal than "this already happened."
3. **Hover-to-pin works better with early appearance** — if the toast only appeared after buffer drain, the user might miss it during a long buffer period. Showing it early gives more time to notice and hover to pin.
