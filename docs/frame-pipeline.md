# Save Frame Pipeline

The "Save frame" feature must capture the exact frame the user sees in the filmstrip. This is non-trivial because the filmstrip thumbnails come from the **lowest-quality** stream (e.g. 240p) while saving uses the **active** stream (e.g. 1080p), and these streams can have different composition time offsets.

**The problem**: CTS-based matching fails across streams. If the 240p stream has no B-frames (CTTS offset=0) and the 1080p stream uses IBBP (CTTS offset=2), frame N has CTS `N/fps` in one stream but `(N+2)/fps` in the other. Sending a CTS time from the thumbnail stream to the active stream produces systematic off-by-N errors.

**The solution**: Position-based frame identification. Instead of sending a CTS timestamp, the component computes a **normalized frame position** (0.0 = first frame, 1.0 = last frame) from the bitmap array index, and the worker maps it to a display-order output index in whatever stream it decodes from. Display-order frame indices are consistent across renditions of the same segment.

Pipeline steps:
1. **Paint loop** draws bitmap at `arrIdx = round(slotJ / (slotCount-1) * (intraCount-1))`
2. **Context menu** computes `framePosition = arrIdx / (intraCount-1)` — a stream-independent 0..1 value
3. **Worker** receives `framePosition`, computes `targetIdx = round(position * (totalFrames-1))`, captures the Nth VideoDecoder output

For **packed mode** (one thumbnail per segment), `framePosition = 0` (the I-frame / first frame).

## Frame Analysis Pitfalls

Things to watch out for when working with frame-level video data:

- **Composition time offsets (CTTS)**: With B-frame reordering, mp4box CTS values are shifted by N frame durations past the segment start time. Never compute frame CTS as `segStart + frameIdx / fps` — always use actual CTS from mp4box samples. This shift varies by encoder and GOP structure.
- **Cross-stream CTS mismatch**: The thumbnail stream and active stream may have different CTTS offsets (e.g. 240p IPP offset=0 vs 1080p IBBP offset=2). Never use CTS from one stream to identify frames in another. Use normalized frame position (0..1) instead — display-order frame indices are consistent across renditions.
- **Decode order ≠ display order**: mp4box returns samples in decode (DTS) order. VideoDecoder outputs in display (CTS) order. The `classifyFrameTypes` heuristic works on decode order but returns results sorted by CTS.
- **Different renditions, different GOPs**: A 240p stream may use IPP structure while the 1080p stream uses IBBP. Always classify frame types from the active (watched) stream, not the thumbnail stream.
- **VideoDecoder output counting**: When feeding ALL samples to a one-shot decoder for save-frame, output counting by display-order index is reliable and preferred over CTS matching (which breaks across streams). For partial feeds or streaming decode, use timestamp matching instead.
- **Filmstrip click time ≠ frame CTS**: The pixel-to-time conversion from a filmstrip click gives a timeline position, not a frame's actual CTS. The context menu maps click position → slot → arrIdx → framePosition, bypassing CTS entirely for the save path.
- **Packed vs gap mode**: At low zoom the filmstrip shows one I-frame per segment (packed); zoomed in it shows multiple intra-frames per segment (gap). Packed mode always saves the first frame (position=0); gap mode computes position from the slot's bitmap array index.
- **Frame-step seek epsilon**: The ArrowRight/ArrowLeft handlers in `useKeyboardShortcuts.ts` add `FRAME_SEEK_EPSILON = 0.001` (1 ms) to the computed seek target. Without this, Firefox's MSE implementation lands slightly *before* the exact frame boundary (`N/fps - epsilon`), displaying frame N-1 instead of N. At 30 fps (33 ms/frame), 1 ms cannot overshoot: `Math.round((N/fps + 0.001) * fps) = N`. The epsilon is safe for consecutive steps — no drift accumulates because each step recomputes `Math.round(currentTime * fps)` to snap to the current frame before adding ±1. Do not remove it without verifying Firefox OCR tests pass.
