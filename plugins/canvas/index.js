/**
 * Canvas plugin for camofox-browser.
 *
 * Live preview module — streams browser screenshots via SSE
 * so agents and humans can see what's on the screen in real time.
 *
 * Architecture:
 *   SSE endpoint pushes PNG frames (base64) every 2 seconds.
 *   Auto-discovers the first active tab per userId.
 *   No VNC / Xvfb dependency — uses Playwright page.screenshot().
 *
 * Endpoints:
 *   GET /canvas/:userId/frame       → raw PNG
 *   GET /canvas/:userId/frame/base64 → JSON {base64, ts, tabId}
 *   GET /canvas/:userId/stream      → SSE frame stream
 *   GET /canvas/:userId/preview     → HTML canvas preview page
 *   GET /canvas/status              → module health
 *
 * Configuration (camofox.config.json):
 *   {
 *     "plugins": {
 *       "canvas": {
 *         "enabled": true,
 *         "frameInterval": 2000,
 *         "keepaliveInterval": 15000
 *       }
 *     }
 *   }
 *
 * Or via environment variables:
 *   ENABLE_CANVAS=1
 *   CANVAS_FRAME_INTERVAL=2000
 */

import { requireAuth } from '../../lib/auth.js';

// ── No-op auth for internal canvas endpoints ───────────
// Canvas is an internal tailnet tool — restore by changing
// canvasAuth to `requireAuth(config)` when exposing externally.
function canvasAuth(req, res, next) { next(); }

// ── Helpers ──────────────────────────────────────────────

function normalizeUserId(raw) {
  return String(raw).trim();
}

/**
 * Find the first active tab for a user across all tab groups.
 * Returns { tabId, tabState, session } or null.
 */
function getFirstActiveTab(sessions, userId) {
  const uid = normalizeUserId(userId);
  const session = sessions.get(uid);
  if (!session) return null;
  for (const group of session.tabGroups.values()) {
    for (const [tabId, tabState] of group) {
      return { tabId, tabState, session };
    }
  }
  return null;
}

function jsonDate(ts) {
  return (ts instanceof Date ? ts : new Date()).toISOString();
}

// ── Plugin registration ──────────────────────────────────

export async function register(app, ctx, pluginConfig = {}) {
  const { events, config, log, sessions, safeError } = ctx;

  // Resolve config
  const frameInterval = pluginConfig.frameInterval || 2000;
  const keepaliveInterval = pluginConfig.keepaliveInterval || 15000;

  log('info', 'canvas plugin: enabled', { frameInterval, keepaliveInterval });

  // Stats counter
  let frameCounter = 0;

  // Auth middleware (no-op for internal use)
  const _auth = requireAuth(config); // kept for reference

  // ── GET /canvas/status ──────────────────────────────────

  app.get('/canvas/status', async (req, res) => {
    try {
      let activeUsers = 0;
      let activeTabs = 0;
      for (const [uid, session] of sessions) {
        let hasTab = false;
        for (const group of session.tabGroups.values()) {
          if (group.size > 0) {
            hasTab = true;
            activeTabs += group.size;
          }
        }
        if (hasTab) activeUsers++;
      }

      res.json({
        ok: true,
        version: '1.0.0',
        activeUsers,
        activeTabs,
        framesDelivered: frameCounter,
        frameInterval,
      });
    } catch (err) {
      log('error', 'canvas/status failed', { error: err.message });
      res.status(500).json({ ok: false, error: safeError(err) });
    }
  });

  // ── GET /canvas/:userId/frame ───────────────────────────

  app.get('/canvas/:userId/frame', canvasAuth, async (req, res) => {
    try {
      const found = getFirstActiveTab(sessions, req.params.userId);
      if (!found) {
        return res.status(404).json({ error: 'No active tab for this user' });
      }

      const { tabState, tabId, session } = found;
      session.lastAccess = Date.now();

      const buffer = await tabState.page.screenshot({ type: 'png' });
      events.emit('canvas:frame', { userId: req.params.userId, tabId });

      res.set('Content-Type', 'image/png');
      res.set('X-Cache-TabId', tabId);
      res.send(buffer);
    } catch (err) {
      log('error', 'canvas/frame failed', { reqId: req.reqId, error: err.message });
      handleRouteError(err, req, res, safeError, log);
    }
  });

  // ── GET /canvas/:userId/frame/base64 ────────────────────

  app.get('/canvas/:userId/frame/base64', canvasAuth, async (req, res) => {
    try {
      const found = getFirstActiveTab(sessions, req.params.userId);
      if (!found) {
        return res.status(404).json({ error: 'No active tab for this user' });
      }

      const { tabState, tabId, session } = found;
      session.lastAccess = Date.now();

      const buffer = await tabState.page.screenshot({ type: 'png' });
      const base64 = buffer.toString('base64');
      events.emit('canvas:frame', { userId: req.params.userId, tabId });

      res.json({
        base64,
        ts: jsonDate(),
        tabId,
        bytes: buffer.length,
      });
    } catch (err) {
      log('error', 'canvas/frame/base64 failed', { reqId: req.reqId, error: err.message });
      handleRouteError(err, req, res, safeError, log);
    }
  });

  // ── GET /canvas/:userId/stream (SSE) ────────────────────

  app.get('/canvas/:userId/stream', canvasAuth, async (req, res) => {
    const userId = req.params.userId;
    log('info', 'canvas stream: client connected', { userId, reqId: req.reqId });

    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Send initial comment (bootstrap)
    res.write(`:canvas stream started for ${userId}\n\n`);

    let intervalId = null;
    let keepaliveId = null;
    let closed = false;

    async function sendFrame() {
      if (closed) return;
      try {
        const found = getFirstActiveTab(sessions, userId);
        if (!found) {
          // No active tab — send a noop event
          res.write(`event: noop\ndata: {"error":"no_active_tab","ts":"${jsonDate()}"}\n\n`);
          return;
        }

        const { tabState, tabId, session } = found;
        session.lastAccess = Date.now();

        const buffer = await tabState.page.screenshot({ type: 'png' });
        frameCounter++;

        const payload = JSON.stringify({
          base64: buffer.toString('base64'),
          ts: jsonDate(),
          tabId,
          bytes: buffer.length,
          frame: frameCounter,
        });

        res.write(`event: frame\ndata: ${payload}\n\n`);
        events.emit('canvas:frame', { userId, tabId });
      } catch (err) {
        if (!closed) {
          log('error', 'canvas stream frame error', { userId, error: err.message });
          try {
            res.write(`event: error\ndata: {"error":"${String(err.message).replace(/"/g, '\\"')}","ts":"${jsonDate()}"}\n\n`);
          } catch (_) { /* ignore write errors after close */ }
        }
      }
    }

    // Push frames on interval
    intervalId = setInterval(sendFrame, frameInterval);

    // Keepalive (prevents proxy timeouts)
    keepaliveId = setInterval(() => {
      if (!closed) {
        try { res.write(': heartbeat\n\n'); } catch { cleanup(); }
      }
    }, keepaliveInterval);

    // Send first frame immediately
    sendFrame();

    // Cleanup on disconnect
    function cleanup() {
      if (closed) return;
      closed = true;
      if (intervalId) clearInterval(intervalId);
      if (keepaliveId) clearInterval(keepaliveId);
      log('info', 'canvas stream: client disconnected', { userId, framesDelivered: frameCounter });
    }

    req.on('close', cleanup);
    req.on('error', cleanup);
  });

  // ── GET /canvas/:userId/preview ─────────────────────────

  app.get('/canvas/:userId/preview', canvasAuth, async (req, res) => {
    try {
      const userId = req.params.userId;
      const quality = req.query.quality === 'hd' ? 'hd' : 'sd';

      // Read and serve the preview HTML
      const { readFileSync } = await import('fs');
      const { fileURLToPath } = await import('url');
      const path = await import('path');

      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const htmlPath = path.join(__dirname, 'public', 'preview.html');

      let html;
      try {
        html = readFileSync(htmlPath, 'utf-8');
      } catch {
        // Fallback inline HTML if file not found
        html = buildFallbackPreview(userId, quality, log);
      }

      // Inject user data
      html = html
        .replace('__CANVAS_USER_ID__', userId)
        .replace('__CANVAS_QUALITY__', quality);

      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    } catch (err) {
      log('error', 'canvas/preview failed', { error: err.message });
      res.status(500).json({ error: safeError(err) });
    }
  });

  log('info', 'canvas plugin: registered 5 endpoints');
}

