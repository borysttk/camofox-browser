import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';
import {
  getUserPersistencePaths,
  isContextClosedError,
  loadPersistedStorageState,
  persistStorageState,
} from '../../lib/persistence.js';

describe('profile persistence helpers', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'camofox-persistence-'));
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('getUserPersistencePaths is deterministic and stays under root', () => {
    const first = getUserPersistencePaths(tmpDir, 'agent/profile:default');
    const second = getUserPersistencePaths(tmpDir, 'agent/profile:default');

    expect(first).toEqual(second);
    expect(first.userDir.startsWith(tmpDir)).toBe(true);
    expect(first.storageStatePath.startsWith(first.userDir)).toBe(true);
    expect(first.metaPath.startsWith(first.userDir)).toBe(true);
    expect(path.basename(first.userDir)).not.toContain('/');
    expect(path.basename(first.userDir)).not.toContain(':');
  });

  test('loadPersistedStorageState returns undefined when no state exists', async () => {
    await expect(loadPersistedStorageState(tmpDir, 'user-1')).resolves.toBeUndefined();
  });

  test('persistStorageState writes storage state and metadata, then load returns the storage path', async () => {
    const storageState = {
      cookies: [{ name: 'session', value: 'abc', domain: '.example.com', path: '/' }],
      origins: [{ origin: 'https://app.example.com', localStorage: [{ name: 'foo', value: 'bar' }] }],
    };

    const context = {
      storageState: jest.fn(async ({ path: targetPath }) => {
        await fs.writeFile(targetPath, JSON.stringify(storageState, null, 2));
      }),
    };

    const result = await persistStorageState({
      profileDir: tmpDir,
      userId: 'user-1',
      context,
      logger: { warn: jest.fn() },
    });

    expect(result.persisted).toBe(true);
    expect(context.storageState).toHaveBeenCalledTimes(1);

    const loadedPath = await loadPersistedStorageState(tmpDir, 'user-1');
    expect(loadedPath).toBe(result.storageStatePath);

    const meta = JSON.parse(await fs.readFile(result.metaPath, 'utf8'));
    expect(meta.userId).toBe('user-1');
    expect(meta.storageStatePath).toBe(result.storageStatePath);
  });

  test('loadPersistedStorageState ignores invalid JSON files', async () => {
    const { storageStatePath } = getUserPersistencePaths(tmpDir, 'user-2');
    await fs.mkdir(path.dirname(storageStatePath), { recursive: true });
    await fs.writeFile(storageStatePath, '{not-json');

    await expect(loadPersistedStorageState(tmpDir, 'user-2', { warn: jest.fn() })).resolves.toBeUndefined();
  });

  test('a failed persist leaves the previous storage-state intact and cleans up tmp files', async () => {
    const originalState = {
      cookies: [{ name: 'orig', value: 'v1', domain: '.example.com', path: '/' }],
    };
    const goodContext = {
      storageState: jest.fn(async ({ path: targetPath }) => {
        await fs.writeFile(targetPath, JSON.stringify(originalState, null, 2));
      }),
    };
    const first = await persistStorageState({
      profileDir: tmpDir,
      userId: 'user-3',
      context: goodContext,
      logger: { warn: jest.fn() },
    });
    expect(first.persisted).toBe(true);

    const failingContext = {
      storageState: jest.fn(async () => {
        throw new Error('simulated crash mid-write');
      }),
    };
    const second = await persistStorageState({
      profileDir: tmpDir,
      userId: 'user-3',
      context: failingContext,
      logger: { warn: jest.fn() },
    });
    expect(second.persisted).toBe(false);

    const { userDir, storageStatePath } = getUserPersistencePaths(tmpDir, 'user-3');
    const loaded = await loadPersistedStorageState(tmpDir, 'user-3');
    expect(loaded).toBe(storageStatePath);
    const parsed = JSON.parse(await fs.readFile(storageStatePath, 'utf8'));
    expect(parsed).toEqual(originalState);

    const leftovers = (await fs.readdir(userDir)).filter((name) => name.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  // Q patch (2026-10-11) — see lib/persistence.js isContextClosedError.
  test('a closed context is a benign skip, not a persistence failure', async () => {
    const originalState = {
      cookies: [{ name: 'session', value: 'still-good', domain: '.copilot.com', path: '/' }],
    };
    await persistStorageState({
      profileDir: tmpDir,
      userId: 'user-closed',
      context: {
        storageState: jest.fn(async ({ path: targetPath }) => {
          await fs.writeFile(targetPath, JSON.stringify(originalState, null, 2));
        }),
      },
      logger: { warn: jest.fn(), info: jest.fn() },
    });

    const warn = jest.fn();
    const info = jest.fn();
    const closedContext = {
      storageState: jest.fn(async () => {
        throw new Error(
          'browserContext.storageState: Target page, context or browser has been closed',
        );
      }),
    };
    const result = await persistStorageState({
      profileDir: tmpDir,
      userId: 'user-closed',
      context: closedContext,
      logger: { warn, info },
    });

    expect(result.persisted).toBe(false);
    expect(result.reason).toBe('context_closed');
    // The operator should NOT see a scary warning for a routine teardown.
    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalled();

    // Critically: the previous good snapshot must survive untouched.
    const { storageStatePath } = getUserPersistencePaths(tmpDir, 'user-closed');
    const parsed = JSON.parse(await fs.readFile(storageStatePath, 'utf8'));
    expect(parsed).toEqual(originalState);
  });

  test('isContextClosedError only matches closed-target failures', () => {
    expect(isContextClosedError(new Error('Target page, context or browser has been closed'))).toBe(true);
    expect(isContextClosedError(new Error('Target closed'))).toBe(true);
    expect(isContextClosedError(new Error('simulated crash mid-write'))).toBe(false);
    expect(isContextClosedError(new Error('ENOSPC: no space left on device'))).toBe(false);
    expect(isContextClosedError(null)).toBe(false);
  });
});
