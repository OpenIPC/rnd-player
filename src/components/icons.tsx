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

export function InfoIcon() {
  return (
    <svg {...svgProps} fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="10" cy="10" r="8" />
      <path d="M10 9v5" strokeLinecap="round" />
      <circle cx="10" cy="6.5" r="0.5" fill="currentColor" stroke="none" />
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
