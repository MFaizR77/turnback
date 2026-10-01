import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isInside, MAX_FILE_BYTES, pathKey, sha256, sleep } from './config.js';
import type { TreeItem } from '../git/shadow.js';
import type { Store } from './store.js';
import type { Entry, Turn } from './types.js';
import type { FileState } from '../workspace/workspace.js';

export type Operation = 'restore' | 'undo' | 'redo';

export interface RestoreAction {
  path: string;
  action: 'create' | 'modify' | 'delete';
  /** File changed since Turnback's last snapshot, probably edited manually by the user. */
  uncertain: boolean;
}

export interface RestorePlan {
  target: string;
  ref: string;
  paths?: string[];
  /** `workspace`: the whole tree is compared. `recorded-paths` (edits-only mode): only paths that were recorded. */
  scope: 'workspace' | 'recorded-paths';
  actions: RestoreAction[];
  token: string;
  skippedLarge: string[];
}

export interface RestoreOptions {
  paths?: string[];
  /** Token from the plan; when set, restore is refused if the workspace has changed. */
  token?: string;
  skipUncertain?: boolean;
  operation?: Operation;
}

export interface RestoreResult {
  applied: string[];
  skipped: string[];
  failed: string[];
  safety: string;
  plan: RestorePlan;
}

export function planRestore(store: Store, target: string, selected?: string[]): RestorePlan {
  return buildPlan(store, target, selected).plan;
}

/** Restore plan plus the source of the target content for each path. */
function buildPlan(store: Store, target: string, selected?: string[]) {
  const entries = store.entries();
  const { ref, since } = resolveTarget(store, entries, target);
  const editsOnly = store.mode() === 'edits-only';
  const oidLength = store.repo.objectIdLength();
  const allowed = selected?.map(p => {
    const rel = store.workspace.relative(p);
    if (!rel) throw new Error(`Path outside workspace: ${p}`);
    return rel;
  });

  let source: (rel: string) => TreeItem | undefined;
  let candidates: string[], skippedLarge: string[];
  if (editsOnly) {
    const recorded = recordedSources(store, entries.slice(since));
    const trees = new Map<string, Map<string, TreeItem>>();
    source = rel => {
      const snapshot = recorded.get(rel)!;
      if (!trees.has(snapshot)) trees.set(snapshot, store.repo.tree(snapshot));
      return trees.get(snapshot)!.get(rel);
    };
    candidates = [...recorded.keys()];
    skippedLarge = candidates.filter(p => (store.workspace.stat(p)?.size ?? 0) > MAX_FILE_BYTES);
  } else {
    const desired = store.repo.tree(ref);
    source = rel => desired.get(rel);
    const scan = store.workspace.scan();
    candidates = [...desired.keys(), ...scan.paths];
    skippedLarge = scan.skipped;
  }

  const large = new Set(skippedLarge);
  const lastEndIndex = entries.findLastIndex(e => (e.kind === 'turn-end' || e.kind === 'post-restore') && e.ref);
  const lastEnd = entries[lastEndIndex]?.ref;
  const lastSeen = lastEnd ? store.repo.tree(lastEnd) : new Map<string, TreeItem>();
  // Paths an edit tool changed since then belong to an agent turn that has not ended: its own work,
  // not a manual edit. Shell commands name no paths, so what they change is still marked uncertain.
  const agentEdited = new Set(entries.slice(lastEndIndex + 1).flatMap(e =>
    e.agent !== 'turnback' && e.paths && (e.kind === 'edit' || e.kind === 'baseline') ? store.relativePaths(e.paths) : []));
  const current = new Map<string, FileState>();
  const actions: RestoreAction[] = [];

  for (const p of [...new Set(candidates)].sort()) {
    if (store.workspace.excluded(p) || large.has(p)) continue;
    const have = store.workspace.fileState(p, oidLength);
    if (have) current.set(p, have);
    if (allowed?.length && !allowed.some(a => p === a || p.startsWith(a + '/'))) continue;
    const want = source(p);
    if (!want && !have) continue;
    if (want && have && sameFile(want, have)) continue;
    const seen = lastSeen.get(p);
    actions.push({
      path: p,
      action: !want ? 'delete' : have ? 'modify' : 'create',
      uncertain: !!seen && !!have && !sameFile(seen, have) && !agentEdited.has(p),
    });
  }

  const state = sha256(JSON.stringify([...current].sort(([a], [b]) => a.localeCompare(b))));
  const token = sha256(JSON.stringify({ root: pathKey(store.root), ref, allowed, actions, state }));
  const plan: RestorePlan = {
    target,
    ref,
    paths: allowed,
    scope: editsOnly ? 'recorded-paths' : 'workspace',
    actions,
    token,
    skippedLarge: [...large],
  };
  return { plan, source };
}

