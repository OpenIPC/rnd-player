import { useState } from "react";
import type {
  DrmDiagnosticsState,
  ContentProtectionInfo,
  HlsKeyInfo,
  PsshBox,
  TrackEncryptionInfo,
  WidevinePssh,
  PlayReadyPssh,
} from "../drm/diagnostics/types";
import { toHex } from "../drm/diagnostics/types";
import type { EmeEvent, EmeEventType } from "../drm/diagnostics/emeCapture";
import type { LicenseExchange, DecodedLicense } from "../drm/diagnostics/licenseCapture";

interface DrmDiagnosticsPanelProps {
  state: DrmDiagnosticsState;
  onClose: () => void;
  onClearEmeEvents?: () => void;
  onClearLicenseExchanges?: () => void;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="vp-drm-copy"
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }).catch(() => {});
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function CollapsibleSection({ title, defaultOpen = true, children }: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="vp-drm-section">
      <div className="vp-drm-section-header" onClick={() => setOpen((s) => !s)}>
        <span className="vp-drm-collapse-icon">{open ? "\u25be" : "\u25b8"}</span>
        {title}
      </div>
      {open && <div className="vp-drm-section-body">{children}</div>}
    </div>
  );
}

function ContentProtectionRow({ cp }: { cp: ContentProtectionInfo }) {
  return (
    <div className="vp-drm-card">
      <div className="vp-drm-row">
        <span className="vp-drm-label">Scheme URI</span>
        <span className="vp-drm-value vp-drm-mono">{cp.schemeIdUri}</span>
      </div>
      {cp.defaultKid && (
        <div className="vp-drm-row">
          <span className="vp-drm-label">Default KID</span>
          <span className="vp-drm-value vp-drm-mono">
            {cp.defaultKid} <CopyButton text={cp.defaultKid} />
          </span>
        </div>
      )}
      {cp.robustness && (
        <div className="vp-drm-row">
          <span className="vp-drm-label">Robustness</span>
          <span className="vp-drm-value">{cp.robustness}</span>
        </div>
      )}
      {cp.licenseUrl && (
        <div className="vp-drm-row">
          <span className="vp-drm-label">License URL</span>
          <span className="vp-drm-value vp-drm-mono">
            {cp.licenseUrl} <CopyButton text={cp.licenseUrl} />
          </span>
        </div>
      )}
      {cp.psshBase64 && (
        <div className="vp-drm-row">
          <span className="vp-drm-label">PSSH</span>
          <span className="vp-drm-value vp-drm-mono vp-drm-truncate">{cp.psshBase64}</span>
        </div>
      )}
    </div>
  );
}

function HlsKeyRow({ hk }: { hk: HlsKeyInfo }) {
  return (
    <div className="vp-drm-card">
      <div className="vp-drm-row">
        <span className="vp-drm-label">Method</span>
        <span className="vp-drm-value">{hk.method}</span>
      </div>
      {hk.uri && (
        <div className="vp-drm-row">
          <span className="vp-drm-label">URI</span>
          <span className="vp-drm-value vp-drm-mono vp-drm-truncate">{hk.uri}</span>
        </div>
      )}
      {hk.keyformat && (
        <div className="vp-drm-row">
          <span className="vp-drm-label">Key Format</span>
          <span className="vp-drm-value">{hk.keyformat}</span>
        </div>
      )}
      {hk.iv && (
        <div className="vp-drm-row">
          <span className="vp-drm-label">IV</span>
          <span className="vp-drm-value vp-drm-mono">{hk.iv}</span>
        </div>
      )}
    </div>
  );
}

function TrackEncryptionRow({ track }: { track: TrackEncryptionInfo }) {
  return (
    <div className="vp-drm-card">
      <div className="vp-drm-row">
        <span className="vp-drm-label">Track {track.trackId}</span>
        <span className="vp-drm-value">
          {track.scheme ? `${track.scheme} encryption` : "encrypted"}
        </span>
      </div>
      <div className="vp-drm-row">
        <span className="vp-drm-label">KID</span>
        <span className="vp-drm-value vp-drm-mono">
          {track.defaultKid} <CopyButton text={track.defaultKid} />
        </span>
      </div>
      <div className="vp-drm-row">
        <span className="vp-drm-label">IV size</span>
        <span className="vp-drm-value">{track.defaultIvSize} bytes</span>
      </div>
      {track.defaultConstantIv && (
        <div className="vp-drm-row">
          <span className="vp-drm-label">Constant IV</span>
          <span className="vp-drm-value vp-drm-mono">{track.defaultConstantIv}</span>
        </div>
      )}
    </div>
  );
}

