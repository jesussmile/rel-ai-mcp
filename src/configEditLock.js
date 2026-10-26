import * as fs from 'node:fs';
import * as path from 'node:path';

import { getConfigPath } from './config.js';

// Lock files whose owner cannot be read are treated as stale only after this age.
const UNREADABLE_LOCK_STALE_MS = 60_000;
const heldLocks = new Set();

// Serializes workspace edits between the dashboard and the local config CLI.
// The lock never waits: a busy lock fails fast so a caller can retry, and a
// lock left by a process that no longer exists is reclaimed once.
function withConfigEditLock(callback, configPath = getConfigPath()) {
  const lockPath = `${configPath}.edit-lock`;
  if (heldLocks.has(lockPath)) return callback();
  const release = acquireConfigEditLock(lockPath);
  heldLocks.add(lockPath);
  try {
    return callback();
  } finally {
    heldLocks.delete(lockPath);
    release();
  }
}

function acquireConfigEditLock(lockPath) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = `${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() }));
      } finally {
        fs.closeSync(fd);
      }
      return () => {
        // Remove only a lock this call still owns.
        if (readLockOwner(lockPath)?.token === token) fs.rmSync(lockPath, { force: true });
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (attempt === 0 && lockIsStale(lockPath)) {
        fs.rmSync(lockPath, { force: true });
        continue;
      }
      const owner = readLockOwner(lockPath);
      throw Object.assign(new Error(`Another Rel.AI config edit is in progress${owner?.pid ? ` (PID ${owner.pid})` : ''}. Retry in a moment.`), {
        code: 'CONFIG_EDIT_BUSY', retryable: true, lockPath
      });
    }
  }
  throw Object.assign(new Error('Could not acquire the Rel.AI config edit lock. Retry in a moment.'), {
    code: 'CONFIG_EDIT_BUSY', retryable: true, lockPath
  });
}

function readLockOwner(lockPath) {
  try {
    const value = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    return value && typeof value === 'object' && Number.isSafeInteger(value.pid) && value.pid > 0 ? value : null;
  } catch {
    return null;
  }
}

function lockIsStale(lockPath) {
  const owner = readLockOwner(lockPath);
  if (owner) return !processExists(owner.pid);
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs > UNREADABLE_LOCK_STALE_MS;
  } catch (error) {
    return error?.code === 'ENOENT';
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export { withConfigEditLock };