/**
 * Edits-only mode: a snapshot tree is complete only for the paths recorded in that entry.
 * The state of a path at the target = the first later snapshot that recorded the path,
 * because that snapshot was taken before the path changed. Paths never recorded are left alone.
 */
function recordedSources(store: Store, entries: Entry[]): Map<string, string> {
  const sources = new Map<string, string>();
  for (const e of entries) {
    if (!e.ref || e.status !== 'ok' || !e.paths) continue;
    for (const rel of store.relativePaths(e.paths)) if (!sources.has(rel)) sources.set(rel, e.ref);
  }
  return sources;
}

/**
 * Restore the workspace to `target`. The current state is saved first as a safety snapshot,
 * so a restore can always be reversed with `redo`.
 */
export function applyRestore(store: Store, target: string, options: RestoreOptions = {}): RestoreResult {
  const { paths, token, skipUncertain = false, operation = 'restore' } = options;
  return store.locked(() => {
    const { plan, source } = buildPlan(store, target, paths);
    if (token && token !== plan.token) throw new Error('Stale or invalid confirmation token');

    const scope = plan.scope === 'recorded-paths' ? plan.actions.map(a => a.path) : undefined;
    const safety = store.snapshotLocked('pre-restore', { agent: 'turnback', session: 'restore', turn: randomUUID(), paths: scope }, scope);
    if (!safety.ref) throw new Error('Safety snapshot failed');

    const applied: string[] = [], skipped: string[] = [], failed: string[] = [];
    for (const action of plan.actions) {
      if (skipUncertain && action.uncertain) {
        skipped.push(action.path);
        continue;
      }
      try {
        withRetry(() => writeAction(store, action.path, source(action.path)));
        applied.push(action.path);
      } catch {
        failed.push(action.path);
      }
    }

    store.log({
      agent: 'turnback', session: 'restore', turn: target, kind: operation, ref: safety.ref,
      status: failed.length ? 'failed' : 'ok', paths: applied, note: JSON.stringify({ target, skipped, failed }),
    });
    if (applied.length) {
      const after = plan.scope === 'recorded-paths' ? applied : undefined;
      store.snapshotLocked('post-restore', { agent: 'turnback', session: 'restore', turn: target, paths: after }, after);
    }
    return { applied, skipped, failed, safety: safety.ref, plan };
  });
}

/** The baseline of a new agent turn starts a new undo history, like a new edit in an editor. */
const isNewTurn = (e: Entry) => e.agent !== 'turnback' && e.kind === 'baseline';

/** Next turn for `undo`: each consecutive undo steps back one more turn. */
export function undoTarget(store: Store): string | undefined {
  let depth = 0;
  for (const e of store.entries()) {
    if (e.status !== 'ok') continue;
    if (e.kind === 'restore' || isNewTurn(e)) depth = 0;
    else if (e.kind === 'undo') depth++;
    else if (e.kind === 'redo') depth = Math.max(0, depth - 1);
  }
  return store.turns()[depth]?.id;
}

/** Safety snapshot of the last restore/undo that has not been redone since the last agent turn. */
export function redoTarget(store: Store): string | undefined {
  const stack: string[] = [];
  for (const e of store.entries()) {
    if (e.status !== 'ok') continue;
    if (isNewTurn(e)) stack.length = 0;
    else if ((e.kind === 'restore' || e.kind === 'undo') && e.ref) stack.push(e.ref);
    else if (e.kind === 'redo') stack.pop();
  }
  return stack.at(-1);
}

export interface Recoverable {
  ref: string;
  entry: Entry;
  /** The turn whose snapshot holds that version, if any. */
  turn?: Turn;
  /** Workspace-relative files to restore from `ref`: the file itself, or the files of a folder that differ. */
  paths: string[];
}

/**
 * Newest snapshot holding a version of `absPath` that differs from the file on disk:
 * for a deleted file, the last snapshot that still had it. For a folder, the newest snapshot
 * with files that are missing or different on disk, and only those files.
 */
