# bruhstrade

Overlay your trade stats onto trading videos, entirely in the browser. Enter
symbol, P&L, direction, duration, contracts (and strike/expiration for
options), upload a video, and export an MP4 with the trade details burned in.

No backend: the overlay is drawn with Canvas and composited onto the video
with [FFmpeg.wasm](https://ffmpegwasm.netlify.app/), all client-side.

## Stack

- React 18 + Vite
- Tailwind CSS
- `@ffmpeg/ffmpeg` / `@ffmpeg/util` (FFmpeg.wasm)

## Develop

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

Outputs a static site to `dist/`, deployable to Netlify (see `netlify.toml`)
or any static host. No environment variables or backend required.

## Limits

Uploads are capped client-side at 100MB / ~2 minutes, since in-browser
FFmpeg.wasm processing gets slow/unreliable beyond that on typical hardware.
