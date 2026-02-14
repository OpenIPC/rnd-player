const svgProps = {
  xmlns: "http://www.w3.org/2000/svg",
  width: 20,
  height: 20,
  viewBox: "0 0 20 20",
  fill: "currentColor",
} as const;

export function PlayIcon() {
  return (
    <svg {...svgProps}>
      <path d="M5 3.868v12.264a1 1 0 0 0 1.507.864l10.35-6.132a1 1 0 0 0 0-1.728L6.507 3.004A1 1 0 0 0 5 3.868z" />
    </svg>
  );
}

export function PauseIcon() {
  return (
    <svg {...svgProps}>
      <rect x="4" y="3" width="4.5" height="14" rx="1" />
      <rect x="11.5" y="3" width="4.5" height="14" rx="1" />
    </svg>
  );
}

export function VolumeHighIcon() {
  return (
    <svg {...svgProps} fill="none" stroke="currentColor" strokeWidth="1.8">
      <path
        d="M2 7.5h2.5L9 3.5v13L4.5 12.5H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1z"
        fill="currentColor"
        stroke="none"
      />
      <path d="M12 7a4 4 0 0 1 0 6" strokeLinecap="round" />
      <path d="M14.5 4.5a8 8 0 0 1 0 11" strokeLinecap="round" />
    </svg>
  );
}

export function VolumeMuteIcon() {
  return (
    <svg {...svgProps} fill="none" stroke="currentColor" strokeWidth="1.8">
      <path
        d="M2 7.5h2.5L9 3.5v13L4.5 12.5H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1z"
        fill="currentColor"
        stroke="none"
      />
      <path d="M14 7.5l4 5M14 12.5l4-5" strokeLinecap="round" />
    </svg>
  );
}

export function MonitorIcon() {
  return (
    <svg {...svgProps}>
      <rect x="2" y="3" width="16" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M7 17h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function SpeedIcon() {
  return (
    <svg {...svgProps} fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="10" cy="10" r="8" />
      <path d="M10 6v4l2.5 2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function FullscreenIcon() {
  return (
    <svg {...svgProps} fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M3 7V4a1 1 0 0 1 1-1h3M13 3h3a1 1 0 0 1 1 1v3M17 13v3a1 1 0 0 1-1 1h-3M7 17H4a1 1 0 0 1-1-1v-3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ExitFullscreenIcon() {
  return (
    <svg {...svgProps} fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M7 3v3a1 1 0 0 1-1 1H3M13 3v3a1 1 0 0 1 1 1h3M17 13h-3a1 1 0 0 0-1 1v3M3 13h3a1 1 0 0 0 1 1v3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function AudioIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={20} height={20} viewBox="0 0 24 24" fill="currentColor">
      <path fillRule="evenodd" clipRule="evenodd" d="M8 6a4 4 0 1 1 8 0v6a4 4 0 0 1-8 0V6Zm4-2.5A2.5 2.5 0 0 0 9.5 6v6a2.5 2.5 0 0 0 5 0V6A2.5 2.5 0 0 0 12 3.5Zm.749 15.46.001.04v2.25a.75.75 0 0 1-1.5 0V19l.001-.04A7.001 7.001 0 0 1 5 12a.75.75 0 0 1 1.5 0 5.5 5.5 0 1 0 11 0 .75.75 0 0 1 1.5 0 7.001 7.001 0 0 1-6.251 6.96Z" />
    </svg>
  );
}

export function SubtitleIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={20} height={20} viewBox="0 0 24 24" fill="currentColor">
      <path d="M6.25 11.5h6.5a.75.75 0 0 1 0 1.5h-6.5a.75.75 0 0 1 0-1.5ZM15.75 11.5h2a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5ZM5.5 15.75a.75.75 0 0 1 .75-.75h2a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1-.75-.75ZM11.25 16.5h6.5a.75.75 0 0 0 0-1.5h-6.5a.75.75 0 0 0 0 1.5Z" />
      <path fillRule="evenodd" clipRule="evenodd" d="M6.75 4A4.75 4.75 0 0 0 2 8.75v6.5A4.75 4.75 0 0 0 6.75 20h9.328a.25.25 0 0 1 .18.075l1.075 1.103c1.703 1.746 4.667.54 4.667-1.9V8.75A4.75 4.75 0 0 0 17.25 4H6.75ZM3.5 8.75A3.25 3.25 0 0 1 6.75 5.5h10.5a3.25 3.25 0 0 1 3.25 3.25v10.529c0 1.094-1.33 1.635-2.093.852l-1.076-1.103a1.75 1.75 0 0 0-1.253-.528H6.75a3.25 3.25 0 0 1-3.25-3.25v-6.5Z" />
    </svg>
  );
}

export function CopyLinkIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={16} height={16} viewBox="0 0 36 36" fill="currentColor">
      <path d="M5.85 18.0c0.0-2.56 2.08-4.65 4.65-4.65h6.0V10.5H10.5c-4.14 .0-7.5 3.36-7.5 7.5s3.36 7.5 7.5 7.5h6.0v-2.85H10.5c-2.56 .0-4.65-2.08-4.65-4.65zM12.0 19.5h12.0v-3.0H12.0v3.0zm13.5-9.0h-6.0v2.85h6.0c2.56 .0 4.65 2.08 4.65 4.65s-2.08 4.65-4.65 4.65h-6.0V25.5h6.0c4.14 .0 7.5-3.36 7.5-7.5s-3.36-7.5-7.5-7.5z" />
    </svg>
  );
}

export function StatsNerdIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={16} height={16} viewBox="0 0 48 48" fill="currentColor">
      <path d="M22 34h4V22h-4v12zm2-30C12.95 4 4 12.95 4 24s8.95 20 20 20 20-8.95 20-20S35.05 4 24 4zm0 36c-8.82 0-16-7.18-16-16S15.18 8 24 8s16 7.18 16 16-7.18 16-16 16zm-2-22h4v-4h-4v4z" />
    </svg>
  );
}