export function findRecoverable(store: Store, absPath: string): Recoverable | undefined {
  const rel = store.workspace.relative(absPath);
  if (!rel) throw new Error(`Path outside workspace: ${absPath}`);
  if (store.mode() === 'edits-only') throw new Error('recover needs full snapshots; this workspace is in edits-only mode');
  // Newest entry per snapshot ref, newest first.
  const newest = new Map<string, Entry>();
  for (const e of store.entries().reverse()) if (e.status === 'ok' && e.ref && !newest.has(e.ref)) newest.set(e.ref, e);
  const found = store.repo.lookup([...newest.keys()], rel);
  const onDisk = store.workspace.stat(rel);
  const folder = onDisk ? onDisk.isDirectory() : [...found.values()].some(f => f.tree);
  const oidLength = store.repo.objectIdLength();
  const recoverable = (ref: string, entry: Entry, paths: string[]): Recoverable =>
    ({ ref, entry, turn: store.turns().find(t => t.entries.some(e => e.id === entry.id)), paths });

  if (!folder) {
    const have = store.workspace.fileState(rel, oidLength);
    for (const [ref, entry] of newest) {
      const oid = found.get(ref)?.oid;
      if (oid && oid !== have?.oid) return recoverable(ref, entry, [rel]);
    }
    return undefined;
  }

  // A folder: the newest snapshot with files that are missing or different on disk. Files added
  // since are left alone, so only those files are restored, never the whole folder.
  const seen = new Set<string>();
  for (const [ref, entry] of newest) {
    const tree = found.get(ref)?.tree;
    if (!tree || seen.has(tree)) continue;
    seen.add(tree);
    const paths: string[] = [];
    for (const [name, item] of store.repo.tree(`${ref}:${rel}`)) {
      const file = `${rel}/${name}`;
      if (store.workspace.excluded(file)) continue;
      const have = store.workspace.fileState(file, oidLength);
      if (!have || have.oid !== item.oid || have.mode !== item.mode) paths.push(file);
    }
    if (paths.length) return recoverable(ref, entry, paths.sort());
  }
  return undefined;
}

/** Snapshot ref for a turn (its baseline), a mark label, or a ref. */
export function resolveRef(store: Store, target: string): string {
  return resolveTarget(store, store.entries(), target).ref;
}

/** Target is a turn ID (restored to its baseline), a mark label, or a snapshot ref, in that order. */
function resolveTarget(store: Store, entries: Entry[], target: string): { ref: string; since: number } {
  const turn = store.findTurn(target);
  if (turn) {
    const baseline = turn.entries.find(e => e.kind === 'baseline' && e.ref)!;
    return { ref: turn.baseline, since: entries.findIndex(e => e.id === baseline.id) };
  }
  const mark = store.marks().find(m => m.label === target);
  if (mark) return { ref: mark.ref, since: entries.findIndex(e => e.ref === mark.ref) };
  const since = entries.findIndex(e => e.ref === target);
  if (since >= 0 && store.repo.refExists(target)) return { ref: target, since };
  throw new Error(`Unknown turn or snapshot: ${target}`);
}

const sameFile = (a: TreeItem | FileState, b: TreeItem | FileState) => a.oid === b.oid && a.mode === b.mode;

/** Write one file byte for byte from the shadow repo, or delete it if absent from the target. */
function writeAction(store: Store, rel: string, object: TreeItem | undefined): void {
  const abs = store.workspace.abs(rel);
  assertNoSymlinkParent(store.root, abs);
  if (existsSync(abs)) {
    if (lstatSync(abs).isDirectory()) throw new Error(`Directory blocks file: ${rel}`);
    rmSync(abs, { force: true });
  }
  if (!object) {
    removeEmptyParents(store.root, abs);
    return;
  }
  mkdirSync(path.dirname(abs), { recursive: true });
  const content = store.repo.blob(object.oid);
  if (object.mode === '120000') {
    symlinkSync(content.toString(), abs);
    return;
  }
  writeFileSync(abs, content);
  if (process.platform !== 'win32') chmodSync(abs, object.mode === '100755' ? 0o755 : 0o644);
}

/** Never write through a directory symlink to outside the workspace. */
function assertNoSymlinkParent(root: string, abs: string): void {
  for (let dir = path.dirname(abs); isInside(root, dir); dir = path.dirname(dir)) {
    if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw new Error(`Symlink parent: ${dir}`);
  }
}

function removeEmptyParents(root: string, abs: string): void {
  for (let dir = path.dirname(abs); isInside(root, dir); dir = path.dirname(dir)) {
    try {
      if (readdirSync(dir).length) return;
      rmdirSync(dir);
    } catch {
      return;
    }
  }
}

/** On Windows, files open in another program fail with EBUSY/EPERM; retry briefly. */
function withRetry(fn: () => void, attempts = 3): void {
  for (let i = 1; ; i++) {
    try {
      return fn();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= attempts || (code !== 'EBUSY' && code !== 'EPERM')) throw e;
      sleep(100 * i);
    }
  }
}
