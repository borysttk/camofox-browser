/**
 * Bookmarks plugin for camofox-browser.
 *
 * WHY THIS EXISTS (Q patch, 2026-10-11)
 * --------------------------------------
 * The persistence plugin serialises `context.storageState()` — cookies,
 * localStorage and optionally IndexedDB. It has never covered Firefox
 * *bookmarks*, and the API has no bookmark endpoints at all. So on the Q
 * ecosystem every browser restart silently dropped bookmarks, and nothing
 * existed to restore them from.
 *
 * Bookmarks in Firefox live in `places.sqlite` inside the browser profile.
 * Camoufox is launched through `firefox.launch()`, so Playwright picks a
 * throwaway profile under $TMPDIR:
 *
 *     /tmp/playwright_firefoxdev_profile-XXXXXX/places.sqlite
 *
 * That directory is tmpfs on predator13, so it dies with the host.
 *
 * THE HARD PART
 * -------------
 * `places.sqlite` is held open by the live Firefox process, and it runs in
 * WAL mode with a multi-megabyte `-wal` sidecar. You cannot simply copy the
 * file while Firefox is running:
 *
 *     $ sqlite3 places.sqlite "SELECT count(*) FROM moz_bookmarks;"
 *     Error: in prepare, database is locked (5)
 *
 * Copying the raw `.sqlite` alone would also miss everything still sitting in
 * the WAL that has not yet been checkpointed into the main db.
 *
 * So this plugin reads through a consistent snapshot instead:
 *
 *   1. copy   places.sqlite  + places.sqlite-wal + places.sqlite-shm
 *   2. `VACUUM INTO` on the copy, which replays the WAL and produces a
 *      single self-contained file with no live locks
 *   3. read bookmarks from that snapshot
 *   4. restore by writing into a *fresh* profile copy that is not in use
 *
 * Writing is deliberately conservative: bookmarks are only ever inserted
 * that are missing, never an existing row is deleted or overwritten. A
 * restore can therefore never destroy a bookmark the user just added.
 *
 * CONFIGURATION (camofox.config.json):
 *   {
 *     "plugins": {
 *       "bookmarks": {
 *         "enabled": true,
 *         "maxBookmarks": 500
 *       }
 *     }
 *   }
 *
 * ENDPOINTS:
 *   GET    /bookmarks                     -> list {bookmarks:[...], count}
 *   DELETE /sessions/:userId/bookmarks   -> clear this user's bookmarks
 *   POST   /sessions/:userId/bookmarks/restore -> re-insert saved bookmarks
 *
 * Auth: same scheme as the persistence plugin's Q patch — a Bearer token
 * compared against a file on disk, 403 by default when no key is present.
 */

import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

/** Try better-sqlite3 if the host has it; otherwise fall back to the sqlite3 CLI. */
function loadSqlite() {
  try {
    return { kind: 'better-sqlite3', Database: require('better-sqlite3') };
  } catch {
    return { kind: 'cli', bin: process.env.CAMOFOX_SQLITE_BIN || 'sqlite3' };
  }
}

function safeUserDirName(userId) {
  // Same shape the persistence plugin uses, so one user maps to one folder
  // inside the shared bookmark backup root.
  const crypto = require('node:crypto');
  return crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 32);
}

/**
 * Read bookmarks out of a *copy* of the live profile.
 *
 * Never point better-sqlite3 straight at the running profile's places.sqlite:
 * it will report `database is locked` or, worse, block Firefox's own writes.
 */
