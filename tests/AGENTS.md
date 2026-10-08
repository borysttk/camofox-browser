# tests/ — Test Suites

113 files across 4 tiers. Native ESM — **no Babel, no transform**.

## Running

```bash
npm run test:unit      # tests/unit only (--runInBand --forceExit)
npm run test:e2e       # tests/e2e, separate config + global setup/teardown
npm run test:plugins   # plugins/
npm run test:live      # tests/live — needs RUN_LIVE_TESTS=1, hits real sites
npm run test:debug     # DEBUG_SERVER=1, server logs visible
npm test               # unit → e2e → plugins (NOT live)

npx jest tests/unit/snapshot.test.js   # single file
```

Every tier needs `NODE_OPTIONS='--experimental-vm-modules'` — the npm scripts set it. Running bare `npx jest` on ESM tests fails.

## Tiers

| Tier | Config | Harness | Network |
|------|--------|---------|---------|
| `tests/unit/` (75) | `jest.config.cjs` | imports real modules, no mocks | none |
| `tests/e2e/` (19) | `jest.config.e2e.cjs` | one shared server + test site for the whole run | localhost only |
| `tests/live/` (3) | `jest.config.cjs` | gated by `RUN_LIVE_TESTS` | **real internet** |
| `plugins/*/*.test.js` | `jest.config.cjs` | per-plugin, auto-discovered | none |
| `scripts/*.test.js` (2) | `jest.config.cjs` | auto-discovered | none |

`testPathIgnorePatterns` excludes `live` from the e2e config, so `npm run test:e2e` never hits Google/Amazon by accident.

## Harness

`tests/e2e/globalSetup.js` starts **one** camofox server (`lib/launcher.js`) plus a local fixture site (`tests/helpers/testSite.js`), writes ports to `os.tmpdir()/camofox-e2e-env.json`, and `globalTeardown.js` kills both. Test files read that file via `tests/e2e/sharedEnv.js` — never boot a second server.

`tests/helpers/`:
- `client.js` — `BrowserClient`, the HTTP wrapper every e2e test uses. `shouldRetryCreateTab()` encodes when a 500 is a browser-restart race, not a real failure.
- `testSite.js` — local Express fixture (nav targets, upload fixtures, 1x1 PNG)
- `startServer.js` — standalone server spawn, for tests that need isolation from the shared one
- `test-env.js` — **the only** place tests read `process.env`. Split out deliberately: `env` + network in one file trips the OpenClaw scanner.

## Conventions

- `import { describe, expect, test, afterEach } from '@jest/globals'` — explicit named imports, even though Jest injects globals.
- **`jest.mock` / `jest.unstable_mockModule` are almost unused** (1 of 16 files that mock anything is a unit test). The norm is real implementations + dependency injection. Reach for DI, not mocks.
- `maxWorkers: 1`, `testTimeout: 60000`, `bail: 0`, `verbose: true` — sequential by design; browsers and temp dirs are shared.
- Env-mutating unit tests snapshot and restore: `const ORIGINAL_ENV = { ...process.env }` in `beforeEach`/`afterEach`.
- Tests import the production module directly (`../../lib/snapshot.js`). No barrel, no re-setup.
- CI adds a `jest-junit` reporter → `test-results/`. Locally you get plain output.

## Coverage gaps worth knowing

`lib/reporter.js` (1107 lines) has the deepest single test (`tests/unit/reporter.test.js`, 1163 lines). `lib/snapshot.js` is 41 lines with a focused test. Windows process handling is tested, but only on the `windows-process-cleanup` CI job.

## Anti-patterns

- Never start a server in an e2e test file — use `sharedEnv.js`.
- Never add a live-site test without `RUN_LIVE_TESTS` gating; `tests/live/*.test.js` all use `const SKIP_LIVE_TESTS = !process.env.RUN_LIVE_TESTS`.
- Never assert on `process.env` outside `tests/helpers/test-env.js`.
- Never delete a failing test to get green — several exist specifically to pin contracts (`openapi.test.js`, `noSecrets.test.js`, `syncVersion.test.js`, `security.test.js`).

## Manual

`tests/vnc-linux-smoke.sh` — standalone shell smoke test for the VNC path. Not part of any jest tier.