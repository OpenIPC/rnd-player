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