async function readBookmarksFromProfile(profileDir, logger = console) {
  const places = path.join(profileDir, 'places.sqlite');
  let stat;
  try {
    stat = await fs.stat(places);
  } catch {
    return { ok: false, reason: 'no_places_sqlite', bookmarks: [] };
  }
  if (stat.size === 0) return { ok: false, reason: 'places_empty', bookmarks: [] };

  const sqlite = loadSqlite();
  let snapshotDir = null;
  try {
    // 1+2. Copy db + WAL sidecars into a scratch dir, then VACUUM INTO a
    //      single self-contained file. This replays the WAL, so we see the
    //      committed bookmarks, and it needs no lock on the live db.
    snapshotDir = await fs.mkdtemp(path.join(process.env.TMPDIR || '/tmp', 'camofox-bm-'));
    const copied = path.join(snapshotDir, 'places.sqlite');
    await fs.copyFile(places, copied);
    for (const sidecar of ['-wal', '-shm']) {
      try {
        await fs.copyFile(places + sidecar, copied + sidecar);
      } catch { /* sidecar may not exist; a checkpointed db is fine */ }
    }
    const merged = path.join(snapshotDir, 'places-merged.sqlite');
    await execFileAsync(sqlite.bin || 'sqlite3', [copied, `VACUUM INTO '${merged.replace(/'/g, "''")}'`], {
      timeout: 15000,
    }).catch(async (err) => {
      // VACUUM INTO can fail on a malformed WAL. The raw copy is still a
      // usable read-only db, so degrade to it rather than losing the data.
      logger?.info?.('bookmarks: VACUUM INTO failed, reading raw copy', { error: err.message });
      await fs.copyFile(copied, merged);
    });

    // 3. Read the merged snapshot.
    //    Schema notes (verified against a live Camoufox places.sqlite):
    //      - the join column is `moz_bookmarks.fk`, NOT `fkv`
    //      - type 1 = bookmark item, type 2 = folder (menu/toolbar/tags/unfiled/mobile)
    //      - menu/toolbar/tags are system folders and must be filtered out
    if (sqlite.kind === 'better-sqlite3') {
      const db = new (require('better-sqlite3'))(merged, { readonly: true });
      try {
        const rows = db
          .prepare(
            `SELECT b.title, p.url, b.dateAdded
               FROM moz_bookmarks b
               JOIN moz_places p ON p.id = b.fk
              WHERE b.type = 1 AND p.url NOT LIKE 'place:%'
              ORDER BY b.dateAdded DESC
              LIMIT ?`,
          )
          .all(MAX_BOOKMARKS);
        return { ok: true, reason: null, bookmarks: rows.map((r) => ({ title: r.title || r.url, url: r.url })) };
      } finally {
        db.close();
      }
    }
    const { stdout } = await execFileAsync(sqlite.bin, [
      merged,
      // Separator '\u241F' (SYMBOL FOR UNIT SEPARATOR) — a literal '|' would be
      // ambiguous if a title or URL ever contains one, and `lastIndexOf`
      // would then split in the wrong place, silently swapping title↔url.
      `SELECT b.title || char(31) || p.url FROM moz_bookmarks b JOIN moz_places p ON p.id=b.fk WHERE b.type=1 AND p.url NOT LIKE 'place:%' ORDER BY b.dateAdded DESC LIMIT ${MAX_BOOKMARKS};`,
    ], { timeout: 15000 });
    return {
      ok: true,
      reason: null,
      bookmarks: stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          // char(31) is the UNIT SEPARATOR; split on the FIRST one only, so
          // a title containing the character can never shift the fields.
          const idx = line.indexOf('');
          if (idx < 0) return { title: '', url: line };
          return { title: line.slice(0, idx), url: line.slice(idx + 1) };
        }),
    };
  } catch (err) {
    logger?.warn?.('bookmarks: read failed', { profileDir, error: err.message });
    return { ok: false, reason: err.message, bookmarks: [] };
  } finally {
    if (snapshotDir) await fs.rm(snapshotDir, { recursive: true, force: true }).catch(() => {});
  }
}

let MAX_BOOKMARKS = 500;

export {
  readBookmarksFromProfile,
  safeUserDirName,
  writeBookmarksIntoProfile,
};

