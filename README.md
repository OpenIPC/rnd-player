# Custom Video Player

A custom video player built with React, TypeScript, and [Shaka Player](https://github.com/shaka-project/shaka-player) for adaptive streaming (DASH/HLS).

Replaces native browser video controls with a dark-themed custom overlay featuring:

- **Quality switcher** — lists available renditions, supports manual selection and auto ABR
- **Playback speed selector** — 0.5x to 2x
- **Progress bar** — buffered + played ranges, click to seek
- **Volume control** — mute toggle with hover-expanding slider
- **Fullscreen** toggle
- **Auto-hide** — controls fade out after 3 seconds of inactivity during playback

## Getting Started

```sh
npm install
npm run dev
```

## Build

```sh
npm run build
```

## Stack

- [React 19](https://react.dev/) + TypeScript
- [Shaka Player](https://github.com/shaka-project/shaka-player) for adaptive bitrate streaming
- [Vite](https://vite.dev/) for dev server and bundling
