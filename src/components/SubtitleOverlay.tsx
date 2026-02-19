import { useState, useRef, useCallback, useEffect } from "react";
import type { SubCue } from "../hooks/useMultiSubtitles";
import { TranslateIcon } from "./icons";

interface TextTrackOption {
  id: number;
  language: string;
  label: string;
}

interface SubtitleOverlayProps {
  activeCues: Map<number, SubCue[]>;
  trackOrder: number[];
  controlsVisible: boolean;
  textTracks: TextTrackOption[];
  resetSignal: number;
  onCopyText?: (text: string, toast?: string) => void;
  getContextCues?: (trackId: number, time: number, count: number) => { before: SubCue[]; current: SubCue[]; after: SubCue[] };
  videoEl?: HTMLVideoElement;
}

// ── Position persistence ──
const STORAGE_KEY = "vp_subtitle_positions";

const TRACK_COLORS = [
  "#ffffff", "#ffff00", "#00ffff", "#00ff00", "#ff80ab",
  "#ffa726", "#ce93d8", "#80deea", "#c5e1a5",
];

const DRAG_THRESHOLD = 5;
const LONG_PRESS_MS = 500;
const CONTEXT_CUE_COUNT = 3;

// ── Translation ──
const TRANSLATE_SETTINGS_KEY = "vp_translate_settings";

interface TranslateSettings {
  apiKey: string;
  targetLanguage: string;
}

interface WordGroup {
  text: string;
  g: number;
}

interface TranslationEntry {
  sourceText: string;
  translation: string;
  source?: WordGroup[];
  target?: WordGroup[];
}

// Distinct bright colors for word alignment — readable on dark backgrounds,
// chosen so adjacent groups stay visually separable.
const WORD_COLORS = [
  "#ff7675", // coral
  "#74b9ff", // sky blue
  "#55efc4", // mint
  "#fdcb6e", // mustard
  "#a29bfe", // soft purple
  "#fd79a8", // pink
  "#00cec9", // teal
  "#fab1a0", // salmon
  "#81ecec", // light cyan
  "#ffeaa7", // cream
  "#6c5ce7", // indigo
  "#e17055", // terracotta
];

interface DragState {
  trackKey: string;
  trackId: number;
  startY: number;
  startBottom: number;
  moved: boolean;
  longPressed: boolean;
}

interface ContextPopup {
  trackId: number;
  before: SubCue[];
  current: SubCue[];
  after: SubCue[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function trackKey(track: TextTrackOption): string {
  return `${track.language}:${track.label}`;
}

function loadPositions(): Map<string, number> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const obj = JSON.parse(raw) as Record<string, number>;
      return new Map(Object.entries(obj));
    }
  } catch { /* corrupt or unavailable */ }
  return new Map();
}

function savePositions(positions: Map<string, number>): void {
  try {
    const obj: Record<string, number> = {};
    for (const [k, v] of positions) obj[k] = v;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  } catch { /* localStorage unavailable */ }
}

function loadTranslateSettings(): TranslateSettings | null {
  try {
    const raw = localStorage.getItem(TRANSLATE_SETTINGS_KEY);
    if (raw) return JSON.parse(raw) as TranslateSettings;
  } catch { /* ignore */ }
  return null;
}

function saveTranslateSettings(settings: TranslateSettings): void {
  try {
    localStorage.setItem(TRANSLATE_SETTINGS_KEY, JSON.stringify(settings));
  } catch { /* ignore */ }
}

function getDefaultTargetLanguage(): string {
  try {
    const code = navigator.language;
    const names = new Intl.DisplayNames([code], { type: "language" });
    return names.of(code) || code;
  } catch {
    return navigator.language;
  }
}

interface TranslateResult {
  translation: string;
  source?: WordGroup[];
  target?: WordGroup[];
}