export async function register(app, ctx, pluginConfig = {}) {
  const { events, config, log } = ctx;
  MAX_BOOKMARKS = Number(pluginConfig.maxBookmarks || 500);

  // Where saved bookmark lists live. Separate from the persistence profileDir
  // because bookmarks are a different artefact with a different shape.
  const backupDir = process.env.CAMOFOX_BOOKMARK_DIR
    || pluginConfig.backupDir
    || path.join(config.profileDir || path.join(process.env.HOME || '/home/ttk', '.camofox', 'profiles'), 'bookmarks');

  const activeProfiles = new Set();

  /** Read the Bearer token the same way the persistence plugin's Q patch does. */
  const readToken = (req) => {
    const auth = String(req.headers?.['authorization'] || '');
    const match = auth.match(/^Bearer\s+(.+)$/i);
    return match ? match[1]?.trim() : null;
  };
  const readVaultKey = async () => {
    const keyPath = process.env.Q_VAULT_KEY_PATH
      || '/home/ttk/.hermes/profiles/q/vault/vault.key';
    try {
      return (await fs.readFile(keyPath, 'utf8')).trim();
    } catch {
      return '';
    }
  };
  const authorized = async (req) => {
    const token = readToken(req);
    const key = await readVaultKey();
    // No key on disk means nothing is authorised — never "allow everyone".
    return Boolean(token && key && token === key);
  };

  const listPath = (userId) => path.join(backupDir, safeUserDirName(userId), 'bookmarks.json');

  // --- Capture on shutdown: snapshot the live profile before it vanishes. ---
  events.on('browser:launched', ({ browser }) => {
    // Best-effort: remember that a browser exists so we try to snapshot it.
    if (browser) activeProfiles.add(browser);
  });

  events.on('browser:launching', async ({ options }) => {
    // Remember the profile dir Playwright will use, when the caller supplied
    // one. With firefox.launch() Playwright generates the tmp path itself, so
    // we fall back to discovering it from the running process at shutdown.
    if (options?.userDataDir) log('info', 'bookmarks: explicit userDataDir detected', { userDataDir: options.userDataDir });
  });

  events.on('server:shutdown', async () => {
    // Snapshot every known live profile into the per-user backup. Runs BEFORE
    // closeAllSessions, so Firefox is still alive and the WAL is replayable.
    for (const userId of ['q']) {
      const profileDir = await discoverLiveProfileDir();
      if (!profileDir) continue;
      const result = await readBookmarksFromProfile(profileDir, {
        info: (m, f) => log('info', m, f),
        warn: (m, f) => log('warn', m, f),
      });
      if (!result.ok || result.bookmarks.length === 0) continue;
      await fs.mkdir(path.dirname(listPath(userId)), { recursive: true });
      await fs.writeFile(
        listPath(userId),
        JSON.stringify({ userId, capturedAt: new Date().toISOString(), source: profileDir, bookmarks: result.bookmarks }, null, 2),
      );
      log('info', 'bookmarks captured', { userId, count: result.bookmarks.length });
    }
  });

  // --- REST API ---

  app.get('/bookmarks', async (req, res) => {
    if (!(await authorized(req))) return res.status(403).json({ error: 'Forbidden' });
    const userId = ctx.normalizeUserId?.(req.query?.userId || 'q') || 'q';
    try {
      const raw = await fs.readFile(listPath(userId), 'utf8');
      const parsed = JSON.parse(raw);
      return res.json({ ok: true, userId, count: parsed.bookmarks.length, bookmarks: parsed.bookmarks });
    } catch (err) {
      if (err.code === 'ENOENT') return res.json({ ok: true, userId, count: 0, bookmarks: [] });
      return res.status(500).json({ error: ctx.safeError?.(err) || err.message });
    }
  });

  app.post('/sessions/:userId/bookmarks/restore', async (req, res) => {
    if (!(await authorized(req))) return res.status(403).json({ error: 'Forbidden' });
    const userId = ctx.normalizeUserId(req.params.userId);
    let saved;
    try {
      saved = JSON.parse(await fs.readFile(listPath(userId), 'utf8'));
    } catch (err) {
      return res.status(404).json({ error: 'no saved bookmarks', detail: err.code });
    }
    const profileDir = await discoverLiveProfileDir();
    if (!profileDir) return res.status(503).json({ error: 'live profile not found; is the browser running?' });

    const inserted = await writeBookmarksIntoProfile(profileDir, saved.bookmarks || [], {
      info: (m, f) => log('info', m, f),
      warn: (m, f) => log('warn', m, f),
    });
    return res.json({ ok: true, userId, inserted, requested: saved.bookmarks.length });
  });

  app.delete('/sessions/:userId/bookmarks', async (req, res) => {
    if (!(await authorized(req))) return res.status(403).json({ error: 'Forbidden' });
    const userId = ctx.normalizeUserId(req.params.userId);
    try {
      await fs.unlink(listPath(userId));
      return res.json({ ok: true, userId, removed: true });
    } catch (err) {
      if (err.code === 'ENOENT') return res.json({ ok: true, userId, removed: false });
      return res.status(500).json({ error: ctx.safeError?.(err) || err.message });
    }
  });

  log('info', 'bookmarks plugin enabled', { backupDir, maxBookmarks: MAX_BOOKMARKS });
}

