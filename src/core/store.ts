import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, lstatSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  COMPACT_LOOSE, EDITS_ONLY_BYTES, editsOnlyFiles, WORKSPACE_FILE, GC_INTERVAL_MS, LOCK_TIMEOUT_MS, PROBE_TTL_MS, RETENTION, WARM_WAIT_MS,
  canonicalPath, pathKey, workspaceDataDir, workspaceRoot,
} from './config.js';
import { Journal, turnKey } from './journal.js';
import { QUOTE_SAFE } from './quote.js';
import { LockTimeoutError, waitForUnlock, withLock } from './lock.js';
import { ShadowRepo } from '../git/shadow.js';
import type { Entry, EntryKind, EntryOrigin, Mark, Mode, NewEntry, Step, Turn } from './types.js';
import { Workspace, type Scan } from '../workspace/workspace.js';

const WARM_ORIGIN: EntryOrigin = { agent: 'turnback', session: 'warm', turn: 'warm' };
const CORRUPT_PREFIX = 'corrupt-';

export interface TurnSummary {
  id: string;
  agent: Turn['agent'];
  time: string;
  status: Turn['status'];
  baseline: string;
  end?: string;
  prompt?: string;
  changedFiles: number;
}

export interface GcOptions {
  now?: number;
  keepDays?: number;
  keepTurns?: number;
  /** Pack the shadow repo even when nothing expired and it is under the limits. */
  compact?: boolean;
}

/** All Turnback data for one workspace: journal, shadow repo, and recording mode. */
export class Store {
  readonly root: string;
  readonly dir: string;
  readonly workspace: Workspace;
  readonly repo: ShadowRepo;
  private readonly journal: Journal;

  constructor(cwd: string) {
    this.root = workspaceRoot(cwd);
    this.dir = workspaceDataDir(this.root);
    this.workspace = new Workspace(this.root);
    this.repo = new ShadowRepo(this.dir, this.root);
    this.journal = new Journal(path.join(this.dir, 'journal.jsonl'));
  }

  entries(): Entry[] {
    return this.journal.read();
  }

  log(entry: NewEntry): Entry {
    const logged = this.journal.append(entry);
    this.noteRoot();
    return logged;
  }

  private rootNoted = false;

  /** Write `workspace.json` once, so `turnback du` can tell which workspace this data belongs to. */
  private noteRoot(): void {
    if (this.rootNoted) return;
    this.rootNoted = true;
    const file = path.join(this.dir, WORKSPACE_FILE);
    try {
      if (!existsSync(file)) writeFileSync(file, JSON.stringify({ root: this.root }));
    } catch { /* only used by du */ }
  }

  latestRef(): string | undefined {
    // Probes (diff_range) are never a base: a turn's later snapshots must not absorb what a probe saw.
    return this.entries().filter(e => e.ref && e.status === 'ok' && e.kind !== 'probe').at(-1)?.ref;
  }

  locked<T>(fn: () => T): T {
    return withLock(this.dir, LOCK_TIMEOUT_MS, fn);
  }

  // ---- Mode ----

  /**
   * `edits-only` is used for workspaces above 100k files or 2 GB: only paths touched
   * by edit tools are snapshotted. The mode is decided by `warm` and persisted.
   */
  mode(): Mode {
    try {
      return JSON.parse(readFileSync(this.modeFile, 'utf8')).mode === 'edits-only' ? 'edits-only' : 'full';
    } catch {
      return 'full';
    }
  }

  private get modeFile(): string {
    return path.join(this.dir, 'mode.json');
  }

  private static modeFor(scan: Scan): Mode {
    return scan.paths.length > editsOnlyFiles() || scan.bytes > EDITS_ONLY_BYTES ? 'edits-only' : 'full';
  }

  // ---- Snapshot ----

