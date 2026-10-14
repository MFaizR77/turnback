import { closeSync, existsSync, mkdirSync, openSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { LOCK_STALE_MS, sleep } from './config.js';

export class LockTimeoutError extends Error {
  constructor() { super('workspace lock timeout'); }
}

const lockFile = (dir: string) => path.join(dir, 'lock');

/** Run `fn` while holding the per-workspace lock file. Locks older than 60 seconds are considered stale. */
export function withLock<T>(dir: string, timeoutMs: number, fn: () => T): T {
  mkdirSync(dir, { recursive: true });
  const file = lockFile(dir);
  const start = Date.now();
  for (;;) {
    try {
      const fd = openSync(file, 'wx');
      writeFileSync(fd, `${process.pid}\n${Date.now()}`);
      closeSync(fd);
      break;
    } catch {
      if (removeIfStale(file)) continue;
      if (Date.now() - start >= timeoutMs) throw new LockTimeoutError();
      sleep(30);
    }
  }
  try {
    return fn();
  } finally {
    try { unlinkSync(file); } catch { /* another process already cleaned up the stale lock */ }
  }
}

/** Wait until nobody holds the lock, or the timeout expires; `false` on timeout. A stale lock counts as free. */
export function waitForUnlock(dir: string, timeoutMs: number): boolean {
  const file = lockFile(dir);
  const start = Date.now();
  for (;;) {
    if (!existsSync(file) || isStale(file)) return true;
    if (Date.now() - start >= timeoutMs) return false;
    sleep(50);
  }
}

function isStale(file: string): boolean {
  try { return Date.now() - statSync(file).mtimeMs > LOCK_STALE_MS; } catch { return true; }
}

function removeIfStale(file: string): boolean {
  try {
    if (!isStale(file)) return false;
    unlinkSync(file);
    return true;
  } catch {
    // Lock vanished between the two calls: try to take it again.
    return !existsSync(file);
  }
}
