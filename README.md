# Custom Video Player

A custom video player built with React, TypeScript, and [Shaka Player](https://github.com/shaka-project/shaka-player) for adaptive streaming (DASH/HLS).

On first load the app prompts for a manifest URL — no hardcoded streams or keys are included.

Replaces native browser video controls with a dark-themed custom overlay featuring:

- **Quality switcher** — lists available renditions, supports manual selection and auto ABR
- **Playback speed selector** — 0.5x to 2x
- **Progress bar** — buffered + played ranges, click to seek
- **Volume control** — mute toggle with hover-expanding slider
- **Fullscreen** toggle
- **Auto-hide** — controls fade out after 3 seconds of inactivity during playback
- **ClearKey DRM** — auto-detects `cenc:default_KID` from the DASH manifest; prompts for a decryption key via a password-masked overlay when needed, or accepts a `clearKey` prop for programmatic use
- **Error overlay** — displays user-friendly messages for DRM, network, decode, and other playback errors

## Getting Started

```sh
npm install
npm run dev
```

Open the app, paste a DASH/HLS manifest URL, and click **Load**. If the stream is ClearKey-encrypted, you'll be prompted to enter the hex decryption key.

## Build

```sh
npm run build
```

## Stack

- [React 19](https://react.dev/) + TypeScript
- [Shaka Player](https://github.com/shaka-project/shaka-player) for adaptive bitrate streaming
- [Vite](https://vite.dev/) for dev server and bundling