  /**
   * Snapshot under the lock. Failures or lock timeouts are recorded in the journal, not thrown.
   * If the snapshot failed because the shadow repo is corrupt, it is moved aside and the
   * snapshot is retried once on a fresh repo, which then serves as the new baseline.
   */
  snapshot(kind: EntryKind, origin: EntryOrigin, scope?: string[]): Entry {
    try {
      return this.locked(() => {
        try {
          return this.snapshotLocked(kind, origin, scope);
        } catch (e) {
          if (!this.repo.isCorrupt()) throw e;
          const folder = this.quarantine();
          this.log({ ...originFields(origin), kind: 'repair', status: 'ok', note: `Corrupt shadow repo moved to ${folder}: ${e}` });
          return this.snapshotLocked(kind, origin, scope);
        }
      });
    } catch (e) {
      return this.log({ ...originFields(origin), kind, status: e instanceof LockTimeoutError ? 'skipped' : 'failed', note: String(e) });
    }
  }

  /**
   * Save the workspace state as a new commit. Without `scope`, the whole tree is compared
   * with the previous snapshot; with `scope`, only those paths are updated in the index.
   * The first full snapshot is written through `git fast-import` (see `ShadowRepo.importSnapshot`).
   * Must be called inside the lock.
   */
  snapshotLocked(kind: EntryKind, origin: EntryOrigin, scope?: string[]): Entry {
    this.repo.init();
    const previous = this.latestRef();
    let skipped: string[] = [];

    if (!previous && !scope) {
      const scan = this.workspace.scan();
      const ref = this.repo.importSnapshot(scan.paths, rel => this.workspace.read(rel), kind);
      return this.log({ ...originFields(origin), kind, ref, status: 'ok', note: skippedNote(scan.skipped) });
    }

    if (!previous) {
      this.repo.load();
      this.repo.stage(this.relativePaths(scope!).filter(p => this.workspace.snapshotable(p)));
    } else {
      this.repo.load(previous);
      const changes = this.classify(scope ? this.relativePaths(scope) : this.repo.changedPaths());
      skipped = changes.skipped;
      this.repo.unstage(changes.remove);
      this.repo.stage(changes.add);
      if (!changes.add.length && !changes.remove.length) {
        return this.log({ ...originFields(origin), kind, ref: previous, status: 'ok' });
      }
    }

    const ref = this.repo.commit(kind);
    return this.log({ ...originFields(origin), kind, ref, status: 'ok', note: skippedNote(skipped) });
  }

  /**
   * Move the unusable shadow repo and its journal into `corrupt-<time>/`; nothing is deleted.
   * The lock file stays in place, so other processes keep waiting on the same lock.
   */
  private quarantine(): string {
    const folder = path.join(this.dir, `${CORRUPT_PREFIX}${new Date().toISOString().replace(/[:.]/g, '-')}`);
    mkdirSync(folder, { recursive: true });
    for (const name of ['repo.git', 'journal.jsonl', 'index-ref']) {
      const from = path.join(this.dir, name);
      if (existsSync(from)) renameSync(from, path.join(folder, name));
    }
    return folder;
  }

  relativePaths(paths: string[]): string[] {
    return [...new Set(paths.flatMap(p => this.workspace.relative(p) ?? []))];
  }

  private classify(paths: string[]) {
    const add: string[] = [], remove: string[] = [], skipped: string[] = [];
    for (const p of new Set(paths)) {
      if (this.workspace.excluded(p)) {
        remove.push(p);
        continue;
      }
      const st = this.workspace.stat(p);
      if (!st) remove.push(p);
      else if (!st.isFile() && !st.isSymbolicLink()) continue;
      else if (this.workspace.snapshotable(p)) add.push(p);
      else {
        skipped.push(p);
        remove.push(p);
      }
    }
    return { add, remove, skipped };
  }

  // ---- Background baseline ----

  /** The expensive first snapshot, run in the background on install and session start. */
  warm(): Entry {
    try {
      // The lock is held while the mode is decided, so a hook waiting for warm never scans or
      // snapshots the workspace a second time. The scan stops at the edits-only limit, which also
      // bounds how long the lock is held.
      return this.locked(() => {
        if (this.mode() === 'edits-only') {
          return this.log({ ...WARM_ORIGIN, kind: 'warm', status: 'ok', note: 'edits-only mode already decided' });
        }
        if (Store.modeFor(this.workspace.scan({ files: editsOnlyFiles(), bytes: EDITS_ONLY_BYTES })) === 'edits-only') {
          mkdirSync(this.dir, { recursive: true });
          writeFileSync(this.modeFile, JSON.stringify({ mode: 'edits-only' }));
          return this.log({ ...WARM_ORIGIN, kind: 'warm', status: 'ok', note: 'edits-only mode; shell commands are not snapshotted' });
        }
        return this.snapshotLocked('warm', WARM_ORIGIN);
      });
    } catch (e) {
      return this.log({ ...WARM_ORIGIN, kind: 'warm', status: 'failed', note: String(e) });
    }
  }

