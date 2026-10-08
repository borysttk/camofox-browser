# mcp/ — Standalone MCP Server

`@askjo/camofox-browser-mcp` — a **separate, independently installable npm package** with its own `package.json` and lockfile. Exposes the camofox REST API as 11 MCP tools over stdio.

Does **not** launch a browser or require Playwright/camoufox. It proxies to an already-running camofox REST server (`npm start`).

## Files

| File | Role |
|------|------|
| `server.mjs` | stdio transport, tool dispatch. Reads version from `mcp/package.json`, never hardcoded |
| `lib/tool-contracts.mjs` | **Canonical contracts.** `TOOL_DEFS`, `buildRequest`, `runTool`, `adaptResponse`, `authHeaders`, `fetchSpec` |
| `lib/cookies.mjs` | Netscape cookie-file parsing + path containment |
| `lib/config.mjs` | `loadMcpConfig()` — 4 env vars, no core import |
| `scripts/test-mcp*.mjs` | Contract + packaged-install tests |

## Single-source-of-truth chain

```
mcp/lib/tool-contracts.mjs        <- canonical, 17KB, ships in this package
        ^
        | re-export (3-line shim)
lib/mcp-tool-contracts.mjs
        ^
        | imported by BOTH
plugin.ts (OpenClaw)  +  plugin.js (built)
```

Tool names, JSON-Schema params, REST routes, request bodies, auth semantics, and response shaping **cannot drift** between the OpenClaw plugin and MCP — both import the same module. This is the reason the shim exists; do not inline or duplicate contract data.

## Auth model

Mirrors `lib/auth.js`:
- `CAMOFOX_ACCESS_KEY` — global superkey. Forwarded as `Authorization: Bearer` on every request.
- `CAMOFOX_API_KEY` — cookie-import gate only.

Each contract declares `auth: 'accessKey' | 'apiKey' | 'none'` and `responseKind: 'json' | 'snapshot' | 'image'`, so the host's fetch and response-adaptation layers stay declarative. **Adding a tool means adding a `TOOL_DEFS` entry — never hand-roll a fetch in `server.mjs`.**

## Anti-patterns

- **Never import core config here.** `lib/config.mjs` must stay dependency-free so the package installs without `@askjo/camofox-browser`. It deliberately re-reads 4 env vars instead of calling `loadConfig()`.
- Never duplicate a tool definition, route, or schema literal outside `tool-contracts.mjs`.
- Never launch the browser from `server.mjs` — forward only.
- Never hardcode the version; read `mcp/package.json`.

## Version sync

`mcp/package.json` version is rewritten by `npm version` via `scripts/sync-version.js` (alongside `openclaw.plugin.json`). `tests/unit/syncVersion.test.js` fails on drift.

## Commands

```bash
npm run mcp                       # run the MCP server on stdio
npm run test:mcp                  # npm ci in mcp/ + contract tests + packaged-install test
```

`npm run test:mcp` is **not** part of `npm test` — run it separately after touching `tool-contracts.mjs`.