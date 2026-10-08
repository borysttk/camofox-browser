# lib/ — Core Module Layer

42 flat ESM modules, no `index.js`. `server.js` imports ~35 of them at the top. Pure logic only — no Express handlers.

## Two rules that explain the module count

**1. `process.env` reads live only in `lib/config.js`** (94 reads — by far the densest file in the repo). Everything else takes values via `loadConfig()` / `ctx.config`.

**2. The OpenClaw scanner flags certain same-file combinations.** Several modules exist *only* to break those pairings. Do not merge them back:

| Module | Split from | Scanner concern |
|--------|-----------|-----------------|
| `lib/resources.js` | `reporter.js` | `fs` reads + network send must not coexist in one file |
| `lib/images.js` | `downloads.js` | in-page evaluate + DOM extraction |
| `lib/request-utils.js` | `metrics.js` | HTTP classification separated from Prometheus |
| `lib/cookies.js` | — | 3-line re-export of `mcp/lib/cookies.mjs` |
| `lib/mcp-tool-contracts.mjs` | — | 3-line re-export of `mcp/lib/tool-contracts.mjs` |
| `scripts/exec.js` | — | re-exports `child_process` so callers never contain the module name |

## Module groups

**Config & auth** — `config.js` (all env reads) · `auth.js` (`requireAuth`, `accessKeyMiddleware`) · `plugin-capabilities.js` (virtual-display registry)

**Browser lifecycle** — `launcher.js` (the only server-side `child_process`) · `camoufox-executable.js` / `camoufox-download.js` (external binary + fetch) · `browser-identity.js` / `browser-key.js` · `new-page-recovery.js` (recreate one user's dead context, retry once) · `page-lease.js` (track pages outside tab groups so reapers don't reap live sessions) · `browser-errors.js` (17 predicates + status/code/recovery mapping — the canonical error classifier)

**Process ownership & cleanup** — `process-ownership.js` · `browser-processes.js` · `windows-processes.js` (Windows tree kill, separately tested on `windows-latest` CI) · `tmp-cleanup.js` (orphan temp files, stale Firefox profiles, Xvfb display files)

**Networking** — `proxy.js` (277 lines; provider registry, Decodo backconnect, sticky sessions) · `fly.js` (tab IDs encode `{machineId}_{uuid}` for horizontal scale) · `search-fallbacks.js` · `google-serp.js`

**Content extraction** — `snapshot.js` (windowing + tail-link preservation) · `page-structure.js` · `extract.js` (JSON-Schema → refs) · `downloads.js` · `macros.js` · `select-option.js` · `visible-selector.js` · `interactive-roles.js` · `upload-paths.js`

**Observability** — `metrics.js` (lazy `prom-client`, off unless `PROMETHEUS_ENABLED=1`; `createMetric` returns a no-op stub so callers need no null checks) · `tracing.js` · `reporter.js` (1107 lines — anonymization L28-290 + GitHub Issue relay) · `resources.js` · `sentry.js` (must stay safe when `@sentry/node` is absent or `SENTRY_DSN` unset) · `request-utils.js` · `persistence.js` · `inflight.js` (16 lines — request coalescing)

**Plugin system** — `plugins.js` — its header comment is the **authoritative** event catalog and `ctx` table. Read it before writing a plugin.

## Anti-patterns

- Never add `process.env` outside `config.js` — `tests/unit/config.test.js` and `noSecrets.test.js` assert this.
- Never add `child_process` outside `launcher.js`, `plugins/youtube/youtube.js`, `plugins/vnc/vnc-launcher.js`, `plugins/vnc/spawn.js`, `plugins/vault-login/index.js`.
- Never put an `fs` read and a network send in the same new module.
- Never hardcode a version already owned by `package.json` — `tests/unit/syncVersion.test.js` fails on drift.
- Don't collapse the re-export shims (`cookies.js`, `mcp-tool-contracts.mjs`); they keep core and `@askjo/camofox-browser-mcp` on one source of truth.

## Gotchas

- `server.js` imports `fs` directly — the "no fs in route handlers" rule is about `lib/reporter.js` vs `lib/resources.js`, not a blanket ban.
- `lib/config.js.bak` sits untracked in this working tree. Ignore it; never import it.
- `lib/plugins.js` header still says "29 events" — stale. Verified: 31 emitted from `server.js`, 2 from `lib/downloads.js` (`tab:download:*`) = **33 core**, plus `session:storage:export` emitted by the vnc plugin.