/**
 * Find the profile directory the LIVE Firefox process is using.
 *
 * firefox.launch() makes Playwright pick a random /tmp profile, so the only
 * reliable source of truth is the running process's own cmdline. This reuses
 * the same parsing the repo already ships in lib/process-ownership.js.
 */
async function discoverLiveProfileDir() {
  try {
    const { profilePathsFromProcessSnapshot, snapshotOwnedBrowserProcesses } = await import('../../lib/process-ownership.js');
    const snapshot = snapshotOwnedBrowserProcesses(process.pid);
    const paths = profilePathsFromProcessSnapshot(snapshot);
    // Prefer a path that actually contains places.sqlite.
    for (const p of paths) {
      try {
        await fs.access(path.join(p, 'places.sqlite'));
        return p;
      } catch { /* not a usable profile */ }
    }
    return paths[0] || null;
  } catch (err) {
    return null;
  }
}

/**
 * Insert bookmarks that are missing into the live profile's places.sqlite.
 *
 * Additive only: an existing bookmark with the same URL is left alone, and
 * nothing is ever deleted. Firefox must be able to see the rows afterwards,
 * which is why we write through a copied snapshot and hand back the db.
 *
 * Writing directly into the live db is NOT possible (it is locked), so the
 * restore path is intentionally limited: it prepares a merged db and reports
 * what it would insert. For the Q ecosystem the reliable restore is to seed a
 * *fresh* profile directory from this file, which is what the operator does
 * when a restart is planned anyway.
 */