  /**
   * Wait for warm to finish, then return the last snapshot if it still matches the work-tree.
   * That way the turn baseline does not need a new snapshot.
   */
  waitWarm(): string | undefined {
    waitForUnlock(this.dir, WARM_WAIT_MS);
    const ref = this.latestRef();
    if (!ref) return undefined;
    try {
      return this.repo.indexMatches(ref, rel => this.workspace.excluded(rel)) ? ref : undefined;
    } catch {
      return undefined;
    }
  }

  // ---- Turn history ----

  /** Agent turns that have a baseline, newest first. Turns removed by gc are excluded. */
  turns(): Turn[] {
    const expired = new Set(this.expiredTurns());
    const groups = new Map<string, Entry[]>();
    for (const e of this.entries()) {
      if (e.agent === 'turnback' || e.kind === 'session-start') continue;
      const key = turnKey(e);
      groups.set(key, [...(groups.get(key) ?? []), e]);
    }
    const turns: Turn[] = [];
    for (const [id, entries] of groups) {
      const baseline = entries.find(e => e.kind === 'baseline' && e.ref)?.ref;
      if (!baseline || expired.has(id)) continue;
      turns.push({
        id,
        agent: entries[0].agent,
        time: entries[0].time,
        baseline,
        end: entries.findLast(e => e.ref)?.ref,
        status: entries.every(e => e.status === 'ok') ? 'ok' : 'partial',
        entries,
      });
    }
    return turns.reverse();
  }

  /** Find a turn by full ID (`agent:session:turn`) or by turn ID alone. */
  findTurn(id: string): Turn | undefined {
    return this.turns().find(t => t.id === id || t.id.endsWith(':' + id));
  }

  summarize(turn: Turn, names?: string[]): TurnSummary {
    const { entries, ...rest } = turn;
    const prompt = entries.find(e => e.kind === 'turn-start')?.prompt;
    const changed = names ?? (turn.end ? this.repo.diffNames(turn.baseline, turn.end) : []);
    return { ...rest, prompt, changedFiles: changed.length };
  }

  /** Turns whose changes include a file, or any file under a folder; newest first. */
  fileHistory(absPath: string): TurnSummary[] {
    const rel = pathKey(canonicalPath(path.resolve(this.root, absPath))) === pathKey(this.root) ? '' : this.workspace.relative(absPath);
    if (rel === undefined) throw new Error(`Path outside workspace: ${absPath}`);
    const key = pathKey(this.workspace.abs(rel));
    return this.turns().flatMap(turn => {
      if (!turn.end) return [];
      const names = this.repo.diffNames(turn.baseline, turn.end);
      return names.some(n => {
        const changed = pathKey(this.workspace.abs(n));
        return rel === '' || changed === key || changed.startsWith(key + '/');
      }) ? [this.summarize(turn, names)] : [];
    });
  }

  turnDiff(id: string, patch: boolean): { turn: string; diff: string } {
    const turn = this.findTurn(id);
    if (!turn?.end) throw new Error(`Unknown or incomplete turn: ${id}`);
    const diff = patch ? this.repo.diffPatch(turn.baseline, turn.end) : this.repo.diffStat(turn.baseline, turn.end);
    return { turn: turn.id, diff };
  }

  /** Snapshot the whole workspace under a label. Marks belong to Turnback, so gc never removes them. */
  mark(label: string): Mark {
    const name = label.trim();
    if (!name) throw new Error('A mark needs a label');
    if (!QUOTE_SAFE.test(name)) throw new Error('Mark labels may contain letters, digits, spaces, and _ . : / @ # + , = - only, so they can be pasted into a shell');
    if (this.findTurn(name)) throw new Error(`Mark label "${name}" matches a turn ID; choose a different label`);
    if (this.mode() === 'edits-only') throw new Error('Marks are unavailable in edits-only mode: only edited paths are snapshotted');
    const entry = this.snapshot('mark', { agent: 'turnback', session: 'mark', turn: name });
    if (entry.status !== 'ok' || !entry.ref) throw new Error(`Mark failed: ${entry.note ?? entry.status}`);
    return { label: name, time: entry.time, ref: entry.ref };
  }

