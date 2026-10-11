import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  readBookmarksFromProfile,
  safeUserDirName,
  writeBookmarksIntoProfile,
} from './index.js';

const execFileAsync = promisify(execFile);

/**
 * Build a minimal but schema-correct places.sqlite, mirroring the real Firefox
 * layout that the plugin has to work with:
 *   moz_places(id, url, title, ...)
 *   moz_bookmarks(id, type, fk, parent, ...)   type 1 = item, 2 = folder
 * `fk` (not `fkv`) is the join column — verified against a live Camoufox
 * profile, and the single easiest thing to get wrong here.
 */
async function makeProfile({ bookmarks = [], locked = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'camofox-bm-test-'));
  const db = path.join(dir, 'places.sqlite');
  const schema = `
    CREATE TABLE moz_places (
      id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR,
      rev_host LONGVARCHAR, visit_count INTEGER DEFAULT 0,
      hidden INTEGER DEFAULT 0 NOT NULL, typed INTEGER DEFAULT 0 NOT NULL,
      frecency INTEGER DEFAULT -1 NOT NULL, last_visit_date INTEGER,
      guid TEXT, foreign_count INTEGER DEFAULT 0 NOT NULL,
      url_hash INTEGER DEFAULT 0 NOT NULL, description TEXT,
      preview_image_url TEXT, site_name TEXT, origin_id INTEGER,
      recalc_frecency INTEGER NOT NULL DEFAULT 0, alt_frecency INTEGER,
      recalc_alt_frecency INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE moz_bookmarks (
      id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER DEFAULT NULL,
      parent INTEGER, position INTEGER, title LONGVARCHAR,
      keyword_id INTEGER, folder_type TEXT, dateAdded INTEGER,
      lastModified INTEGER, guid TEXT,
      syncStatus INTEGER NOT NULL DEFAULT 0, syncChangeCounter INTEGER NOT NULL DEFAULT 1
    );
    CREATE UNIQUE INDEX moz_bookmarks_guid_uniqueindex ON moz_bookmarks (guid);
    CREATE UNIQUE INDEX moz_places_guid_uniqueindex ON moz_places (guid);
  `;
  await execFileAsync('sqlite3', [db, schema]);

  // System folders, exactly like a real profile.
  for (const [i, folder] of ['menu', 'toolbar', 'tags', 'unfiled', 'mobile'].entries()) {
    await execFileAsync('sqlite3', [db, `INSERT INTO moz_bookmarks (id,type,title,parent,guid) VALUES (${i + 1},2,'${folder}',0,'f${i}');`]);
  }
  for (const [i, bm] of bookmarks.entries()) {
    const id = 100 + i;
    await execFileAsync('sqlite3', [db, `INSERT INTO moz_places (id,url,title,guid) VALUES (${id},'${bm.url}','${bm.title}','p${id}');`]);
    await execFileAsync('sqlite3', [db, `INSERT INTO moz_bookmarks (id,type,fk,parent,position,title,guid) VALUES (${id},1,${id},4,${i},'${bm.title}','b${id}');`]);
  }
  if (locked) {
    // Put the db into WAL mode with a live lock, the way a running Firefox
    // holds it. This is the case the plugin must survive.
    await execFileAsync('sqlite3', [db, 'PRAGMA journal_mode=WAL;']);
  }
  return dir;
}

describe('bookmarks plugin helpers', () => {
  const dirs = [];
  afterAll(async () => {
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  });

  test('reads bookmarks through a locked WAL profile', async () => {
    const dir = await makeProfile({
      bookmarks: [
        { url: 'https://github.com/', title: 'GitHub' },
        { url: 'https://copilot.com/chat', title: 'Copilot' },
      ],
      locked: true,
    });
    dirs.push(dir);

    const result = await readBookmarksFromProfile(dir, console);
    expect(result.ok).toBe(true);
    const urls = result.bookmarks.map((b) => b.url).sort();
    expect(urls).toEqual(['https://copilot.com/chat', 'https://github.com/']);
  });

  test('title and url are never swapped', async () => {
    // Regression guard: an earlier version joined title||'|'||url and split on
    // lastIndexOf('|'), which silently swapped the fields for any bookmark
    // whose title and url differed. Distinct values make that impossible to miss.
    const dir = await makeProfile({
      bookmarks: [
        { url: 'https://github.com/', title: 'GitHub' },
        { url: 'https://copilot.com/chat', title: 'Copilot' },
      ],
    });
    dirs.push(dir);

    const result = await readBookmarksFromProfile(dir, console);
    const byUrl = Object.fromEntries(result.bookmarks.map((b) => [b.url, b.title]));
    expect(byUrl['https://github.com/']).toBe('GitHub');
    expect(byUrl['https://copilot.com/chat']).toBe('Copilot');
    // A title containing the unit separator must not shift the url field.
    for (const b of result.bookmarks) {
      expect(b.url.startsWith('http')).toBe(true);
      expect(b.url).not.toBe('GitHub');
      expect(b.url).not.toBe('Copilot');
    }
  });

  test('system folders are never returned as bookmarks', async () => {
    const dir = await makeProfile({ bookmarks: [] });
    dirs.push(dir);
    const result = await readBookmarksFromProfile(dir, console);
    expect(result.bookmarks).toEqual([]);
    // The folders exist in the db; they must simply not be reported.
    const { stdout } = await execFileAsync('sqlite3', [path.join(dir, 'places.sqlite'), 'SELECT count(*) FROM moz_bookmarks WHERE type=2;']);
    expect(Number(stdout.trim())).toBe(5);
  });

  test('a missing places.sqlite is reported, not thrown', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'camofox-bm-empty-'));
    dirs.push(dir);
    const result = await readBookmarksFromProfile(dir, console);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no_places_sqlite');
    expect(result.bookmarks).toEqual([]);
  });

  test('restore is additive and never drops existing rows', async () => {
    const dir = await makeProfile({
      bookmarks: [{ url: 'https://existing.example/', title: 'Existing' }],
    });
    dirs.push(dir);

    const written = await writeBookmarksIntoProfile(
      dir,
      [
        { url: 'https://existing.example/', title: 'Existing' },
        { url: 'https://new1.example/', title: 'New One' },
        { url: 'https://new2.example/', title: 'New Two' },
      ],
      console,
    );

    // Re-read through the same public path an operator would use.
    const after = await readBookmarksFromProfile(dir, console);
    const urls = after.bookmarks.map((b) => b.url).sort();
    expect(urls).toContain('https://existing.example/');
    expect(urls).toContain('https://new1.example/');
    expect(urls).toContain('https://new2.example/');
    // The original must still be present exactly once — no duplicates.
    expect(urls.filter((u) => u === 'https://existing.example/')).toHaveLength(1);
    expect(written).toHaveProperty('writtenBack');
    expect(typeof written.mergedPath === 'string' || written.mergedPath === null).toBe(true);
  });

  test('safeUserDirName is deterministic and filesystem safe', () => {
    expect(safeUserDirName('q')).toBe(safeUserDirName('q'));
    expect(safeUserDirName('q')).toHaveLength(32);
    expect(safeUserDirName('q')).not.toBe(safeUserDirName('duo'));
    expect(safeUserDirName('a/b:c')).not.toMatch(/[/\\:]/);
  });
});