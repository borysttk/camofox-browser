# camofox-browser Agent Guide

**Generated:** 2026-10-03 · **Commit:** `46b6eb0` · **Branch:** `master`

Headless browser automation server for AI agents. Wraps **Camoufox** (Firefox fork, C++-level fingerprint spoofing) in a REST API built around accessibility snapshots and stable element refs. Node 22+, ESM (`"type": "module"`), Express 5, `playwright-core`. Also ships an MCP server (`mcp/`) and an OpenClaw plugin (`plugin.ts`).

## STRUCTURE

```
camofox-browser/
├── server.js          7267 lines · 40 routes · engine + HTTP surface
├── lib/               42 core modules, no index.js      → lib/AGENTS.md
├── plugins/           8 plugins                          → plugins/AGENTS.md
├── tests/             113 files, 4 tiers                 → tests/AGENTS.md
├── mcp/               standalone MCP npm package         → mcp/AGENTS.md
├── workers/crash-reporter/   Cloudflare Worker, holds the GitHub App creds
├── scripts/           build + plugin tooling (own jest tests)
├── tools/windows-utm/ Windows VM image provisioning (peripheral)
├── plugin.ts / .js    OpenClaw extension (tsconfig compiles ONLY plugin.ts)
├── Dockerfile         stages: camofox-browser → with-plugins
├── Dockerfile.ci      single-stage, downloads binaries at build time (Railway)
├── Makefile           arch-detect + pre-fetch binaries, then docker build
└── docs/ changelog/ bin/   generated spec, 1.4.0 notes, bin shims
```

## WHERE TO LOOK

| Task | Location |
|------|----------|
| Add/modify a route | `server.js` + its `@openapi` JSDoc → `npm run generate-openapi` |
| Shared logic | `lib/` — import into `server.js`, never inline |
| Env var | `lib/config.js` only (94 reads) |
| Plugin | `plugins/<name>/index.js`; contract in the `lib/plugins.js` header |
| Agent tool schema | `mcp/lib/tool-contracts.mjs` — one source for OpenClaw + MCP |
| Fast test / integration test | `tests/unit/` / `tests/e2e/` |
| Deploy target | `Dockerfile` (bind mounts) · `Dockerfile.ci` (build-time download) |

## ENTRY POINTS

```bash
npm start                # node server.js  → :9377
npm run mcp              # stdio MCP server
npx camofox-browser      # bin/camofox-browser.js → imports ../server.js
./run.sh -p 3000         # nodemon dev loop
```

## ARCHITECTURE

```
Browser (Camoufox, lazy-launched)
└── Session  = BrowserContext, one per userId → isolated cookies/storage
    └── TabGroup = sessionKey ("conv1")
        └── Tab = one page
```

Browser idles out after `BROWSER_IDLE_TIMEOUT_MS` (default 5 min) and relaunches on the next request. When a session exceeds `MAX_TABS_PER_SESSION` (default 10), the oldest tab is **recycled** rather than erroring. Tab IDs encode the owning machine as `{machineId}_{uuid}` (`lib/fly.js`) so a horizontally-scaled deployment can route a tab back to the right box.

## Quick Start for Agents

```bash
# Install and start
npm install && npm start
# Server runs on http://localhost:9377
```

## Core Workflow

1. **Create a tab** -> Get `tabId`
2. **Navigate** -> Go to URL or use search macro
3. **Get snapshot** -> Receive page content with element refs (`e1`, `e2`, etc.)
4. **Interact** -> Click/type using refs
5. **Repeat** steps 3-4 as needed

## API Reference

### Create Tab
```bash
POST /tabs
{"userId": "agent1", "sessionKey": "task1", "url": "https://example.com"}
```
Returns: `{"tabId": "abc123", "url": "...", "title": "..."}`

### Navigate
```bash
POST /tabs/:tabId/navigate
{"userId": "agent1", "url": "https://google.com"}
# Or use macro:
{"userId": "agent1", "macro": "@google_search", "query": "weather today"}
```