export function AudioLevelsIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={16} height={16} viewBox="0 0 20 20" fill="currentColor">
      <rect x="2" y="10" width="2.5" height="7" rx="1" />
      <rect x="6.5" y="6" width="2.5" height="11" rx="1" />
      <rect x="11" y="3" width="2.5" height="14" rx="1" />
      <rect x="15.5" y="8" width="2.5" height="9" rx="1" />
    </svg>
  );
}

export function FilmstripIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={16} height={16} viewBox="0 0 20 20" fill="currentColor">
      <rect x="1" y="4" width="18" height="12" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <rect x="3" y="6.5" width="4" height="3" rx="0.5" />
      <rect x="8" y="6.5" width="4" height="3" rx="0.5" />
      <rect x="13" y="6.5" width="4" height="3" rx="0.5" />
      <rect x="3" y="10.5" width="4" height="3" rx="0.5" />
      <rect x="8" y="10.5" width="4" height="3" rx="0.5" />
      <rect x="13" y="10.5" width="4" height="3" rx="0.5" />
    </svg>
  );
}

export function FrameModeIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={12} height={12} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="2" y="3" width="16" height="14" rx="2" />
      <line x1="6" y1="3" x2="6" y2="17" />
      <line x1="14" y1="3" x2="14" y2="17" />
      <circle cx="10" cy="10" r="2" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function InPointIcon() {
  return (
    <svg {...svgProps} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="7,3 3,3 3,17 7,17" />
      <line x1="3" y1="10" x2="14" y2="10" />
    </svg>
  );
}

export function OutPointIcon() {
  return (
    <svg {...svgProps} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="13,3 17,3 17,17 13,17" />
      <line x1="6" y1="10" x2="17" y2="10" />
    </svg>
  );
}

export function ClearMarkersIcon() {
  return (
    <svg {...svgProps} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <line x1="6" y1="6" x2="14" y2="14" />
      <line x1="14" y1="6" x2="6" y2="14" />
    </svg>
  );
}

export function SaveSegmentIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={16} height={16} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 3v10M6 9l4 4 4-4" />
      <path d="M3 14v2a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2" />
    </svg>
  );
}

export function CompareIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={16} height={16} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="2" y="3" width="16" height="14" rx="2" />
      <line x1="10" y1="3" x2="10" y2="17" />
      <polyline points="7,10 10,7 13,10" fill="none" />
    </svg>
  );
}

export function PipIcon() {
  return (
    <svg {...svgProps} fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="2" y="3" width="16" height="12" rx="2" />
      <rect x="10" y="8" width="7" height="5" rx="1" fill="currentColor" stroke="none" />
    </svg>
  );
}
