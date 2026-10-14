import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Store, TurnSummary } from './store.js';
import type { Turn } from './types.js';

export interface ExportResult {
  commit: string;
  paths: string[];
  /** Changed paths the repo ignores (for example .env); never committed. */
  ignored: string[];
}

/** Turns in chronological order, each with a recorded end. */
function selectTurns(store: Store, ids: string[]): Turn[] {
  if (!ids.length) throw new Error('Name at least one turn');
  const turns = ids.map(id => {
    const turn = store.findTurn(id);
    if (!turn?.end) throw new Error(`Unknown or incomplete turn: ${id}`);
    return turn;
  });
  return [...new Map(turns.map(t => [t.id, t])).values()].sort((a, b) => a.time.localeCompare(b.time));
}

function changedPaths(store: Store, turns: Turn[]): string[] {
  return [...new Set(turns.flatMap(t => store.repo.diffNames(t.baseline, t.end!)))].sort();
}

/** One patch from the oldest turn's baseline to the newest turn's end, limited to the paths those turns changed. */
export function exportPatch(store: Store, ids: string[]): string {
  const turns = selectTurns(store, ids);
  return store.repo.diffBinary(turns[0].baseline, turns.at(-1)!.end!, changedPaths(store, turns));
}

/** Subject from the prompt; several turns get a bullet list in the body. */
export function commitMessage(turns: TurnSummary[]): string {
  const label = (t: TurnSummary) => t.prompt ?? `Agent turn ${t.id}`;
  if (turns.length === 1) return `${label(turns[0])}\n\nTurnback turn: ${turns[0].id}`;
  return `${label(turns[0])} (+${turns.length - 1} more turns)\n\n${turns.map(t => `- ${label(t)} (${t.id})`).join('\n')}`;
}

/**
 * Commit the files changed by these turns to the user's own repository. Only these paths are committed;
 * anything else the user staged stays staged. Refused when a file no longer matches the newest turn's end.
 */
export function exportCommit(store: Store, ids: string[], message?: string): ExportResult {
  const turns = selectTurns(store, ids);
  const git = (args: string[], input?: string) => spawnSync('git', ['-C', store.root, ...args], { input, encoding: 'utf8', windowsHide: true });
  if (git(['rev-parse', '--is-inside-work-tree']).stdout.trim() !== 'true') throw new Error(`Not a git repository: ${store.root}`);

  const paths = changedPaths(store, turns);
  const end = store.repo.tree(turns.at(-1)!.end!);
  const oidLength = store.repo.objectIdLength();
  const drifted = paths.filter(p => {
    const want = end.get(p), have = store.workspace.fileState(p, oidLength);
    return want?.oid !== have?.oid || (!!want && !!have && want.mode !== have.mode);
  });
  if (drifted.length) throw new Error(`Files changed after the turn, so the commit would not match it: ${drifted.join(', ')}`);

  // Exits 1 when nothing is ignored; the list is on stdout either way.
  const ignored = git(['check-ignore', '--no-index', '-z', '--stdin'], paths.join('\0') + '\0').stdout.split('\0').filter(Boolean);
  // A file the turn deleted that git never tracked has nothing to commit, and `git add` would fail on it.
  const tracked = new Set(git(['ls-files', '-z']).stdout.split('\0').filter(Boolean));
  const committed = paths.filter(p => !ignored.includes(p) && (store.workspace.stat(p) !== undefined || tracked.has(p)));
  if (!committed.length) throw new Error('Nothing to commit: every changed file is ignored by git');

  const list = path.join(store.dir, `export-${randomUUID()}`);
  try {
    writeFileSync(list, committed.join('\0') + '\0');
    const pathspec = [`--pathspec-from-file=${list}`, '--pathspec-file-nul'];
    // Paths such as `app/[slug]/page.tsx` are not globs; check-ignore rejects this flag, so it is set per command.
    const literal = '--literal-pathspecs';
    const add = git([literal, 'add', '-A', ...pathspec]);
    if (add.status !== 0) throw new Error(`git add failed: ${add.stderr.trim()}`);
    const text = message ?? commitMessage(turns.map(t => store.summarize(t)));
    const commit = git([literal, 'commit', '--only', '-q', '-F', '-', ...pathspec], text);
    if (commit.status !== 0) throw new Error(`git commit failed: ${(commit.stderr || commit.stdout).trim()}`);
  } finally {
    rmSync(list, { force: true });
  }
  return { commit: git(['rev-parse', 'HEAD']).stdout.trim(), paths: committed, ignored };
}
