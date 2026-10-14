import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dataHome, GC_INTERVAL_MS, LOCK_TIMEOUT_MS, UNKNOWN_IDLE_DAYS, userConfig, WORKSPACE_FILE } from './config.js';
import { withLock } from './lock.js';
import { Journal, turnKey } from './journal.js';
import { directorySize, Store } from './store.js';
import { ShadowRepo } from '../git/shadow.js';

export interface WorkspaceUsage {
  /** Data folder in TURNBACK_HOME. */
  dir: string;
  /** Workspace the data belongs to; unknown for data written before 0.9.0 that has not been used since. */
  root?: string;
  /** For an unknown workspace, the folder of a file it recorded, as a hint of where it was. */
  near?: string;
  /** Whether the workspace folder still exists; `false` when it is unknown. */
  exists: boolean;
  bytes: number;
  /** Leftovers of interrupted writes, removed by `turnback gc`. */
  garbageBytes: number;
  turns: number;
  /** Time of the last journal entry, or of the last change to the journal. */
  lastActivity?: string;
}

/** Every workspace's data in `home`, largest first. */
export function diskUsage(home = dataHome()): WorkspaceUsage[] {
  let names: string[];
  try { names = readdirSync(home); } catch { return []; }
  return names
    .map(name => path.join(home, name))
    .filter(dir => isDataDir(dir))
    .map(usage)
    .sort((a, b) => b.bytes - a.bytes);
}

function isDataDir(dir: string): boolean {
  try {
    return statSync(dir).isDirectory() && (existsSync(path.join(dir, 'journal.jsonl')) || existsSync(path.join(dir, 'repo.git')));
  } catch { return false; }
}

function usage(dir: string): WorkspaceUsage {
  let root: string | undefined;
  try { root = JSON.parse(readFileSync(path.join(dir, WORKSPACE_FILE), 'utf8')).root; } catch { /* written before 0.9.0 */ }
  const journalFile = path.join(dir, 'journal.jsonl');
  const entries = new Journal(journalFile).read();
  const turns = new Set(entries.filter(e => e.agent !== 'turnback').map(turnKey)).size;
  let lastActivity = entries.at(-1)?.time;
  if (!lastActivity) try { lastActivity = statSync(journalFile).mtime.toISOString(); } catch { /* empty */ }
  let garbageBytes = 0;
  if (existsSync(path.join(dir, 'repo.git'))) {
    try { garbageBytes = new ShadowRepo(dir, root ?? dir).objectStats().garbageBytes; } catch { /* not a repo */ }
  }
  const sample = root ? undefined : entries.find(e => e.paths?.length)?.paths![0];
  return {
    dir, root, near: sample && path.dirname(sample), exists: !!root && existsSync(root),
    bytes: directorySize(dir), garbageBytes, turns, lastActivity,
  };
}

/** Data whose workspace was deleted, or with no recorded workspace and idle for 30 days. */
export function prunable(list: WorkspaceUsage[], now = Date.now()): WorkspaceUsage[] {
  const cutoff = now - UNKNOWN_IDLE_DAYS * 24 * 60 * 60 * 1000;
  return list.filter(u => u.root ? !u.exists : !u.lastActivity || Date.parse(u.lastActivity) < cutoff);
}

export function pruneWorkspaces(list: WorkspaceUsage[]): { removed: number; bytes: number } {
  let removed = 0, bytes = 0;
  for (const u of list) {
    try {
      rmSync(u.dir, { recursive: true, force: true, maxRetries: 3 });
      removed++;
      bytes += u.bytes;
    } catch { /* in use; left for the next prune */ }
  }
  return { removed, bytes };
}

/** Pack every workspace's shadow repo and remove leftovers of interrupted writes; snapshots are kept. */
export function compactWorkspaces(list: WorkspaceUsage[]): { packed: number; before: number; after: number } {
  let packed = 0, before = 0, after = 0;
  for (const u of list) {
    before += u.bytes;
    if (existsSync(path.join(u.dir, 'repo.git'))) {
      try {
        withLock(u.dir, LOCK_TIMEOUT_MS, () => new ShadowRepo(u.dir, u.root ?? u.dir).prune());
        packed++;
      } catch { /* busy or not a repo; left as it is */ }
    }
    after += directorySize(u.dir);
  }
  return { packed, before, after };
}

/** In TURNBACK_HOME: `{ "time": <ms> }` of the last `autoClean`. */
const CLEANUP_FILE = 'cleanup.json';

/**
 * Once a day, from the background warm: run the daily gc of every workspace, not only the one in use,
 * so turns of a project left alone for weeks expire too. Data of a workspace that was deleted, or
 * of an unknown one, is removed once idle for 30 days; until then `turnback recover` can still bring
 * its files back. Turned off with `"autoClean": false` in config.json. `undefined` when it did not run.
 */
export function autoClean(home = dataHome(), now = Date.now()): { collected: number; removed: number } | undefined {
  if (userConfig().autoClean === false) return undefined;
  const marker = path.join(home, CLEANUP_FILE);
  try {
    if (now - JSON.parse(readFileSync(marker, 'utf8')).time < GC_INTERVAL_MS) return undefined;
  } catch { /* never ran */ }
  // Written first, so warms of other sessions started meanwhile skip the cleanup.
  mkdirSync(home, { recursive: true });
  writeFileSync(marker, JSON.stringify({ time: now }));

  const cutoff = now - UNKNOWN_IDLE_DAYS * 24 * 60 * 60 * 1000;
  const list = diskUsage(home);
  const idle = list.filter(u => !u.exists && (!u.lastActivity || Date.parse(u.lastActivity) < cutoff));
  let collected = 0;
  for (const u of list) {
    if (!u.exists || !u.root) continue;
    try { if (new Store(u.root).gcIfDue(now)) collected++; } catch { /* busy; tried again tomorrow */ }
  }
  return { collected, removed: pruneWorkspaces(idle).removed };
}
