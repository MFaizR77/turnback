import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const VERSION = '0.9.0';

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const EDITS_ONLY_BYTES = 2 * 1024 ** 3;
/** File count limit before a workspace switches to edits-only mode. Overridable for tests. */
export const editsOnlyFiles = () => Number(process.env.TURNBACK_MAX_FILES || 100_000);
/** File bytes per `git fast-import` run in a first snapshot; each run writes one pack. Overridable for tests. */
export const importBatchBytes = () => Number(process.env.TURNBACK_IMPORT_BATCH_BYTES || 64 * 1024 * 1024);

export const LOCK_TIMEOUT_MS = 30_000;
export const LOCK_STALE_MS = 60_000;
export const WARM_WAIT_MS = 30_000;
export const GC_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const RETENTION = { days: 7, turns: 50 };
/** Daily gc packs the shadow repo once loose objects pass either limit, or when an interrupted write left garbage. */
export const COMPACT_LOOSE = { count: 1000, bytes: 32 * 1024 * 1024 };
/** Probe snapshots (from MCP diff_range) older than this are removed by gc. */
export const PROBE_TTL_MS = 24 * 60 * 60 * 1000;

/** Rebuildable directories, never snapshotted or touched by restore. */
export const EXCLUDED_DIRS = new Set([
  '.git', '.turnback', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build',
  'target', '.next', '.nuxt', '.cache', 'coverage', '.turbo', '.gradle',
]);

/** In each workspace's data folder: `{ "root": "<workspace path>" }`, written since 0.9.0. */
export const WORKSPACE_FILE = 'workspace.json';
/** `du --prune` removes data folders without a recorded workspace once idle this long. */
export const UNKNOWN_IDLE_DAYS = 30;

export const dataHome = () => process.env.TURNBACK_HOME || path.join(homedir(), '.turnback');

export interface UserConfig {
  exclude?: string[];
  /** `false` stops recording prompt labels. */
  prompts?: boolean;
  /** `false` turns off end-of-turn warnings. */
  warnings?: boolean;
  /** Warn when a turn deletes at least this many files. */
  warnDeletes?: number;
}

/** `~/.turnback/config.json`; a missing, unreadable, or malformed file or field means defaults. */
export function userConfig(): UserConfig {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path.join(dataHome(), 'config.json'), 'utf8')); } catch { return {}; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const { exclude, prompts, warnings, warnDeletes } = raw as Record<string, unknown>;
  return {
    exclude: Array.isArray(exclude) ? exclude.filter((p): p is string => typeof p === 'string') : undefined,
    prompts: typeof prompts === 'boolean' ? prompts : undefined,
    warnings: typeof warnings === 'boolean' ? warnings : undefined,
    warnDeletes: typeof warnDeletes === 'number' && warnDeletes > 0 ? warnDeletes : undefined,
  };
}

export const PROMPT_CHARS = 200;

/** Prompt as a one-line label of at most PROMPT_CHARS characters, or undefined when disabled or empty. */
export function promptLabel(prompt: string | undefined): string | undefined {
  if (!prompt || userConfig().prompts === false) return undefined;
  const line = prompt.replace(/\s+/g, ' ').trim();
  if (!line) return undefined;
  return line.length > PROMPT_CHARS ? line.slice(0, PROMPT_CHARS - 1) + '…' : line;
}

export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** Path key that is stable across spellings (Windows: lowercase, forward slashes). */
export function pathKey(p: string): string {
  const abs = path.resolve(p);
  return process.platform === 'win32' ? abs.replaceAll('\\', '/').toLowerCase() : abs;
}

const roots = new Map<string, string>();

/** Workspace root: the git toplevel if any, otherwise cwd. */
export function workspaceRoot(cwd: string): string {
  const cached = roots.get(cwd);
  if (cached) return cached;
  const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 1500, windowsHide: true });
  const root = r.status === 0 ? path.resolve(r.stdout.trim()) : canonicalPath(cwd);
  roots.set(cwd, root);
  return root;
}

/** Workspace containing a file, resolved from the nearest existing folder (a new file may not have its folder yet). */
export function workspaceRootForFile(file: string): string {
  let dir = path.dirname(path.resolve(file));
  while (!existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  return workspaceRoot(dir);
}

/**
 * The same path with its existing part spelled as the OS resolves it, so aliases such as
 * macOS `/var` → `/private/var` or Windows 8.3 names (`RUNNER~1`) match git's toplevel.
 * The part that does not exist yet (a new file or folder) is kept as is.
 */
export function canonicalPath(p: string): string {
  let existing = path.resolve(p);
  const rest: string[] = [];
  while (!existsSync(existing) && path.dirname(existing) !== existing) {
    rest.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  try { return path.join(realpathSync.native(existing), ...rest); } catch { return path.resolve(p); }
}

export function isInside(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Turnback data folder for one workspace. */
export const workspaceDataDir = (root: string) => path.join(dataHome(), sha256(pathKey(root)).slice(0, 24));

export function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