// ── Error handler helper ──────────────────────────────────

function handleRouteError(err, req, res, safeError, log) {
  const statusCode = err.name === 'TimeoutError' ? 504 : 500;
  const message = err.name === 'TimeoutError'
    ? 'Screenshot timed out — page may be loading or unresponsive'
    : safeError(err);
  log('error', 'canvas route error', {
    reqId: req.reqId,
    method: req.method,
    path: req.path,
    statusCode,
    error: err.message,
  });
  res.status(statusCode).json({ error: message });
}

// ── Fallback HTML (if preview.html not found) ────────────

function buildFallbackPreview(userId, quality, log) {
  log('warn', 'canvas preview: preview.html not found, using fallback');
  const interval = quality === 'hd' ? 5000 : 2000;
  return `<!DOCTYPE html>
<html lang="pl" class="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Canvas — ${userId}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a1a;color:rgba(255,255,255,0.9);font-family:system-ui,sans-serif;display:flex;flex-direction:column;min-height:100dvh}
#canvas-wrap{flex:1;position:relative;overflow:hidden;background:#000}
#cv{width:100%;height:100%;object-fit:contain;display:block}
#info{position:fixed;bottom:16px;right:16px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);backdrop-filter:blur(12px);border-radius:12px;padding:12px 18px;font-size:13px;z-index:10}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
.dot.green{background:#00d4aa;box-shadow:0 0 6px #00d4aa}
.dot.red{background:#ff4444;box-shadow:0 0 6px #ff4444}
</style>
</head>
<body>
<div id="canvas-wrap"><img id="cv" alt="browser preview"></div>
<div id="info"><span id="dot" class="dot red"></span><span id="status">connecting…</span></div>
<script>
const userId='${userId}',interval=${interval};
const img=document.getElementById('cv'),dot=document.getElementById('dot'),st=document.getElementById('status');
let paused=false,loading=false;
async function refresh(){if(paused||loading)return;loading=true;try{
const r=await fetch('/canvas/'+userId+'/frame/base64');const d=await r.json();
if(d.base64){img.src='data:image/png;base64,'+d.base64;dot.className='dot green';st.textContent='live '+new Date(d.ts).toLocaleTimeString()}
}catch(e){dot.className='dot red';st.textContent='error'}finally{loading=false}}
let iv=setInterval(refresh,interval);refresh();
document.addEventListener('keydown',e=>{if(e.key===' '){e.preventDefault();paused=!paused;st.textContent=paused?'paused':'live'}})
</script>
</body>
</html>`;
}