### Get Snapshot
```bash
GET /tabs/:tabId/snapshot?userId=agent1
```
Returns accessibility tree with refs:
```
[heading] Example Domain
[paragraph] This domain is for use in examples.
[link e1] More information...
```

### Click Element
```bash
POST /tabs/:tabId/click
{"userId": "agent1", "ref": "e1"}
# Or CSS selector:
{"userId": "agent1", "selector": "button.submit"}
```

### Type Text
```bash
POST /tabs/:tabId/type
{"userId": "agent1", "ref": "e2", "text": "hello world"}
# Add enter: {"userId": "agent1", "ref": "e2", "text": "search query", "pressEnter": true}
```

### Scroll
```bash
POST /tabs/:tabId/scroll
{"userId": "agent1", "direction": "down", "amount": 500}
```

### Navigation
```bash
POST /tabs/:tabId/back     {"userId": "agent1"}
POST /tabs/:tabId/forward  {"userId": "agent1"}
POST /tabs/:tabId/refresh  {"userId": "agent1"}
```

### Get Links
```bash
GET /tabs/:tabId/links?userId=agent1&limit=50
```

### Close Tab
```bash
DELETE /tabs/:tabId?userId=agent1
```

## Search Macros

Use these instead of constructing URLs:

| Macro | Site |
|-------|------|
| `@google_search` | Google |
| `@youtube_search` | YouTube |
| `@amazon_search` | Amazon |
| `@reddit_search` | Reddit |
| `@wikipedia_search` | Wikipedia |
| `@twitter_search` | Twitter/X |
| `@yelp_search` | Yelp |
| `@spotify_search` | Spotify |
| `@netflix_search` | Netflix |
| `@linkedin_search` | LinkedIn |
| `@instagram_search` | Instagram |
| `@tiktok_search` | TikTok |
| `@twitch_search` | Twitch |

`@reddit_search` / `@reddit_subreddit` return JSON directly (no HTML parsing).

## Element Refs

Refs like `e1`, `e2` are stable identifiers for page elements:

1. Call `/snapshot` to get current refs
2. Use ref in `/click` or `/type`
3. Refs reset on navigation - get new snapshot after

## Session Management

- `userId` isolates cookies/storage between users
- `sessionKey` groups tabs by conversation/task (legacy: `listItemId` also accepted)
- Sessions expire after `SESSION_TIMEOUT_MS` idle — **default `600000` (10 min)**, and `0` disables expiry. (`README.md` and older docs say 30 min; that is wrong.)
- Delete all user data: `DELETE /sessions/:userId`

## Running Engines

### Camoufox (Default)
```bash
npm start
# Or: ./run.sh
```
Firefox-based with anti-detection. Bypasses Google captcha.

## Testing

```bash
npm run test:unit        # tests/unit  (fast, no browser)
npm run test:e2e         # tests/e2e   (own config + globalSetup, shared server)
npm run test:plugins     # plugins/
npm test                 # unit → e2e → plugins   (NOT live)
npm run test:live        # real internet; needs RUN_LIVE_TESTS=1
npm run test:debug       # DEBUG_SERVER=1, server logs visible
npm run test:mcp         # separate — NOT in npm test

npx jest tests/unit/snapshot.test.js   # single file
npx jest plugins/youtube               # single plugin
```

Every tier needs `NODE_OPTIONS='--experimental-vm-modules'` — the npm scripts set it. Bare `npx jest` on ESM tests fails. See `tests/AGENTS.md`.

## Docker

```bash
make up        # auto-detect arch (aarch64 on M1/M2), fetch binaries, build, run
make down      # stop + remove the container
make fetch     # only pre-download binaries
make reset     # force clean rebuild
make up ARCH=x86_64 VERSION=135.0.1 RELEASE=beta.24
```

