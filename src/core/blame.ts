import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MAX_FILE_BYTES } from './config.js';
import { shellArg } from './quote.js';
import type { Hunk } from '../git/shadow.js';
import type { Store, TurnSummary } from './store.js';

export type BlameSource = 'turn' | 'before' | 'outside';

export interface BlameLine {
  line: number;
  text: string;
  source: BlameSource;
  turn?: TurnSummary;
}

type Label = { source: 'before' | 'outside' } | { source: 'turn'; turn: TurnSummary };

const BEFORE: Label = { source: 'before' };
const OUTSIDE: Label = { source: 'outside' };

/** Carry labels from one version to the next: removed lines drop out, added lines get `label`. */
export function applyHunks<T>(labels: T[], hunks: Hunk[], label: T): T[] {
  const next: T[] = [];
  let done = 0;
  for (const h of hunks) {
    // With no removed lines, git names the line the insertion follows.
    const start = h.oldCount === 0 ? h.oldStart : h.oldStart - 1;
    next.push(...labels.slice(done, start), ...Array<T>(h.newCount).fill(label));
    done = start + h.oldCount;
  }
  next.push(...labels.slice(done));
  return next;
}

function splitLines(content: Buffer): string[] {
  const text = content.toString('utf8');
  if (!text) return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map(l => l.endsWith('\r') ? l.slice(0, -1) : l);
}

/**
 * Who last wrote each line of a text file: a turn, nobody since Turnback started recording (`before`),
 * or a change between turns (`outside`). Versions run baseline → end of each turn that changed the
 * file, oldest first, then the file on disk.
 */
export function blameFile(store: Store, absPath: string): BlameLine[] {
  const rel = store.workspace.relative(absPath);
  if (!rel) throw new Error(`Path outside workspace: ${absPath}`);
  let disk: Buffer;
  try {
    disk = readFileSync(store.workspace.abs(rel));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EISDIR' || store.workspace.stat(rel)?.isDirectory()) throw new Error(`${rel} is a directory; blame shows text files only.`);
    if (code === 'EACCES' || code === 'EPERM') throw new Error(`Cannot read ${rel}: permission denied.`);
    if (code !== 'ENOENT') throw error;
    const file = shellArg(path.relative(process.cwd(), store.workspace.abs(rel)).split(path.sep).join('/'));
    throw new Error(`${rel} is not on disk.${file ? ` To bring back a deleted file, run: turnback recover ${file}` : ''}`);
  }
  if (disk.length > MAX_FILE_BYTES || disk.subarray(0, 8000).includes(0)) {
    throw new Error('Binary or large file; blame shows text files only.');
  }

  const lines = splitLines(disk);
  const repo = store.repo;
  const refs = [...new Set(store.entries().flatMap(e => e.status === 'ok' && e.ref ? [e.ref] : []))];
  const found = refs.length ? repo.lookup(refs, rel) : new Map<string, { exists: boolean; oid?: string }>();
  // The file as it was when Turnback started recording it. In edits-only mode a snapshot holds only
  // the paths edited so far, so recording of this file starts with the first snapshot that has it.
  const editsOnly = store.mode() === 'edits-only';
  const first = refs.find(ref => found.get(ref)?.exists && (!editsOnly || found.get(ref)?.oid));
  // Nothing recorded yet (and maybe no shadow repo): every line predates Turnback.
  if (!first) return lines.map((text, i) => ({ line: i + 1, text, source: 'before' }));

  const empty = repo.writeBlob(Buffer.alloc(0));
  const oidAt = (ref: string) => found.get(ref)?.oid ?? empty;
  // Finished turns only: an unfinished turn has no end snapshot, so its changes count as outside.
  const turns = store.turns().reverse().flatMap(turn => {
    const end = turn.entries.findLast(e => e.kind === 'turn-end' && e.status === 'ok' && e.ref)?.ref;
    return end && oidAt(turn.baseline) !== oidAt(end) ? [{ summary: store.summarize(turn, []), baseline: turn.baseline, end }] : [];
  });

  let current = oidAt(first);
  let labels = splitLines(repo.blob(current)).map(() => BEFORE);
  // Labels of every version seen so far: a change outside a turn that returns the file to an earlier
  // version (an undo, a recover, a manual revert) gets that version's labels back.
  const seen = new Map([[current, labels]]);
  const step = (next: string, label: Label) => {
    if (next === current) return;
    const earlier = label === OUTSIDE ? seen.get(next) : undefined;
    const hunks = earlier ? undefined : repo.lineHunks(current, next);
    labels = earlier ?? (hunks ? applyHunks(labels, hunks, label) : splitLines(repo.blob(next)).map(() => label));
    seen.set(next, labels);
    current = next;
  };
  for (const turn of turns) {
    step(oidAt(turn.baseline), OUTSIDE);
    step(oidAt(turn.end), { source: 'turn', turn: turn.summary });
  }
  step(repo.writeBlob(disk), OUTSIDE);

  if (labels.length !== lines.length) throw new Error(`blame: ${labels.length} labels for ${lines.length} lines in ${rel}`);
  return lines.map((text, i) => {
    const label = labels[i];
    return label.source === 'turn' ? { line: i + 1, text, source: 'turn', turn: label.turn } : { line: i + 1, text, source: label.source };
  });
}
