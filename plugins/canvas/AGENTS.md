# Canvas Plugin — Live Preview Module

Real-time visual preview of browsed content. Streams Playwright screenshots
via SSE to an interactive HTML canvas page.

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/canvas/:userId/frame` | ✅ | Raw PNG screenshot (first active tab) |
| `GET` | `/canvas/:userId/frame/base64` | ✅ | Base64 PNG as JSON `{base64, ts, tabId, bytes}` |
| `GET` | `/canvas/:userId/stream` | ✅ | SSE frame stream (pushes every 2s SD / 5s HD) |
| `GET` | `/canvas/:userId/preview` | ✅ | Interactive HTML canvas preview page |
| `GET` | `/canvas/status` | ❌ | Module health `{ok, version, activeUsers, framesDelivered}` |

## Stream Events (SSE)

```
event: frame
data: {"base64":"iVBOR...","ts":"2026-06-30T23:00:00Z","tabId":"abc123","bytes":128000,"frame":42}
```

- `frame` — new screenshot available
- `noop` — no active tab (keepalive)
- `error` — transient error

## Preview Page Controls

- **Space** — Pause/Resume live feed
- **F** — Toggle fullscreen
- **Q** — Toggle quality (SD 2s / HD 5s)

## Architecture

```
Browser (Playwright page)
  ↓ page.screenshot({type:'png'})
Canvas Plugin (index.js)
  ↓ SSE stream
Preview Page (public/preview.html)
  ↓ Canvas / <img> render
User sees live preview
```

No VNC / Xvfb dependency. Uses Playwright's built-in screenshot API.
Works with any Camoufox or Chromium engine.

## Configuration

```jsonc
// camofox.config.json
{
  "plugins": {
    "canvas": {
      "enabled": true,
      "frameInterval": 2000,    // ms between frames (SD)
      "keepaliveInterval": 15000 // ms between SSE heartbeats
    }
  }
}
```

Environment variables:
- `ENABLE_CANVAS=1` — enable plugin
- `CANVAS_FRAME_INTERVAL=2000` — frame interval
- `CANVAS_KEEPALIVE_INTERVAL=15000` — keepalive interval

## Files

- `index.js` — Plugin registration (routes + SSE logic)
- `public/preview.html` — Interactive preview page (inline HTML/CSS/JS)
- `plugin.json` — Plugin metadata