  /** Turns whose prompt, shell commands, or edited paths contain `query` (case-insensitive); newest first. */
  searchTurns(query: string): TurnSummary[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    return this.turns().filter(turn => turn.entries.some(e =>
      [e.prompt, e.command, ...(e.paths ? this.relativePaths(e.paths) : [])].some(text => text?.toLowerCase().includes(needle)),
    )).map(t => this.summarize(t));
  }

  /** Snapshot the current files for a read-only comparison. gc removes probes after a day. */
  probe(): string {
    if (this.mode() === 'edits-only') throw new Error('The current files cannot be compared in edits-only mode: only edited paths are snapshotted. Pass `to` instead.');
    const entry = this.snapshot('probe', { agent: 'turnback', session: 'probe', turn: randomUUID() });
    if (entry.status !== 'ok' || !entry.ref) throw new Error(`Snapshot failed: ${entry.note ?? entry.status}`);
    return entry.ref;
  }

  /** Marks, newest first. */
  marks(): Mark[] {
    return this.entries()
      .filter(e => e.kind === 'mark' && e.status === 'ok' && e.ref)
      .map(e => ({ label: e.turn, time: e.time, ref: e.ref! }))
      .reverse();
  }

  /** Edit and shell steps of a turn, in order. Each ref is the snapshot taken just before that step ran. */
  steps(id: string): Step[] {
    const turn = this.findTurn(id);
    if (!turn) throw new Error(`Unknown turn: ${id}`);
    // A failed baseline is followed by an `unprotected` entry for the same tool call.
    const calls = turn.entries.filter(isStepEntry);
    const scoped = this.mode() === 'full';
    let shellSeen = false, gap = false;
    return calls.map((e, i) => {
      const kind = e.command !== undefined ? 'shell' : 'edit';
      // Before any shell step, an edit snapshot only refreshes the previous edit's paths. If an earlier
      // snapshot is missing, this one can hold stale content for the files that step changed.
      const stale = scoped && kind === 'edit' && !shellSeen && gap;
      const step: Step = {
        n: i + 1,
        kind,
        time: e.time,
        command: e.command,
        paths: e.paths ? this.relativePaths(e.paths) : undefined,
        ref: e.status === 'ok' && !stale ? e.ref : undefined,
        status: e.status,
        reason: stale && e.status === 'ok' ? 'an earlier step has no snapshot, so this one may miss its changes' : undefined,
      };
      if (!(e.status === 'ok' && e.ref)) gap = true;
      if (kind === 'shell') shellSeen = true;
      return step;
    });
  }

  /** Snapshot ref to restore the workspace to just before step `n` of a turn. */
  stepRef(id: string, n: number): string {
    const steps = this.steps(id);
    const step = Number.isInteger(n) ? steps[n - 1] : undefined;
    if (!step) throw new Error(`Turn ${id} has ${steps.length} steps; choose 1 to ${steps.length}`);
    if (!step.ref) throw new Error(`Step ${n} has no snapshot to restore (${step.reason ?? step.status}); choose another step`);
    return step.ref;
  }

  // ---- Status and cleanup ----

  status() {
    // Large workspaces are the slow ones to scan, and they are in edits-only mode, where only edited
    // paths are snapshotted and a list of skipped files says little. So status scans only until the
    // edits-only limit, like warm, and not at all once that mode is decided.
    const decided = this.mode() === 'edits-only';
    const scan = decided ? undefined : this.workspace.scan({ files: editsOnlyFiles(), bytes: EDITS_ONLY_BYTES });
    const entries = this.entries();
    return {
      workspace: this.root,
      storage: this.dir,
      storageBytes: directorySize(this.dir),
      mode: decided || Store.modeFor(scan!) === 'edits-only' ? 'edits-only' : 'full',
      turns: this.turns().length,
      lastGc: entries.findLast(e => e.kind === 'gc' && e.status === 'ok')?.time,
      skippedFiles: scan && !scan.truncated ? scan.skipped : [],
      failures: entries.filter(e => e.status !== 'ok').slice(-20),
      corrupt: existsSync(this.dir)
        ? readdirSync(this.dir).filter(name => name.startsWith(CORRUPT_PREFIX)).map(name => path.join(this.dir, name))
        : [],
    };
  }

