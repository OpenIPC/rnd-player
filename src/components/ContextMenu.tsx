import { createPortal } from "react-dom";
import {
  CopyLinkIcon,
  InPointIcon,
  OutPointIcon,
  ClearMarkersIcon,
  SaveSegmentIcon,
  DownloadScriptIcon,
  SubtitleIcon,
  TranslateIcon,
  StatsNerdIcon,
  AudioLevelsIcon,
  AudioCompareIcon,
  CompareIcon,
  FilmstripIcon,
  QpHeatmapIcon,
  DrmDiagnosticsIcon,
  ManifestValidatorIcon,
} from "./icons";
import type { PlayerModuleConfig } from "../types/moduleConfig";

interface ContextMenuProps {
  position: { x: number; y: number };
  containerEl: HTMLDivElement;
  moduleConfig: PlayerModuleConfig;

  // Actions
  onCopyUrl: () => void;
  onCopyDownloadScript: () => void;
  onSetInPoint: () => void;
  onSetOutPoint: () => void;
  onClearMarkers: () => void;
  onExportMp4: () => void;
  onResetSubtitlePositions: () => void;
  onTranslationSettings: () => void;
  onToggleStats: () => void;
  onToggleAudioLevels: () => void;
  onToggleAudioCompare: (() => void) | undefined;
  onToggleCompare: (() => void) | undefined;
  onToggleFilmstrip: (() => void) | undefined;
  onToggleQpHeatmap: (() => void) | undefined;
  onToggleDrmDiagnostics: (() => void) | undefined;
  onToggleManifestValidator: (() => void) | undefined;

  // State for conditional items
  hasMarkers: boolean;
  hasInOutPoints: boolean;
  hasActiveSubtitles: boolean;
  hasSubtitlePositions: boolean;
  hasTranslateConfig: boolean;
  showStats: boolean;
  showAudioLevels: boolean;
  showAudioCompare: boolean;
  showCompare: boolean;
  showFilmstrip: boolean;
  showQpHeatmap: boolean;
  showDrmDiagnostics: boolean;
  showManifestValidator: boolean;
  validationErrorCount?: number;
  drmDiagnosticCount?: number;
  isH264: boolean;
  isH265: boolean;
  isAv1: boolean;
}

export default function ContextMenu({
  position,
  containerEl,
  moduleConfig,
  onCopyUrl,
  onCopyDownloadScript,
  onSetInPoint,
  onSetOutPoint,
  onClearMarkers,
  onExportMp4,
  onResetSubtitlePositions,
  onTranslationSettings,
  onToggleStats,
  onToggleAudioLevels,
  onToggleAudioCompare,
  onToggleCompare,
  onToggleFilmstrip,
  onToggleQpHeatmap,
  onToggleDrmDiagnostics,
  onToggleManifestValidator,
  hasMarkers,
  hasInOutPoints,
  hasActiveSubtitles,
  hasSubtitlePositions,
  hasTranslateConfig,
  showStats,
  showAudioLevels,
  showAudioCompare,
  showCompare,
  showFilmstrip,
  showQpHeatmap,
  showDrmDiagnostics,
  showManifestValidator,
  validationErrorCount,
  drmDiagnosticCount,
  isH264,
  isH265,
  isAv1,
}: ContextMenuProps) {
  return createPortal(
    <div
      className="vp-context-menu"
      style={{ left: position.x, top: position.y }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="vp-context-menu-item" onClick={onCopyUrl}>
        <CopyLinkIcon />
        Copy video URL at current time
      </div>
      {moduleConfig.segmentExport && (
        <div className="vp-context-menu-item" onClick={onCopyDownloadScript}>
          <DownloadScriptIcon />
          Copy stream download script
        </div>
      )}
      <div className="vp-context-menu-separator" />
      <div className="vp-context-menu-item" onClick={onSetInPoint}>
        <InPointIcon />
        Set in-point (I)
      </div>
      <div className="vp-context-menu-item" onClick={onSetOutPoint}>
        <OutPointIcon />
        Set out-point (O)
      </div>
      {hasMarkers && (
        <div className="vp-context-menu-item" onClick={onClearMarkers}>
          <ClearMarkersIcon />
          Clear in/out points
        </div>
      )}
      {moduleConfig.segmentExport && hasInOutPoints && (
        <div className="vp-context-menu-item" onClick={onExportMp4}>
          <SaveSegmentIcon />
          Save MP4...
        </div>
      )}
      {hasActiveSubtitles && hasSubtitlePositions && (
        <div className="vp-context-menu-item" onClick={onResetSubtitlePositions}>
          <SubtitleIcon />
          Reset subtitle positions
        </div>
      )}
      {hasActiveSubtitles && hasTranslateConfig && (
        <div className="vp-context-menu-item" onClick={onTranslationSettings}>
          <TranslateIcon />
          Translation settings
        </div>
      )}
      <div className="vp-context-menu-separator" />
      {moduleConfig.statsPanel && (
        <div className="vp-context-menu-item" onClick={onToggleStats}>
          <StatsNerdIcon />
          {showStats ? "Hide stats for nerds" : "Stats for nerds"}
        </div>
      )}
      {moduleConfig.audioLevels && (
        <div className="vp-context-menu-item" onClick={onToggleAudioLevels}>
          <AudioLevelsIcon />
          {showAudioLevels ? "Hide audio levels" : "Audio levels"}
        </div>
      )}
      {moduleConfig.audioCompare && onToggleAudioCompare && (
        <div className="vp-context-menu-item" onClick={onToggleAudioCompare}>
          <AudioCompareIcon />
          {showAudioCompare ? "Hide audio comparison" : "Audio comparison"}
        </div>
      )}
      {moduleConfig.qualityCompare && onToggleCompare && (
        <div className="vp-context-menu-item" onClick={onToggleCompare}>
          <CompareIcon />
          {showCompare ? "Hide quality comparison" : "Quality comparison"}
        </div>
      )}
      {moduleConfig.filmstrip && onToggleFilmstrip && (
        <div className="vp-context-menu-item" onClick={onToggleFilmstrip}>
          <FilmstripIcon />
          {showFilmstrip ? "Hide filmstrip" : "Filmstrip timeline"}
        </div>
      )}
      {moduleConfig.qpHeatmap && (isH264 || isH265 || isAv1) && onToggleQpHeatmap && (
        <div className="vp-context-menu-item" onClick={onToggleQpHeatmap}>
          <QpHeatmapIcon />
          {showQpHeatmap ? "Hide QP heatmap" : "QP heatmap"}
        </div>
      )}
      {moduleConfig.drmDiagnostics && onToggleDrmDiagnostics && (
        <div className="vp-context-menu-item" onClick={onToggleDrmDiagnostics}>
          <DrmDiagnosticsIcon />
          {showDrmDiagnostics ? "Hide DRM diagnostics" : "DRM diagnostics"}
          {!showDrmDiagnostics && drmDiagnosticCount != null && drmDiagnosticCount > 0 && (
            <span className="vp-drm-diag-badge">{drmDiagnosticCount}</span>
          )}
        </div>
      )}
      {moduleConfig.manifestValidator && onToggleManifestValidator && (
        <div className="vp-context-menu-item" onClick={onToggleManifestValidator}>
          <ManifestValidatorIcon />
          {showManifestValidator ? "Hide manifest validator" : "Validate manifest"}
          {!showManifestValidator && validationErrorCount != null && validationErrorCount > 0 && (
            <span className="vp-mv-badge">{validationErrorCount}</span>
          )}
        </div>
      )}
    </div>,
    containerEl,
  );
}
