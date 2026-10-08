# plugins/ — Plugin System

`plugins/<name>/index.js` exports `register(app, ctx)`. `lib/plugins.js` auto-loads every dir on startup. **Its header comment is the authoritative `ctx` table + event catalog — read it before writing a plugin.**

## Tracked (upstream) plugins

| Plugin | Status | AGENTS.md | Notes |
|--------|--------|-----------|-------|
| `youtube` | default-on | ✅ | Reference implementation. yt-dlp fast path + browser fallback |
| `persistence` | default-on | ✅ | Lifecycle hooks only, no routes |
| `vnc` | **off** by default | ✅ | Needs `ENABLE_VNC=1`; interactive login, storage-state export |
| `canvas` | untracked (local) | ✅ | SSE live preview; `enableEnvVar: ENABLE_CANVAS` |

## Untracked local plugins — no AGENTS.md, undocumented upstream

Loaded because `camofox.config.json` lists them, but absent from git. **Treat as private; do not upstream without owner review.**

| Plugin | Surface | Notes |
|--------|---------|-------|
| `q-mask` | `/qmask/{status,send,state,attach}` | Injects a stable `[data-q-mask="*"]` contract via `addInitScript` on `tab:created`. `attach` uses server-side `setInputFiles` to dodge Chromium restrictions. `mask.js` is 477 lines |
| `vault-login` | `/vault-login/{handles,login,auto-fill,save,save-session}` | Largest local plugin (485 + 364 lines). Auth-vault REST API (port 5600) — SSOT; no hermes vault CLI on `127.0.0.1:5600`. **Handles credentials — never log or echo returned secrets** |
| `vision-mcp` | `/vision/{analyze,describe,ask,status}` | Screenshot analysis. OpenRouter free tier → Ollama fallback |
| `evaluate-chunked` | `/tabs/:tabId/evaluate-chunked` | Works around ~100-150 char JSON truncation on long strings |

## Creating a plugin

```
plugins/<name>/
  index.js         # register(app, ctx) — routes + hooks
  plugin.json      # optional: { name, version, description, enableEnvVar }
  apt.txt          # optional: system packages, one per line
  post-install.sh  # optional: executable, binary downloads
  *.test.js        # optional: auto-discovered by jest.config.cjs
```

`plugin.json.enableEnvVar` lets a plugin self-enable from the environment without editing config (`ENABLE_CANVAS=1`).

## Enabling

`camofox.config.json` accepts **both** shapes — `lib/plugins.js` and `scripts/install-plugin-deps.sh` both branch on `Array.isArray`:

```jsonc
"plugins": ["youtube", "persistence"]              // array form
"plugins": { "youtube": { "enabled": true } }      // object form
```

A plugin is skipped when its value is `false` or its `enabled` is `false`. No `plugins` key at all → every dir in `plugins/` loads.

## Anti-patterns

- **No `process.env` in a file that has route handlers.** Read from `ctx.config`. The only plugin exceptions are the dedicated launcher modules (`youtube.js`, `vnc-launcher.js`) — `tests/unit/security.test.js` enforces this.
- **No `child_process` in a file that has route handlers.** Spawn from a sibling module.
- Register auth with `ctx.auth()` on every route. `canvas`/`q-mask`/`vault-login`/`vision-mcp` currently ship **without** auth — they assume tailnet-only reachability. Do not copy that pattern for anything internet-facing.
- Do not add `@openapi` JSDoc to plugin routes. The spec generator scans `server.js` only; `tests/unit/openapi.test.js` fails on stale specs.
- `apt.txt`/`post-install.sh` only run during Docker build via `scripts/install-plugin-deps.sh`. Local `npm install` skips them.

## Install / remove

```bash
node scripts/plugin.js install <git-url | ./local-path>
node scripts/plugin.js list
node scripts/plugin.js remove <name>
```

Copies into `plugins/`, adds to `camofox.config.json`, runs `npm install` for plugin deps. System deps are flagged but **not** installed — that needs a Docker rebuild.

## Gotchas

- `evaluate-chunked` registers a route under the core `/tabs/` prefix. Any core change to that path shape breaks it silently.
- `plugins/*/index.js` files here are ESM like core; `plugins/vnc/vnc-watcher*.sh` must stay LF (`.gitattributes` enforces this).