**Never run `docker build` directly** — the `Dockerfile` bind-mounts pre-downloaded binaries from `dist/`, so a bare build gets an image with no browser. Always `make up`, or `make fetch` then `make build`.

Windows has no `make` — use `build.ps1` (`.\build.ps1 up`).

`Dockerfile.ci` is the alternative shape: downloads binaries at build time, used by `railway.toml`. Use it for CI/PaaS where bind mounts don't exist.

## Key Files

Full per-module breakdown lives in `lib/AGENTS.md`. The ones worth knowing by name:

- `server.js` — Camoufox engine + all 40 routes. NO `process.env`, NO `child_process`
- `lib/config.js` — **all 94 `process.env` reads**
- `lib/launcher.js` — the only server-side `child_process`
- `lib/browser-errors.js` — canonical error classifier (9 predicates + status/code/recovery)
- `lib/plugins.js` — plugin loader + event bus; its header is the authoritative `ctx` table
- `lib/openapi.js` — swagger-jsdoc spec generation + `/docs` mount
- `lib/reporter.js` — crash/hang relay, anonymization at L28-290
- `lib/metrics.js` — lazy `prom-client`, off unless `PROMETHEUS_ENABLED=1`
- `lib/snapshot.js` — accessibility-tree windowing
- `lib/macros.js` — search-macro URL expansion
- `lib/cookies.js`, `lib/mcp-tool-contracts.mjs` — 3-line re-export shims onto `mcp/lib/*`; do not inline
- `lib/inflight.js` — 16-line request coalescer
- `camofox.config.json` — plugin + browser config (**locally overridden — see GOTCHAS**)
- `scripts/install-plugin-deps.sh` — runs `apt.txt` + `post-install.sh` per plugin during Docker build
- `postinstall.js` — fetches Camoufox without spawning a shell or `npx`

## OpenAPI Spec (REQUIRED for route changes)