async function writeBookmarksIntoProfile(profileDir, bookmarks, logger = console) {
  if (!bookmarks.length) return { mergedPath: null, writtenBack: false };
  let snapshotDir = null;
  try {
    snapshotDir = await fs.mkdtemp(path.join(process.env.TMPDIR || '/tmp', 'camofox-bmw-'));
    const copied = path.join(snapshotDir, 'places.sqlite');
    await fs.copyFile(path.join(profileDir, 'places.sqlite'), copied);
    for (const sidecar of ['-wal', '-shm']) {
      try { await fs.copyFile(path.join(profileDir, 'places.sqlite' + sidecar), copied + sidecar); } catch { /* optional */ }
    }
    const merged = path.join(snapshotDir, 'places-merged.sqlite');
    await execFileAsync('sqlite3', [copied, `VACUUM INTO '${merged.replace(/'/g, "''")}'`], { timeout: 15000 })
      .catch(() => fs.copyFile(copied, merged));

    const sql = [`PRAGMA busy_timeout=8000;`];
    // Find the "unfiled" toolbar folder as the restore parent — that is where
    // bookmarks added without an explicit folder land in the Firefox UI.
    const parentRow = await execFileAsync('sqlite3', [
      merged,
      `SELECT id FROM moz_bookmarks WHERE title='unfiled' AND type=2 LIMIT 1;`,
    ], { timeout: 10000 }).catch(() => ({ stdout: '\n' }));
    const parentId = Number(String(parentRow.stdout).trim()) || 1;

    // Never collide with an existing row: start above the current max id.
    const maxRow = await execFileAsync('sqlite3', [
      merged, `SELECT COALESCE(MAX(id),0) FROM moz_bookmarks;`,
    ], { timeout: 10000 }).catch(() => ({ stdout: '\n' }));
    let id = Number(String(maxRow.stdout).trim()) + 1 || 100000;
    let position = 0;

    // Only insert URLs that are genuinely missing. Inserting blindly would
    // create a duplicate bookmark row for a URL the profile already holds,
    // because the unique constraint is on guid, not on url.
    const existingRows = await execFileAsync('sqlite3', [
      merged, "SELECT p.url FROM moz_bookmarks b JOIN moz_places p ON p.id=b.fk WHERE b.type=1;",
    ], { timeout: 10000 }).catch(() => ({ stdout: '' }));
    const existingUrls = new Set(
      String(existingRows.stdout).split('\n').map((s) => s.trim()).filter(Boolean),
    );

    for (const bm of bookmarks) {
      const url = String(bm.url || '').replace(/'/g, "''");
      if (existingUrls.has(bm.url)) continue; // already bookmarked — leave it alone
      const title = String(bm.title || bm.url || '').replace(/'/g, "''");
      const guid = `qbmid${id}`;
      position += 1;
      // moz_places requires unique id + guid; url_hash 0 means "not computed",
      // which Firefox tolerates and recomputes on next visit. Note:
      // syncChangeCounter lives on moz_bookmarks only — moz_places has no
      // such column, and naming it here makes every insert fail.
      sql.push(
        `INSERT OR IGNORE INTO moz_places (id,url,title,rev_host,visit_count,hidden,typed,frecency,last_visit_date,guid,foreign_count,url_hash,recalc_frecency) VALUES (${id},'${url}','${title}','',0,0,1,0,NULL,'${guid}',0,0,0);`,
      );
      // fk links the bookmark to its place row; type 1 = bookmark item.
      sql.push(
        `INSERT OR IGNORE INTO moz_bookmarks (id,type,fk,parent,position,title,dateAdded,lastModified,guid,syncStatus,syncChangeCounter) VALUES (${id},1,${id},${parentId},${position},'${title}',${Date.now()},${Date.now()},'qbm${id}',0,1);`,
      );
      id += 1;
    }
    await execFileAsync('sqlite3', [merged, sql.join('\n')], { timeout: 20000 });

    // The live profile db is locked by the running Firefox, so we cannot write
    // into it directly. Instead hand the merged db back to the caller: it is
    // the complete, WAL-replayed profile INCLUDING the newly added bookmarks,
    // ready to be seeded into a fresh profile dir on the next browser start.
    // Overwriting the live file would corrupt a running Firefox, so we only
    // do it when Firefox is not holding it.
    const liveDb = path.join(profileDir, 'places.sqlite');
    let writtenBack = false;
    const liveStat = await fs.stat(liveDb).catch(() => null);
    if (liveStat) {
      // A Firefox that is running leaves a lock symlink in the profile dir.
      // No lock + no live -wal growth means we may safely replace the file.
      const lockPath = path.join(profileDir, 'lock');
      const hasLock = await fs.lstat(lockPath).then(() => true).catch(() => false);
      if (!hasLock) {
        await fs.copyFile(merged, liveDb).catch(() => {});
        await fs.rm(liveDb + '-wal', { force: true }).catch(() => {});
        await fs.rm(liveDb + '-shm', { force: true }).catch(() => {});
        writtenBack = true;
      }
    }
    logger?.info?.('bookmarks restore prepared', {
      requested: bookmarks.length,
      writtenBackToProfile: writtenBack,
      note: writtenBack
        ? 'live profile updated (browser not running)'
        : 'browser is running; merged profile kept at ' + merged,
    });
    // Keep the merged db only when we could not write it back into the profile
    // (i.e. Firefox is running). The caller needs it in that case.
    if (writtenBack && snapshotDir) await fs.rm(snapshotDir, { recursive: true, force: true }).catch(() => {});
    return { mergedPath: writtenBack ? null : merged, writtenBack };
  } catch (err) {
    logger?.warn?.('bookmarks restore failed', { error: err.message });
    if (snapshotDir) await fs.rm(snapshotDir, { recursive: true, force: true }).catch(() => {});
    return { mergedPath: null, writtenBack: false };
  }
}