import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

function getUserPersistencePaths(profileDir, userId) {
  const rootDir = path.resolve(profileDir);
  const safeUserDir = crypto
    .createHash('sha256')
    .update(String(userId))
    .digest('hex')
    .slice(0, 32);

  const userDir = path.join(rootDir, safeUserDir);
  return {
    rootDir,
    userDir,
    storageStatePath: path.join(userDir, 'storage-state.json'),
    metaPath: path.join(userDir, 'meta.json'),
  };
}

async function loadPersistedStorageState(profileDir, userId, logger = console) {
  if (!profileDir) return undefined;

  const { storageStatePath } = getUserPersistencePaths(profileDir, userId);

  try {
    const raw = await fs.readFile(storageStatePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return undefined;
    if (!Array.isArray(parsed.cookies)) return undefined;
    if (parsed.origins !== undefined && !Array.isArray(parsed.origins)) return undefined;
    return storageStatePath;
  } catch (err) {
    if (err?.code === 'ENOENT') return undefined;
    logger?.warn?.('failed to load persisted storage state', {
      userId: String(userId),
      storageStatePath,
      error: err?.message || String(err),
    });
    return undefined;
  }
}

/**
 * Playwright throws this when the context/page backing a storage-state read
 * is already gone. That is not a persistence failure: there is nothing left
 * to save, and the previous good snapshot on disk stays authoritative. Callers
 * use this to downgrade the situation to a benign no-op instead of logging a
 * scary warn on every single shutdown.
 */
const CONTEXT_CLOSED_RE = /(Target page, context or browser has been closed|Target closed|browser has been closed|has been closed)/i;

function isContextClosedError(err) {
  return CONTEXT_CLOSED_RE.test(err?.message || '');
}

async function persistStorageState({
  profileDir,
  userId,
  context,
  storageState,
  logger = console,
  indexedDB = false,
}) {
  if (!profileDir || (!context && !storageState)) {
    return { persisted: false, reason: 'disabled' };
  }

  const { userDir, storageStatePath, metaPath } = getUserPersistencePaths(profileDir, userId);
  const suffix = `.tmp-${process.pid}-${Date.now()}`;
  const tmpStoragePath = `${storageStatePath}${suffix}`;
  const tmpMetaPath = `${metaPath}${suffix}`;

  try {
    await fs.mkdir(userDir, { recursive: true });
    if (storageState) {
      await fs.writeFile(tmpStoragePath, JSON.stringify(storageState, null, 2));
    } else {
      await context.storageState(indexedDB ? { path: tmpStoragePath, indexedDB: true } : { path: tmpStoragePath });
    }
    await fs.rename(tmpStoragePath, storageStatePath);
    await fs.writeFile(
      tmpMetaPath,
      JSON.stringify(
        {
          userId: String(userId),
          updatedAt: new Date().toISOString(),
          storageStatePath,
        },
        null,
        2
      )
    );
    await fs.rename(tmpMetaPath, metaPath);
    return { persisted: true, userDir, storageStatePath, metaPath };
  } catch (err) {
    await fs.unlink(tmpStoragePath).catch(() => {});
    await fs.unlink(tmpMetaPath).catch(() => {});
    if (isContextClosedError(err)) {
      // Nothing to save and nothing lost: the last good snapshot on disk is
      // still valid. Report it as a skip so callers stay quiet instead of
      // alarming the operator on every single context teardown.
      logger?.info?.('storage state skipped, context already closed', {
        userId: String(userId),
        storageStatePath,
      });
      return { persisted: false, reason: 'context_closed' };
    }
    logger?.warn?.('failed to persist storage state', {
      userId: String(userId),
      storageStatePath,
      error: err?.message || String(err),
    });
    return { persisted: false, reason: 'error', error: err };
  }
}

export {
  getUserPersistencePaths,
  isContextClosedError,
  loadPersistedStorageState,
  persistStorageState,
};