async function callTranslateApi(
  apiKey: string,
  targetLanguage: string,
  currentText: string,
  contextBefore: string[],
  contextAfter: string[],
): Promise<TranslateResult> {
  const userLines: string[] = [];
  if (contextBefore.length > 0) {
    userLines.push("Context (do not translate):");
    for (const line of contextBefore) userLines.push(line);
    userLines.push("");
  }
  userLines.push(`Translate to ${targetLanguage}:`);
  userLines.push(`→ ${currentText} ←`);
  if (contextAfter.length > 0) {
    userLines.push("");
    userLines.push("Context (do not translate):");
    for (const line of contextAfter) userLines.push(line);
  }

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are a language learning assistant. Translate the marked subtitle line and provide word-by-word alignment to help learners see structural differences between languages.

Return a JSON object:
{
  "source": [{"text": "word(s)", "g": 0}, {"text": "word(s)", "g": 1}, ...],
  "target": [{"text": "translated word(s)", "g": 0}, {"text": "translated word(s)", "g": 1}, ...]
}

Rules:
- "source": word groups from the original line, in their original order
- "target": word groups from the translation, in ${targetLanguage} natural word order
- "g": shared group index linking corresponding source↔target pairs (same g = same meaning)
- Group multi-word expressions that translate as one unit (idioms, compound verbs, particles)
- For CJK text, split by natural word/morpheme boundaries
- Every word from both source and target must appear in exactly one group
- Preserve punctuation attached to the word it belongs to`,
        },
        { role: "user", content: userLines.join("\n") },
      ],
      temperature: 0.3,
    }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: { message: `HTTP ${resp.status}` } }));
    throw new Error(err.error?.message || `API error ${resp.status}`);
  }

  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content?.trim() || "";

  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed.source) && Array.isArray(parsed.target)) {
      const translation = parsed.target.map((w: { text: string }) => w.text).join(" ");
      return {
        translation,
        source: parsed.source.map((w: { text: string; g: number }) => ({ text: String(w.text), g: Number(w.g) })),
        target: parsed.target.map((w: { text: string; g: number }) => ({ text: String(w.text), g: Number(w.g) })),
      };
    }
  } catch { /* fall through to plain text */ }

  return { translation: content };
}

export default function SubtitleOverlay({
  activeCues,
  trackOrder,
  controlsVisible,
  textTracks,
  resetSignal,
  onCopyText,
  getContextCues,
  videoEl,
}: SubtitleOverlayProps) {
  // ── Position / drag state ──
  const [positions, setPositions] = useState<Map<string, number>>(() => loadPositions());
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [contextPopup, setContextPopup] = useState<ContextPopup | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout>>(0 as never);

  // ── Translation state ──
  const [translateSettings, setTranslateSettings] = useState<TranslateSettings | null>(() => loadTranslateSettings());
  const [showTranslateSetup, setShowTranslateSetup] = useState(false);
  const [setupTrackId, setSetupTrackId] = useState<number | null>(null);
  const [translations, setTranslations] = useState<Map<number, TranslationEntry>>(new Map());
  const [translatingTracks, setTranslatingTracks] = useState<Set<number>>(new Set());
  // Setup form fields
  const [formApiKey, setFormApiKey] = useState("");
  const [formLanguage, setFormLanguage] = useState("");
  const [formSaveKey, setFormSaveKey] = useState(false);

  // ── Refs for stable callbacks ──
  const activeCuesRef = useRef(activeCues);
  activeCuesRef.current = activeCues;
  const onCopyTextRef = useRef(onCopyText);
  onCopyTextRef.current = onCopyText;
  const getContextCuesRef = useRef(getContextCues);
  getContextCuesRef.current = getContextCues;
  const videoElRef = useRef(videoEl);
  videoElRef.current = videoEl;
  const translateSettingsRef = useRef(translateSettings);
  translateSettingsRef.current = translateSettings;

  // ── Position effects ──
  useEffect(() => { setPositions(loadPositions()); }, []);

  useEffect(() => {
    if (resetSignal > 0) {
      setPositions(new Map());
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    }
  }, [resetSignal]);

  const findTrack = useCallback(
    (trackId: number): TextTrackOption | undefined => textTracks.find((t) => t.id === trackId),
    [textTracks],
  );

  const hasSavedPosition = useCallback(
    (trackId: number): boolean => {
      const track = findTrack(trackId);
      if (!track) return false;
      return positions.has(trackKey(track));
    },
    [findTrack, positions],
  );

  // ── Pointer handlers (drag / click-to-copy / long press) ──
  const onPointerDown = useCallback(
    (e: React.PointerEvent, trackId: number) => {
      const track = findTrack(trackId);
      if (!track) return;
      const key = trackKey(track);
      const overlay = overlayRef.current;
      if (!overlay) return;

      const el = e.currentTarget as HTMLElement;
      el.setPointerCapture(e.pointerId);

      const overlayRect = overlay.getBoundingClientRect();
      const trackRect = el.getBoundingClientRect();
      const bottomPx = overlayRect.bottom - trackRect.bottom;
      const currentBottom = (bottomPx / overlayRect.height) * 100;

      dragRef.current = {
        trackKey: key, trackId,
        startY: e.clientY, startBottom: currentBottom,
        moved: false, longPressed: false,
      };

      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = setTimeout(() => {
        if (!dragRef.current || dragRef.current.moved) return;
        dragRef.current.longPressed = true;
        const fn = getContextCuesRef.current;
        const vid = videoElRef.current;
        if (fn && vid) {
          const ctx = fn(trackId, vid.currentTime, CONTEXT_CUE_COUNT);
          if (ctx.current.length > 0) setContextPopup({ trackId, ...ctx });
        }
      }, LONG_PRESS_MS);
    },
    [findTrack],
  );

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current || !overlayRef.current) return;
    if (dragRef.current.longPressed) return;

    if (!dragRef.current.moved) {
      const dy = Math.abs(e.clientY - dragRef.current.startY);
      if (dy < DRAG_THRESHOLD) return;
      clearTimeout(longPressTimerRef.current);
      dragRef.current.moved = true;
      const key = dragRef.current.trackKey;
      setPositions((prev) => prev.has(key) ? prev : new Map(prev).set(key, dragRef.current!.startBottom));
      setDraggingKey(key);
    }

    const containerHeight = overlayRef.current.clientHeight;
    if (containerHeight === 0) return;
    const deltaY = dragRef.current.startY - e.clientY;
    const deltaPct = (deltaY / containerHeight) * 100;
    const newBottom = clamp(dragRef.current.startBottom + deltaPct, 0, 85);
    const key = dragRef.current.trackKey;
    setPositions((prev) => { const n = new Map(prev); n.set(key, newBottom); return n; });
  }, []);

  const onPointerUp = useCallback(() => {
    clearTimeout(longPressTimerRef.current);
    if (!dragRef.current) return;
    const { moved, longPressed, trackId } = dragRef.current;
    dragRef.current = null;
    setDraggingKey(null);

    if (longPressed) {
      setContextPopup((popup) => {
        if (!popup) return null;
        const lines: string[] = [];
        for (const c of popup.before) lines.push(c.text);
        for (const c of popup.current) lines.push(`→ ${c.text} ←`);
        for (const c of popup.after) lines.push(c.text);
        if (lines.length > 0 && onCopyTextRef.current) onCopyTextRef.current(lines.join("\n"), "Context copied");
        return null;
      });
    } else if (moved) {
      setPositions((current) => { savePositions(current); return current; });
    } else {
      const cues = activeCuesRef.current.get(trackId);
      if (cues && onCopyTextRef.current) onCopyTextRef.current(cues.map((c) => c.text).join("\n"));
    }
  }, []);

  const onDoubleClick = useCallback(
    (trackId: number) => {
      const track = findTrack(trackId);
      if (!track) return;
      const key = trackKey(track);
      setPositions((prev) => { const n = new Map(prev); n.delete(key); savePositions(n); return n; });
    },
    [findTrack],
  );

  // ── Translation handlers ──
  const doTranslate = useCallback(async (trackId: number, settings: TranslateSettings) => {
    const vid = videoElRef.current;
    const fn = getContextCuesRef.current;
    const cues = activeCuesRef.current.get(trackId);
    if (!cues || !vid) return;

    const currentText = cues.map((c) => c.text).join("\n");
    const ctx = fn ? fn(trackId, vid.currentTime, CONTEXT_CUE_COUNT) : { before: [], current: cues, after: [] };

    setTranslatingTracks((prev) => new Set(prev).add(trackId));
    try {
      const result = await callTranslateApi(
        settings.apiKey,
        settings.targetLanguage,
        currentText,
        ctx.before.map((c) => c.text),
        ctx.after.map((c) => c.text),
      );
      setTranslations((prev) => new Map(prev).set(trackId, {
        sourceText: currentText,
        translation: result.translation,
        source: result.source,
        target: result.target,
      }));
    } catch (err) {
      if (onCopyTextRef.current) {
        onCopyTextRef.current("", `Translation failed: ${(err as Error).message}`);
      }
    } finally {
      setTranslatingTracks((prev) => { const n = new Set(prev); n.delete(trackId); return n; });
    }
  }, []);

  const onTranslateClick = useCallback((trackId: number) => {
    const settings = translateSettingsRef.current;
    if (!settings) {
      // First use — show setup; pause so the cue stays visible during onboarding
      if (videoElRef.current && !videoElRef.current.paused) videoElRef.current.pause();
      setSetupTrackId(trackId);
      const saved = loadTranslateSettings();
      setFormApiKey(saved?.apiKey || "");
      setFormLanguage(saved?.targetLanguage || getDefaultTargetLanguage());
      setFormSaveKey(!!saved);
      setShowTranslateSetup(true);
      return;
    }
    doTranslate(trackId, settings);
  }, [doTranslate]);

  const onSetupSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const key = formApiKey.trim();
    if (!key) return;
    const lang = formLanguage.trim() || getDefaultTargetLanguage();
    const settings: TranslateSettings = { apiKey: key, targetLanguage: lang };
    if (formSaveKey) {
      saveTranslateSettings(settings);
    } else {
      try { localStorage.removeItem(TRANSLATE_SETTINGS_KEY); } catch { /* ignore */ }
    }
    setTranslateSettings(settings);
    setShowTranslateSetup(false);
    if (setupTrackId !== null) doTranslate(setupTrackId, settings);
  }, [formApiKey, formLanguage, formSaveKey, setupTrackId, doTranslate]);

  // ── Render ──
  const visibleTracks = trackOrder.filter((id) => activeCues.has(id));
  if (visibleTracks.length === 0 && !showTranslateSetup) return null;

  const defaultTracks = visibleTracks.filter((id) => !hasSavedPosition(id));
  const positionedTracks = visibleTracks.filter((id) => hasSavedPosition(id));

  const getTrackColor = (trackId: number): string => {
    const index = textTracks.findIndex((t) => t.id === trackId);
    if (index < 0) return TRACK_COLORS[0];
    return TRACK_COLORS[index % TRACK_COLORS.length];
  };

  const renderTrackContent = (trackId: number) => {
    const cues = activeCues.get(trackId)!;
    const currentText = cues.map((c) => c.text).join("\n");
    const entry = translations.get(trackId);
    const showTranslation = entry && entry.sourceText === currentText;
    const isTranslating = translatingTracks.has(trackId);
    const hasWordAlign = showTranslation && entry.source && entry.target;

    return (
      <>
        <span className="vp-subtitle-inner">
          {hasWordAlign ? (
            <span className="vp-subtitle-cue">
              {entry.source!.map((w, i) => (
                <span key={i} className="vp-word" style={{ color: WORD_COLORS[w.g % WORD_COLORS.length] }}>
                  {w.text}
                </span>
              ))}
            </span>
          ) : (
            cues.map((cue, i) => (
              <span key={i} className="vp-subtitle-cue">{cue.text}</span>
            ))
          )}
          <button
            className={`vp-translate-btn${isTranslating ? " vp-translating" : ""}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onTranslateClick(trackId); }}
            title="Translate subtitle"
          >
            <TranslateIcon />
          </button>
        </span>
        {showTranslation && (
          hasWordAlign ? (
            <span className="vp-word-line vp-word-target">
              {entry.target!.map((w, i) => (
                <span key={i} className="vp-word" style={{ color: WORD_COLORS[w.g % WORD_COLORS.length] }}>
                  {w.text}
                </span>
              ))}
            </span>
          ) : (
            <span className="vp-subtitle-translation">{entry.translation}</span>
          )
        )}
      </>
    );
  };

  const trackProps = (trackId: number, extraClass?: string) => {
    const track = findTrack(trackId);
    const key = track ? trackKey(track) : String(trackId);
    const isDragging = draggingKey === key;
    return {
      key: trackId,
      className: `vp-subtitle-track${isDragging ? " vp-dragging" : ""}${extraClass ? " " + extraClass : ""}`,
      style: { "--vp-sub-color": getTrackColor(trackId) } as React.CSSProperties,
      onPointerDown: (e: React.PointerEvent) => onPointerDown(e, trackId),
      onPointerMove,
      onPointerUp,
      onDoubleClick: () => onDoubleClick(trackId),
    };
  };

  return (
    <div ref={overlayRef} className="vp-subtitle-overlay">
      {/* Default-positioned tracks */}
      {defaultTracks.length > 0 && (
        <div className={`vp-subtitle-stack${controlsVisible ? "" : " vp-subs-low"}`}>
          {defaultTracks.map((trackId) => (
            <div {...trackProps(trackId)}>
              {renderTrackContent(trackId)}
            </div>
          ))}
        </div>
      )}

      {/* Custom-positioned tracks */}
      {positionedTracks.map((trackId) => {
        const track = findTrack(trackId)!;
        const key = trackKey(track);
        const bottom = positions.get(key)!;
        const props = trackProps(trackId, "vp-subtitle-positioned");
        return (
          <div {...props} style={{ ...props.style, bottom: `${bottom}%` }}>
            {renderTrackContent(trackId)}
          </div>
        );
      })}

      {/* Long press context popup */}
      {contextPopup && (
        <div className="vp-subtitle-context-popup" style={{ "--vp-sub-color": getTrackColor(contextPopup.trackId) } as React.CSSProperties}>
          {contextPopup.before.map((cue, i) => (
            <div key={`b${i}`} className="vp-context-cue vp-context-dim">{cue.text}</div>
          ))}
          {contextPopup.current.map((cue, i) => (
            <div key={`c${i}`} className="vp-context-cue vp-context-active">
              <span className="vp-context-arrow">→</span> {cue.text} <span className="vp-context-arrow">←</span>
            </div>
          ))}
          {contextPopup.after.map((cue, i) => (
            <div key={`a${i}`} className="vp-context-cue vp-context-dim">{cue.text}</div>
          ))}
        </div>
      )}

      {/* Translation setup popup */}
      {showTranslateSetup && (
        <div className="vp-translate-backdrop" onClick={() => setShowTranslateSetup(false)}>
          <form className="vp-translate-setup" onClick={(e) => e.stopPropagation()} onSubmit={onSetupSubmit}>
            <h3 className="vp-translate-title">Translate Subtitles</h3>
            <p className="vp-translate-desc">
              Uses the OpenAI API to translate subtitle text in real-time.
              Surrounding lines are sent as context for more accurate translations.
            </p>
            <p className="vp-translate-desc">
              You need an API key from{" "}
              <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">
                platform.openai.com/api-keys
              </a>
              . Calls are billed to your OpenAI account.
            </p>

            <label className="vp-translate-label">API Key</label>
            <input
              className="vp-translate-input"
              type="password"
              value={formApiKey}
              onChange={(e) => setFormApiKey(e.target.value)}
              placeholder="sk-..."
              autoFocus
            />

            <label className="vp-translate-label">Translate to</label>
            <input
              className="vp-translate-input"
              type="text"
              value={formLanguage}
              onChange={(e) => setFormLanguage(e.target.value)}
              placeholder={getDefaultTargetLanguage()}
            />

            <label className="vp-translate-checkbox">
              <input
                type="checkbox"
                checked={formSaveKey}
                onChange={(e) => setFormSaveKey(e.target.checked)}
              />
              Remember API key in this browser
            </label>

            <div className="vp-translate-actions">
              <button type="button" className="vp-translate-cancel" onClick={() => setShowTranslateSetup(false)}>
                Cancel
              </button>
              <button type="submit" className="vp-translate-submit" disabled={!formApiKey.trim()}>
                Translate
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