  /**
   * Delete turns older than 7 days that are not among the last 50 turns.
   * Refs still used by other turns or by internal Turnback snapshots are kept.
   */
  gc({ now = Date.now(), keepDays = RETENTION.days, keepTurns = RETENTION.turns, compact = false }: GcOptions = {}) {
    return this.locked(() => {
      const turns = this.turns();
      const cutoff = now - keepDays * 24 * 60 * 60 * 1000;
      const expired = turns.filter((t, i) => i >= keepTurns && Date.parse(t.time) < cutoff);
      const expiredIds = new Set(expired.map(t => t.id));

      const entries = this.entries();
      const keep = new Set(entries.filter(e => e.agent === 'turnback' && e.kind !== 'probe').flatMap(e => e.ref ?? []));
      for (const t of turns) if (!expiredIds.has(t.id)) for (const e of t.entries) if (e.ref) keep.add(e.ref);
      const deleted = new Set(expired.flatMap(t => t.entries.flatMap(e => e.ref && !keep.has(e.ref) ? [e.ref] : [])));
      // The latest ref is the base of the next snapshot, so it stays even when it is an old probe.
      const latest = this.latestRef();
      for (const e of entries) {
        if (e.kind === 'probe' && e.ref && !keep.has(e.ref) && e.ref !== latest && now - Date.parse(e.time) > PROBE_TTL_MS) deleted.add(e.ref);
      }

      for (const ref of deleted) this.repo.deleteRef(ref);
      if (expired.length) {
        writeFileSync(this.expiredFile, JSON.stringify([...new Set([...this.expiredTurns(), ...expiredIds])]));
      }
      // Packing also removes what deleted refs left behind and leftovers of interrupted writes.
      const compacted = compact || deleted.size > 0 || this.needsCompaction();
      if (compacted) this.repo.prune();
      this.log({ agent: 'turnback', session: 'gc', turn: 'gc', kind: 'gc', status: 'ok', note: `Expired ${expired.length} turns${compacted ? '; packed' : ''}` });
      return { expired: expired.length, deletedRefs: deleted.size, compacted };
    });
  }

  private needsCompaction(): boolean {
    const stats = this.repo.objectStats();
    return stats.garbage > 0 || stats.loose >= COMPACT_LOOSE.count || stats.looseBytes >= COMPACT_LOOSE.bytes;
  }

  /** Run `gc` if the last one was more than 24 hours ago. */
  gcIfDue(now = Date.now()) {
    const last = this.entries().findLast(e => e.kind === 'gc' && e.status === 'ok');
    if (last && now - Date.parse(last.time) < GC_INTERVAL_MS) return undefined;
    return this.gc({ now });
  }

  private get expiredFile(): string {
    return path.join(this.dir, 'expired.json');
  }

  private expiredTurns(): string[] {
    try { return JSON.parse(readFileSync(this.expiredFile, 'utf8')); } catch { return []; }
  }
}

/** Which journal entries count as steps of a turn, shared by `Store.steps` and `turnStats`. */
export function isStepEntry(e: Entry): boolean {
  return e.kind === 'edit' || e.kind === 'shell' || (e.kind === 'baseline' && e.status === 'ok');
}

export function originFields(o: EntryOrigin): EntryOrigin {
  return { agent: o.agent, session: o.session, turn: o.turn, paths: o.paths, command: o.command };
}

export function directorySize(dir: string): number {
  let total = 0;
  try {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      try { total += item.isDirectory() ? directorySize(file) : lstatSync(file).size; } catch { /* removed by gc */ }
    }
  } catch { /* no snapshot yet */ }
  return total;
}

const skippedNote = (skipped: string[]) =>
  skipped.length ? `Skipped ${skipped.length}: ${skipped.slice(0, 20).join(', ')}` : undefined;
