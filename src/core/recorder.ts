import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isInside, promptLabel, WARM_WAIT_MS, workspaceRoot, workspaceRootForFile } from './config.js';
import { turnKey } from './journal.js';
import { waitForUnlock } from './lock.js';
import { originFields, Store } from './store.js';
import type { Entry, HookEvent } from './types.js';

/**
 * Apply the snapshot rules for one hook event:
 * - the first mutating tool in a turn takes the baseline,
 * - later edits snapshot only the affected paths,
 * - shell commands snapshot the whole tree,
 * - the end of the turn snapshots the result.
 * In `edits-only` mode, shell is not snapshotted and every snapshot is limited to edit paths.
 *
 * Edits are recorded in the workspace that contains the file, not always the session's working
 * folder, so files in other projects stay protected. Shell commands still use the session folder.
 */
export function record(event: HookEvent): Entry | undefined {
  const home = new Store(event.cwd);
  if (event.kind === 'edit' && event.paths?.length) return recordEdit(home, event, event.paths);
  if (event.kind === 'turn-end') {
    for (const root of takeForeignRoots(home, event)) recordIn(new Store(root), { ...event, cwd: root });
  }
  return recordIn(home, event);
}

function recordEdit(home: Store, event: HookEvent, paths: string[]): Entry | undefined {
  const groups = new Map<string, string[]>();
  for (const file of paths) {
    const root = isInside(home.root, file) ? home.root : workspaceRootForFile(file);
    groups.set(root, [...(groups.get(root) ?? []), file]);
  }
  let result: Entry | undefined;
  for (const [root, group] of groups) {
    const local = root === home.root;
    if (!local) rememberForeignRoot(home, event, root);
    const entry = recordIn(local ? home : new Store(root), { ...event, cwd: root, paths: group });
    if (local || !result) result = entry;
  }
  return result;
}

function recordIn(store: Store, event: HookEvent): Entry | undefined {
  const turn = store.entries().filter(e => turnKey(e) === turnKey(event));
  const origin = originFields(event);

  switch (event.kind) {
    case 'session-start':
      return store.log({ ...origin, kind: event.kind, status: 'ok' });
    case 'turn-start':
      return store.log({ ...origin, kind: event.kind, status: 'ok', prompt: promptLabel(event.prompt) });
    case 'turn-end':
      return endTurn(store, event, turn);
    default:
      return recordChange(store, event, turn);
  }
}

function recordChange(store: Store, event: HookEvent, turn: Entry[]): Entry {
  const origin = originFields(event);
  if (!turn.some(e => e.kind === 'baseline' && e.status === 'ok')) decideMode(store);
  const editsOnly = store.mode() === 'edits-only';

  if (editsOnly && (event.kind === 'shell' || !event.paths?.length)) {
    return store.log({ ...origin, kind: event.kind, status: 'unprotected', note: 'edits-only mode: only edited paths are snapshotted' });
  }
  if (!turn.some(e => e.kind === 'baseline' && e.status === 'ok')) {
    return takeBaseline(store, event, editsOnly);
  }
  if (event.kind === 'edit' && (editsOnly || !hadShell(turn))) {
    // Save the result of the previous edit and the content of the paths about to change.
    const previous = turn.findLast(e => e.paths?.length);
    return store.snapshot('edit', origin, [...(previous?.paths ?? []), ...(event.paths ?? [])]);
  }
  return store.snapshot(event.kind, origin);
}

/**
 * Before a turn's first change the mode must be known: wait for a warm that is still deciding it,
 * and decide it now if this workspace was never warmed. Otherwise a workspace above the edits-only
 * limit would get a full snapshot inside the hook.
 */
function decideMode(store: Store): void {
  waitForUnlock(store.dir, WARM_WAIT_MS);
  if (store.mode() === 'full' && !store.latestRef()) store.warm();
}

function takeBaseline(store: Store, event: HookEvent, editsOnly: boolean): Entry {
  const origin = originFields(event);
  if (editsOnly) return store.snapshot('baseline', origin, event.paths);

  const start = Date.now();
  const warm = store.waitWarm();
  if (!warm && Date.now() - start >= WARM_WAIT_MS) {
    return store.log({ ...origin, kind: event.kind, status: 'unprotected', note: 'Warm baseline exceeded 30 seconds' });
  }
  const baseline = warm
    ? store.log({ ...origin, kind: 'baseline', ref: warm, status: 'ok' })
    : store.snapshot('baseline', origin);
  if (baseline.status !== 'ok') {
    return store.log({ ...origin, kind: event.kind, status: 'unprotected', note: 'Baseline unavailable' });
  }
  return baseline;
}

function endTurn(store: Store, event: HookEvent, turn: Entry[]): Entry {
  const origin = originFields(event);
  if (!turn.some(e => e.kind === 'baseline')) return store.log({ ...origin, kind: 'turn-end', status: 'ok' });

  const edited = [...new Set(turn.flatMap(e => e.paths ?? []))];
  const pathsOnly = store.mode() === 'edits-only' || !hadShell(turn);
  return store.snapshot('turn-end', origin, pathsOnly && edited.length ? edited : undefined);
}

/**
 * Other workspaces touched by edits in this turn, stored in the session workspace's data folder.
 * When the turn ends, those workspaces get an end-of-turn snapshot too.
 */
const foreignFile = (home: Store) => path.join(home.dir, 'foreign-turns.json');

function readForeign(home: Store): Record<string, string[]> {
  try { return JSON.parse(readFileSync(foreignFile(home), 'utf8')); } catch { return {}; }
}

function rememberForeignRoot(home: Store, event: HookEvent, root: string): void {
  const all = readForeign(home);
  const key = turnKey(event);
  if (all[key]?.includes(root)) return;
  all[key] = [...(all[key] ?? []), root];
  mkdirSync(home.dir, { recursive: true });
  writeFileSync(foreignFile(home), JSON.stringify(all));
}

function takeForeignRoots(home: Store, event: HookEvent): string[] {
  const all = readForeign(home);
  const roots = all[turnKey(event)] ?? [];
  if (!roots.length) return [];
  delete all[turnKey(event)];
  writeFileSync(foreignFile(home), JSON.stringify(all));
  return roots.filter(root => workspaceRoot(root) !== home.root);
}

/** Adapters fill `command` only for shell events. */
export const hadShell = (turn: Entry[]) => turn.some(e => e.command !== undefined);

/** Other workspaces this turn edited, read before the end of the turn consumes the list. */
export function pendingForeignRoots(event: HookEvent): string[] {
  const home = new Store(event.cwd);
  return (readForeign(home)[turnKey(event)] ?? []).filter(root => workspaceRoot(root) !== home.root);
}