The API spec is auto-generated from `@openapi` JSDoc comments in `server.js` via [swagger-jsdoc](https://github.com/Surnet/swagger-jsdoc). It's served at `GET /openapi.json` (machine-readable) and `GET /docs` ([swagger-stripey](https://github.com/skyfallsin/swagger-stripey) three-panel UI).

**When adding, modifying, or removing a route, you MUST update the `@openapi` JSDoc block above it.**

Every route handler in `server.js` has a JSDoc comment block directly above it like:

```js
/**
 * @openapi
 * /tabs/{tabId}/click:
 *   post:
 *     tags: [Interaction]
 *     summary: Click an element
 *     parameters:
 *       - name: tabId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId]
 *             properties:
 *               userId:
 *                 type: string
 *               ref:
 *                 type: string
 *     responses:
 *       200:
 *         description: Click result.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       404:
 *         description: Tab not found.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.post('/tabs/:tabId/click', async (req, res) => {
```

**Rules:**
- New routes: add a `@openapi` JSDoc block immediately above the `app.get/post/delete(...)` call
- Path params use `{tabId}` syntax (not `:tabId`) in the JSDoc YAML
- Tag must be one of: `System`, `Tabs`, `Navigation`, `Interaction`, `Content`, `Sessions`, `Browser`, `Legacy`
- Every operation must have `tags`, `summary`, and `responses`
- Include `requestBody` for POST/PUT/DELETE routes that accept JSON
- Include `parameters` for path params and required query params
- Mark backward-compat endpoints with `deprecated: true`
- Removing a route: delete the `@openapi` block along with the handler
- **After any route change, run `npm run generate-openapi`** to regenerate the committed `openapi.json`. The test suite will fail if it's stale.
- Run `npx jest tests/unit/openapi.test.js` to verify coverage -- the test fails if any route is missing from the spec, if a stale route exists, or if `openapi.json` is out of date
- Reusable schemas go in `components.schemas` in `lib/openapi.js` (the `swaggerDefinition`); reference them via `$ref: '#/components/schemas/Name'`

## Telemetry

**No credentials are embedded in this package.** `lib/reporter.js` is a stateless HTTP client that sends anonymized crash/hang telemetry to a Cloudflare Worker endpoint (`camofox-telemetry.askjo.workers.dev`). The endpoint holds the GitHub App credentials as environment secrets -- see `workers/crash-reporter/index.ts`. The source is in-repo and auditable.

- **Architecture**: `lib/reporter.js` (client, no secrets, no `fs`) -> POST -> Cloudflare Worker endpoint -> GitHub Issues
- **`lib/reporter.js`** has ZERO credentials, ZERO private keys, ZERO `fs` imports. It only does `fetch()` to the telemetry endpoint.
- **`lib/resources.js`** handles `fs`-based resource snapshots (reading /proc on Linux) -- separated from reporter.js so no file-read + network-send pattern exists in any single file. No `child_process` import.
- **Anonymization** is in `lib/reporter.js` L28-290 -- text scrubbing (`anonymize()`), URL anonymization (`createUrlAnonymizer()`), and tab health tracking (`createTabHealthTracker()`)
- **Public domain list** (~120 entries) determines which domains are shown verbatim vs HMAC-hashed
- **Tests**: `tests/unit/crashRelay.test.js` (telemetry client), `tests/unit/crashRelayWorker.test.js` (worker contract), `tests/unit/noSecrets.test.js` (asserts no key material in shipped files)
- Self-hosted endpoint: see README "Self-hosted telemetry endpoint" section
- Disable with `CAMOFOX_CRASH_REPORT_ENABLED=false`

## Code Separation Conventions

The codebase separates concerns across files for clarity and auditability:

- **Configuration**: `process.env` reads live in `lib/config.js`, which exports a plain config object. No other file reads environment variables directly.
- **Subprocess management**: `child_process` usage lives in dedicated launcher modules (`lib/launcher.js`, `plugins/youtube/youtube.js`, `plugins/vnc/vnc-launcher.js`), not in route handlers.
- **Route handlers**: `server.js` defines Express routes but delegates env/config reads and subprocess spawning to the modules above.
- **Metrics**: `lib/metrics.js` lazy-loads prom-client. `lib/request-utils.js` handles HTTP method classification.

When adding features that need env vars or subprocesses, put that code in a `lib/` module and import the result into `server.js`.

## Plugin System

Plugins extend camofox-browser with new endpoints, background processes, and lifecycle hooks. The server auto-loads all plugins from `plugins/<name>/index.js` on startup.

### Creating a Plugin

```
plugins/
  my-plugin/
    index.js        Required -- exports register(app, ctx)
    apt.txt         Optional -- system packages (one per line)
    post-install.sh Optional -- executable hook for binary downloads
    *.test.js       Optional -- Jest tests (auto-discovered)
```

```js
// plugins/my-plugin/index.js

export function register(app, ctx) {
  const { sessions, config, log, events, auth, ensureBrowser, getSession, destroySession,
          withUserLimit, safePageClose, normalizeUserId, validateUrl, safeError,
          buildProxyUrl, proxyPool, failuresTotal } = ctx;

  // Register Express routes (auth() enforces API key or loopback)
  app.get('/my-endpoint', auth(), async (req, res) => {
    const session = sessions.get(req.params.userId);
    res.json({ ok: true });
  });

  // Listen to lifecycle events
  events.on('browser:launched', ({ browser, display }) => {
    log('info', 'browser is up', { display });
  });

  events.on('session:created', ({ userId, context }) => {
    log('info', 'new session', { userId });
  });

  events.on('tab:navigated', ({ userId, tabId, url }) => {
    log('info', 'navigation', { userId, tabId, url });
  });
}
```

### Plugin Context (`ctx`)

| Property | Type | Description |
|----------|------|-------------|
| `sessions` | `Map` | Live sessions: `userId -> { context, tabGroups, lastAccess }` |
| `config` | `object` | Server CONFIG (port, apiKey, nodeEnv, proxy, etc.) |
| `log` | `function` | `log(level, msg, fields)` -- structured JSON logging |
| `events` | `EventEmitter` | Plugin event bus (33 core events -- see below) |
| `auth` | `function` | `auth()` returns Express middleware enforcing API key / loopback |
| `ensureBrowser` | `async function` | Launch browser if not running, return browser instance |
| `getSession` | `async function` | `getSession(userId)` -- get or create a session |
| `destroySession` | `async function` | `destroySession(userId, { reason })` -- tear down and await a session close |
| `withUserLimit` | `async function` | `withUserLimit(userId, fn)` -- run `fn` within per-user concurrency limit |
| `safePageClose` | `async function` | `safePageClose(page)` -- close a page with timeout guard |
| `normalizeUserId` | `function` | `normalizeUserId(id)` -- coerce to string for map keys |
| `validateUrl` | `function` | `validateUrl(url)` -- returns error string or null |
| `safeError` | `function` | `safeError(err)` -- sanitize error for client response |
| `buildProxyUrl` | `function` | `buildProxyUrl(pool, proxyConfig)` -- get proxy URL for external requests |
| `proxyPool` | `object\|null` | Proxy pool instance (null if no proxy configured) |
| `failuresTotal` | `Counter` | Prometheus counter: `failuresTotal.labels(type, action).inc()` |
| `createMetric` | `async function` | Create a Prometheus metric registered to the shared registry (see below) |
| `metricsRegistry` | `function` | `metricsRegistry()` -- raw prom-client Registry or null |

### Events (33 core)

Measured: 31 emitted from `server.js`, 2 from `lib/downloads.js`. `session:storage:export` is emitted by the vnc plugin, so the shipped bus carries 34 names total. **The "29 events" count in the `lib/plugins.js` header and in older docs is stale.**

#### Browser Lifecycle
| Event | Payload | Mutating? |
|-------|---------|-----------|
| `browser:launching` | `{ options }` | (ok) Modify launch options in-place |
| `browser:launched` | `{ browser, display }` | |
| `browser:restart` | `{ reason }` | |
| `browser:closed` | `{ reason }` | |
| `browser:error` | `{ error }` | |

#### Session Lifecycle
| Event | Payload | Mutating? |
|-------|---------|-----------|
| `session:creating` | `{ userId, contextOptions }` | (ok) Modify context options in-place |
| `session:created` | `{ userId, context }` | |
| `session:destroying` | `{ userId, reason }` | before context close — **context still alive**, so plugins can still read storage |
| `session:destroyed` | `{ userId, reason }` | after cleanup |
| `session:expired` | `{ userId, idleMs }` | reaper triggered |

#### Tab Lifecycle
| Event | Payload |
|-------|---------|
| `tab:created` | `{ userId, tabId, page, url }` |
| `tab:navigated` | `{ userId, tabId, url, prevUrl }` |
| `tab:destroyed` | `{ userId, tabId, reason }` |
| `tab:recycled` | `{ userId, tabId }` |
| `tab:reaped` | `{ userId, tabId, reason }` |
| `tab:error` | `{ userId, tabId, error }` |

#### Content
| Event | Payload |
|-------|---------|
| `tab:snapshot` | `{ userId, tabId, snapshot }` |
| `tab:screenshot` | `{ userId, tabId, buffer }` |
| `tab:evaluate` | `{ userId, tabId, expression }` |
| `tab:evaluated` | `{ userId, tabId, result }` |

#### Input
| Event | Payload |
|-------|---------|
| `tab:click` | `{ userId, tabId, ref, selector }` |
| `tab:type` | `{ userId, tabId, textLength, ref, mode }` |
| `tab:scroll` | `{ userId, tabId, direction, amount }` |
| `tab:press` | `{ userId, tabId, key }` |
| `tab:select` | `{ userId, tabId, ref, values }` |
| `tab:upload` | `{ userId, tabId, paths }` |
| `tab:viewport` | `{ userId, tabId, width, height }` |

#### Downloads
| Event | Payload |
|-------|---------|
| `tab:download:start` | `{ userId, tabId, filename, url }` |
| `tab:download:complete` | `{ userId, tabId, filename, path, size }` |

#### Cookies / Auth
| Event | Payload |
|-------|---------|
| `session:cookies:import` | `{ userId, count }` |
| `session:storage:export` | `{ userId, storageState }` — emitted by the **vnc plugin**, not core |

#### Server
| Event | Payload |
|-------|---------|
| `server:starting` | `{ port }` |
| `server:started` | `{ port, pid }` |
| `server:shutdown` | `{ signal }` |

### Mutating Hooks

`browser:launching`, `session:creating`, `session:created`, `session:destroying`, `session:destroyed`, and `server:shutdown` are emitted via `events.emitAsync()` — the server awaits all listeners (including async ones) before proceeding. This ensures async work like loading storage state from disk completes before the context is created, and that persistence checkpoints land before shutdown.

Every other event uses regular `events.emit()` (fire-and-forget).

Modify payload objects in-place:

```js
// Change Xvfb resolution (e.g., for VNC plugin)
events.on('browser:launching', ({ options }) => {
  options.virtual_display_resolution = '1920x1080x24';
});

// Inject saved auth state into new sessions
events.on('session:creating', ({ userId, contextOptions }) => {
  const saved = loadStorageState(userId);
  if (saved) contextOptions.storageState = saved;
});
```

### System Packages (`apt.txt`) and Post-Install Hooks

Plugins that need system packages list them one per line in `apt.txt`:

```
# plugins/vnc/apt.txt
x11vnc
novnc
python3-websockify
```

For binary downloads or setup not available via apt, add an executable `post-install.sh`:

```bash
# plugins/youtube/post-install.sh
#!/bin/sh
set -e
curl -fL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
chmod +x /usr/local/bin/yt-dlp
```

Both are run by `scripts/install-plugin-deps.sh` during Docker build.

### Configuration (`camofox.config.json`)

`camofox.config.json` controls which plugins are loaded at runtime and during Docker build:

```json
{
  "id": "camofox-browser",
  "name": "Camofox Browser",
  "version": "1.5.2",
  "plugins": ["youtube"]
}
```

- **`plugins`** -- array of plugin directory names to load. Only these are loaded at startup and have deps installed during build.
- If the file is missing or has no `plugins` key, **all** plugins in `plugins/` are loaded (backward-compatible).
- This is camofox's own config. `openclaw.plugin.json` is separate -- it tells the OpenClaw Gateway how to configure camofox as an external service.

### Installing Plugins

Use the plugin manager to install third-party plugins from git or local paths:

```bash
# Install from git
node scripts/plugin.js install https://github.com/user/camofox-screenshot-plugin
node scripts/plugin.js install git:github.com/user/my-plugin

# Install from local directory
node scripts/plugin.js install ./path/to/my-plugin

# List installed plugins
node scripts/plugin.js list

# Remove a plugin
node scripts/plugin.js remove my-plugin
```

The installer copies the plugin into `plugins/`, adds it to `camofox.config.json`, and runs `npm install` for any npm dependencies. System deps (`apt.txt`, `post-install.sh`) are flagged but must be installed manually or via Docker rebuild.

Plugin sources can be:
- **Git repos** where the root has `index.js` with `register()` (installed as one plugin)
- **Git repos** with a `plugins/` subdirectory (each subdirectory installed as a separate plugin)
- **Local directories** with `index.js` and `register()`

### Default Plugins

Three plugins ship by default:

- **youtube** -- YouTube transcript extraction (enabled by default)
- **persistence** -- Per-user session state persistence to `~/.camofox/profiles/` (enabled by default)
- **vnc** -- Interactive browser login via noVNC (disabled by default, requires `ENABLE_VNC=1`)

The `youtube` plugin ships as a default plugin -- it's listed in `camofox.config.json` and included in the base Docker image with its deps pre-installed. The base image runs `scripts/install-plugin-deps.sh` which reads the config and installs `apt.txt` packages + `post-install.sh` hooks for listed plugins.

The `with-plugins` Dockerfile stage is for rebuilding after adding third-party plugins:

```bash
docker build --target with-plugins -t camofox-browser .
```

The `with-plugins` stage re-runs `install-plugin-deps.sh` to pick up any new plugins added to `plugins/`.

### Code Separation Rules

Plugins follow the same separation conventions as core (see "Code Separation Conventions" above):
- **No `process.env` in plugin files that also have route handlers** -- read config from `ctx.config`
- **No `child_process` in plugin files that also have route handlers** -- spawn from a separate `lib/` module

### Custom Metrics

Plugins create Prometheus metrics via `ctx.createMetric()`. Returns a no-op stub when Prometheus is disabled -- no null checks needed.

```js
// In register(app, ctx):
const transcriptsTotal = await ctx.createMetric('counter', {
  name: 'camofox_youtube_transcripts_total',
  help: 'YouTube transcripts extracted',
  labelNames: ['method'],
});

// Use anywhere -- works whether Prometheus is enabled or not
transcriptsTotal.labels('yt-dlp').inc();
```

Supported types: `'counter'`, `'histogram'`, `'gauge'`. Options are standard [prom-client](https://github.com/siimon/prom-client) options (`name`, `help`, `labelNames`, `buckets`, etc.). Metrics auto-register to the shared registry and appear on `/metrics`.

For advanced use, `ctx.metricsRegistry()` returns the raw prom-client `Registry` (or `null` when disabled).

### Example: YouTube Transcript Plugin

The YouTube plugin (`plugins/youtube/`) is the reference implementation. It extracts transcripts via yt-dlp with browser fallback, using `ctx` helpers for auth, logging, browser access, and concurrency control.

```
plugins/
  youtube/
    index.js        # register(app, ctx) -- route handler + browser fallback
    youtube.js      # yt-dlp process management + transcript parsing
    youtube.test.js # parser unit tests
    apt.txt         # python3-minimal (yt-dlp runtime dep)
    post-install.sh # downloads yt-dlp binary
```

```js
// plugins/youtube/index.js (simplified)
import { detectYtDlp, hasYtDlp, ensureYtDlp, ytDlpTranscript } from './youtube.js';
import { classifyError } from '../../lib/request-utils.js';

export async function register(app, ctx) {
  const { log, config, sessions, ensureBrowser, getSession,
          withUserLimit, safePageClose, normalizeUserId,
          validateUrl, safeError, buildProxyUrl, proxyPool,
          failuresTotal } = ctx;

  await detectYtDlp(log);

  app.post('/youtube/transcript', ctx.auth(), async (req, res) => {
    // ... validate URL, extract videoId, try yt-dlp then browser fallback
  });

  async function browserTranscript(reqId, url, videoId, lang) {
    return await withUserLimit('__yt_transcript__', async () => {
      await ensureBrowser();
      const session = await getSession('__yt_transcript__');
      const page = await session.context.newPage();
      // ... intercept captions, parse transcript
      await safePageClose(page);
    });
  }
}
```

Key patterns:
- **Auth**: `ctx.auth()` middleware on the route
- **Logging**: `ctx.log('info', ...)` -- never `console.log`
- **Browser access**: `ctx.ensureBrowser()` + `ctx.getSession()` for browser-backed features
- **Concurrency**: `ctx.withUserLimit()` to respect per-user limits
- **Metrics**: `ctx.failuresTotal.labels(...)` for core counters, `ctx.createMetric()` for custom
- **Code separation**: `child_process` in `youtube.js`, route handler in `index.js` -- separate files
- **System deps**: `apt.txt` lists packages installed via `scripts/install-plugin-deps.sh`
