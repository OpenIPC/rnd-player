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

interface DrmDiagnosticsPanelProps {
  state: DrmDiagnosticsState;
  onClose: () => void;
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

export default function DrmDiagnosticsPanel({ state, onClose }: DrmDiagnosticsPanelProps) {
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
    </div>
  );
}