function PsshBoxView({ box }: { box: PsshBox }) {
  const [showHex, setShowHex] = useState(false);

  return (
    <div className="vp-drm-card">
      <div className="vp-drm-row">
        <span className="vp-drm-label">System ID</span>
        <span className="vp-drm-value vp-drm-mono">{box.systemId}</span>
      </div>
      <div className="vp-drm-row">
        <span className="vp-drm-label">Version</span>
        <span className="vp-drm-value">{box.version}</span>
      </div>
      {box.keyIds.length > 0 && (
        <div className="vp-drm-row">
          <span className="vp-drm-label">KIDs</span>
          <span className="vp-drm-value vp-drm-mono">{box.keyIds.join(", ")}</span>
        </div>
      )}
      <div className="vp-drm-row">
        <span className="vp-drm-label">Data</span>
        <span className="vp-drm-value">{box.data.length} bytes</span>
      </div>
      <div className="vp-drm-row">
        <span className="vp-drm-label">Source</span>
        <span className="vp-drm-value">{box.source}</span>
      </div>

      {/* System-specific decoded view */}
      {box.decoded && "keyIds" in box.decoded && (
        <WidevinePsshView wv={box.decoded as WidevinePssh} />
      )}
      {box.decoded && "kid" in box.decoded && (
        <PlayReadyPsshView pr={box.decoded as PlayReadyPssh} />
      )}

      {/* Raw hex toggle */}
      {box.data.length > 0 && (
        <>
          <button className="vp-drm-hex-toggle" onClick={() => setShowHex((s) => !s)}>
            {showHex ? "Hide hex" : "Show hex"}
          </button>
          {showHex && (
            <div className="vp-drm-hex">
              {toHex(box.data)}
              <CopyButton text={toHex(box.data)} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function WidevinePsshView({ wv }: { wv: WidevinePssh }) {
  return (
    <div className="vp-drm-decoded">
      <div className="vp-drm-decoded-title">Widevine CENC Header</div>
      {wv.algorithm && (
        <div className="vp-drm-row">
          <span className="vp-drm-label">Algorithm</span>
          <span className="vp-drm-value">{wv.algorithm}</span>
        </div>
      )}
      {wv.keyIds.length > 0 && (
        <div className="vp-drm-row">
          <span className="vp-drm-label">Key IDs</span>
          <span className="vp-drm-value vp-drm-mono">{wv.keyIds.join("\n")}</span>
        </div>
      )}
      {wv.provider && (
        <div className="vp-drm-row">
          <span className="vp-drm-label">Provider</span>
          <span className="vp-drm-value">{wv.provider}</span>
        </div>
      )}
      {wv.contentId && (
        <div className="vp-drm-row">
          <span className="vp-drm-label">Content ID</span>
          <span className="vp-drm-value vp-drm-mono">
            {wv.contentId}
            {wv.contentIdUtf8 && ` ("${wv.contentIdUtf8}")`}
          </span>
        </div>
      )}
      {wv.policy && (
        <div className="vp-drm-row">
          <span className="vp-drm-label">Policy</span>
          <span className="vp-drm-value">{wv.policy}</span>
        </div>
      )}
      {wv.protectionScheme && (
        <div className="vp-drm-row">
          <span className="vp-drm-label">Scheme</span>
          <span className="vp-drm-value">{wv.protectionScheme}</span>
        </div>
      )}
    </div>
  );
}

function PlayReadyPsshView({ pr }: { pr: PlayReadyPssh }) {
  return (
    <div className="vp-drm-decoded">
      <div className="vp-drm-decoded-title">PlayReady Header</div>
      {pr.kid && (
        <div className="vp-drm-row">
          <span className="vp-drm-label">KID</span>
          <span className="vp-drm-value vp-drm-mono">
            {pr.kid} <CopyButton text={pr.kid} />
          </span>
        </div>
      )}
      {pr.laUrl && (
        <div className="vp-drm-row">
          <span className="vp-drm-label">License URL</span>
          <span className="vp-drm-value vp-drm-mono vp-drm-truncate">
            {pr.laUrl} <CopyButton text={pr.laUrl} />
          </span>
        </div>
      )}
      {pr.luiUrl && (
        <div className="vp-drm-row">
          <span className="vp-drm-label">License UI</span>
          <span className="vp-drm-value vp-drm-mono vp-drm-truncate">{pr.luiUrl}</span>
        </div>
      )}
      {pr.customAttributes && (
        <div className="vp-drm-row">
          <span className="vp-drm-label">Custom</span>
          <span className="vp-drm-value vp-drm-mono vp-drm-truncate">{pr.customAttributes}</span>
        </div>
      )}
    </div>
  );
}

// --- EME Timeline ---

const EME_TYPE_LABELS: Record<EmeEventType, string> = {
  "access-request": "ACCESS?",
  "access-granted": "ACCESS \u2713",
  "access-denied": "ACCESS \u2717",
  "keys-created": "KEYS",
  "keys-set": "SET",
  "generate-request": "INIT",
  "message": "MSG",
  "update": "UPDATE",
  "key-status-change": "STATUS",
  "close": "CLOSE",
  "expiration-change": "EXPIRY",
  "error": "ERROR",
};

function emeEventColor(event: EmeEvent): string {
  if (event.success === false || event.type === "error") return "#ff4444";
  if (event.type === "access-denied") return "#ffaa00";
  if (event.success === true) return "#4caf50";
  return "#e0e0e0";
}

function formatRelativeTime(ts: number, baseTs: number): string {
  const delta = ts - baseTs;
  const mins = Math.floor(delta / 60000);
  const secs = Math.floor((delta % 60000) / 1000);
  const ms = Math.floor(delta % 1000);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

function EmeEventRow({ event, baseTs }: { event: EmeEvent; baseTs: number }) {
  const [expanded, setExpanded] = useState(false);
  const color = emeEventColor(event);

  return (
    <>
      <div className="vp-drm-event" onClick={() => event.data !== undefined && setExpanded((s) => !s)}>
        <span className="vp-drm-event-time">{formatRelativeTime(event.timestamp, baseTs)}</span>
        <span className="vp-drm-event-type" style={{ color }}>{EME_TYPE_LABELS[event.type]}</span>
        <span className="vp-drm-event-detail">{event.detail}</span>
        {event.duration !== undefined && (
          <span className="vp-drm-event-latency">(+{Math.round(event.duration)}ms)</span>
        )}
      </div>
      {expanded && event.data !== undefined && (
        <div className="vp-drm-event-data">
          <pre className="vp-drm-hex">{JSON.stringify(event.data, null, 2)}</pre>
        </div>
      )}
    </>
  );
}

function EmeTimelineSection({ events, onClear }: { events: readonly EmeEvent[]; onClear?: () => void }) {
  const [copied, setCopied] = useState(false);
  const baseTs = events.length > 0 ? events[0].timestamp : 0;

  return (
    <CollapsibleSection title={`EME Events (${events.length})`} defaultOpen={true}>
      <div className="vp-drm-timeline-actions">
        {onClear && (
          <button className="vp-drm-copy" onClick={onClear}>Clear</button>
        )}
        <button
          className="vp-drm-copy"
          onClick={() => {
            const json = JSON.stringify(events, null, 2);
            navigator.clipboard.writeText(json).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }).catch(() => {});
          }}
        >
          {copied ? "Copied" : "Copy JSON"}
        </button>
      </div>
      <div className="vp-drm-timeline">
        {events.map((event) => (
          <EmeEventRow key={event.id} event={event} baseTs={baseTs} />
        ))}
      </div>
    </CollapsibleSection>
  );
}

// --- License Exchange Inspector ---

const DRM_SYSTEM_COLORS: Record<string, string> = {
  clearkey: "#4caf50",
  widevine: "#2196f3",
  fairplay: "#9c27b0",
};

function statusColor(status?: number, error?: string): string {
  if (error || !status) return "#ff4444";
  if (status >= 200 && status < 300) return "#4caf50";
  return "#ff4444";
}

function LicenseExchangeRow({ exchange }: { exchange: LicenseExchange }) {
  const [expanded, setExpanded] = useState(false);
  const systemColor = DRM_SYSTEM_COLORS[exchange.drmSystem] ?? "#e0e0e0";

  return (
    <div className="vp-drm-license" style={{ borderLeftColor: systemColor }}>
      <div className="vp-drm-license-header" onClick={() => setExpanded((s) => !s)}>
        <span className="vp-drm-license-system" style={{ color: systemColor }}>
          {exchange.drmSystem.toUpperCase()}
        </span>
        <span className="vp-drm-license-url" title={exchange.url}>{exchange.url}</span>
        {exchange.responseStatus != null ? (
          <span className="vp-drm-license-status" style={{ color: statusColor(exchange.responseStatus, exchange.error) }}>
            {exchange.responseStatus}
          </span>
        ) : exchange.error ? (
          <span className="vp-drm-license-status" style={{ color: "#ff4444" }}>ERR</span>
        ) : null}
        {exchange.durationMs != null && (
          <span className="vp-drm-license-duration">{Math.round(exchange.durationMs)}ms</span>
        )}
      </div>
      {expanded && (
        <div className="vp-drm-license-details">
          {Object.keys(exchange.requestHeaders).length > 0 && (
            <div className="vp-drm-license-subsection">
              <div className="vp-drm-decoded-title">Request Headers</div>
              {Object.entries(exchange.requestHeaders).map(([k, v]) => (
                <div key={k} className="vp-drm-row">
                  <span className="vp-drm-label">{k}</span>
                  <span className="vp-drm-value vp-drm-mono">{v}</span>
                </div>
              ))}
            </div>
          )}
          {exchange.requestBody && (
            <div className="vp-drm-license-subsection">
              <div className="vp-drm-decoded-title">Request Body</div>
              <pre className="vp-drm-license-body">{exchange.requestBody}</pre>
            </div>
          )}
          {exchange.responseBody && (
            <div className="vp-drm-license-subsection">
              <div className="vp-drm-decoded-title">Response Body</div>
              <pre className="vp-drm-license-body">{exchange.responseBody}</pre>
            </div>
          )}
          {exchange.error && (
            <div className="vp-drm-license-subsection">
              <div className="vp-drm-decoded-title" style={{ color: "#ff4444" }}>Error</div>
              <span className="vp-drm-value">{exchange.error}</span>
            </div>
          )}
          {exchange.decoded && <DecodedLicenseView decoded={exchange.decoded} />}
        </div>
      )}
    </div>
  );
}

function DecodedLicenseView({ decoded }: { decoded: DecodedLicense }) {
  return (
    <div className="vp-drm-license-decoded">
      <div className="vp-drm-decoded-title">Decoded License</div>
      <div className="vp-drm-row">
        <span className="vp-drm-label">Session</span>
        <span className="vp-drm-value vp-drm-mono">{decoded.sessionId}</span>
      </div>
      {decoded.type === "clearkey" && (
        <>
          <div className="vp-drm-row">
            <span className="vp-drm-label">Keys</span>
            <span className="vp-drm-value">{decoded.keyCount}</span>
          </div>
          <div className="vp-drm-row">
            <span className="vp-drm-label">Transport</span>
            <span className="vp-drm-value">{decoded.hasTransportKey ? "ECDH-ES+A256KW" : "plaintext"}</span>
          </div>
        </>
      )}
      {decoded.type === "widevine" && (
        <div className="vp-drm-row">
          <span className="vp-drm-label">License</span>
          <span className="vp-drm-value">{decoded.licenseSizeBytes} bytes</span>
        </div>
      )}
      {decoded.type === "fairplay" && (
        <div className="vp-drm-row">
          <span className="vp-drm-label">CKC</span>
          <span className="vp-drm-value">{decoded.ckcSizeBytes} bytes</span>
        </div>
      )}
      <div className="vp-drm-row">
        <span className="vp-drm-label">Expiry</span>
        <span className="vp-drm-value">{decoded.policy.expiry}</span>
      </div>
      <div className="vp-drm-row">
        <span className="vp-drm-label">Renewal</span>
        <span className="vp-drm-value">{decoded.policy.renewal_interval_s}s</span>
      </div>
      <div className="vp-drm-row">
        <span className="vp-drm-label">Max res</span>
        <span className="vp-drm-value">{decoded.policy.max_resolution}p</span>
      </div>
      {decoded.type !== "clearkey" && (
        <div className="vp-drm-row">
          <span className="vp-drm-label">Watermark</span>
          <span className="vp-drm-value">{decoded.hasWatermark ? "yes" : "no"}</span>
        </div>
      )}
      {decoded.type === "clearkey" && decoded.hasWatermark && (
        <div className="vp-drm-row">
          <span className="vp-drm-label">Watermark</span>
          <span className="vp-drm-value">yes</span>
        </div>
      )}
    </div>
  );
}

function LicenseExchangeSection({ exchanges, onClear }: { exchanges: readonly LicenseExchange[]; onClear?: () => void }) {
  const [copied, setCopied] = useState(false);

  return (
    <CollapsibleSection title={`License Exchanges (${exchanges.length})`} defaultOpen={true}>
      <div className="vp-drm-timeline-actions">
        {onClear && (
          <button className="vp-drm-copy" onClick={onClear}>Clear</button>
        )}
        <button
          className="vp-drm-copy"
          onClick={() => {
            const json = JSON.stringify(exchanges, null, 2);
            navigator.clipboard.writeText(json).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }).catch(() => {});
          }}
        >
          {copied ? "Copied" : "Copy JSON"}
        </button>
      </div>
      <div className="vp-drm-timeline">
        {exchanges.map((ex) => (
          <LicenseExchangeRow key={ex.id} exchange={ex} />
        ))}
      </div>
    </CollapsibleSection>
  );
}

/** Group all DRM data by system name for unified display. */
interface SystemGroup {
  systemName: string;
  contentProtections: ContentProtectionInfo[];
  psshBoxes: PsshBox[];
}

function buildSystemGroups(state: DrmDiagnosticsState): SystemGroup[] {
  const map = new Map<string, SystemGroup>();

  const getGroup = (name: string): SystemGroup => {
    let group = map.get(name);
    if (!group) {
      group = { systemName: name, contentProtections: [], psshBoxes: [] };
      map.set(name, group);
    }
    return group;
  };

  // ContentProtection entries from manifest
  if (state.manifest) {
    for (const cp of state.manifest.contentProtections) {
      getGroup(cp.systemName).contentProtections.push(cp);
    }
  }

  // PSSH boxes from manifest
  if (state.manifestPsshBoxes) {
    for (const box of state.manifestPsshBoxes) {
      getGroup(box.systemName).psshBoxes.push(box);
    }
  }

  // PSSH boxes from init segment
  if (state.initSegment?.psshBoxes) {
    for (const box of state.initSegment.psshBoxes) {
      getGroup(box.systemName).psshBoxes.push(box);
    }
  }

  return Array.from(map.values());
}

export default function DrmDiagnosticsPanel({ state, onClose, onClearEmeEvents, onClearLicenseExchanges }: DrmDiagnosticsPanelProps) {
  const systemGroups = buildSystemGroups(state);
  const hlsKeys = state.manifest?.hlsKeys ?? [];
  const tracks = state.initSegment?.tracks ?? [];
  const hasDrm = systemGroups.length > 0 || hlsKeys.length > 0 || tracks.length > 0;

  return (
    <div className="vp-drm-panel" onClick={(e) => e.stopPropagation()}>
      <button className="vp-drm-close" onClick={onClose}>
        &times;
      </button>
      <div className="vp-drm-title">DRM Diagnostics</div>

      {!hasDrm && (
        <div className="vp-drm-empty">No DRM detected in this content</div>
      )}

      {/* Per-system groups */}
      {systemGroups.map((group) => (
        <CollapsibleSection key={group.systemName} title={group.systemName}>
          {group.contentProtections.map((cp, i) => (
            <ContentProtectionRow key={`cp-${i}`} cp={cp} />
          ))}
          {group.psshBoxes.map((box, i) => (
            <PsshBoxView key={`pssh-${i}`} box={box} />
          ))}
        </CollapsibleSection>
      ))}

      {/* HLS keys (not system-grouped) */}
      {hlsKeys.length > 0 && (
        <CollapsibleSection title="HLS Keys">
          {hlsKeys.map((key, i) => (
            <HlsKeyRow key={i} hk={key} />
          ))}
        </CollapsibleSection>
      )}

      {/* Init segment track encryption (per-track, not per-system) */}
      {tracks.length > 0 && (
        <CollapsibleSection title="Track Encryption">
          {tracks.map((track) => (
            <TrackEncryptionRow key={track.trackId} track={track} />
          ))}
        </CollapsibleSection>
      )}

      {/* EME Event Timeline */}
      {(state.emeEvents?.length ?? 0) > 0 && (
        <EmeTimelineSection events={state.emeEvents!} onClear={onClearEmeEvents} />
      )}

      {/* License Exchange Inspector */}
      {(state.licenseExchanges?.length ?? 0) > 0 && (
        <LicenseExchangeSection exchanges={state.licenseExchanges!} onClear={onClearLicenseExchanges} />
      )}
    </div>
  );
}
