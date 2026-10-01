import path from 'node:path';
import type { Operation, RestorePlan, RestoreResult } from './restore.js';
import type { Store, TurnSummary } from './store.js';
import type { Mark, Step } from './types.js';
import type { BlameLine } from './blame.js';
import type { WorkspaceUsage } from './du.js';

const pad = (n: number) => String(n).padStart(2, '0');

/** Local time as `YYYY-MM-DD HH:MM`. */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Newest-first turn list for people: one header line per turn, then its ID. */
export function formatTurns(turns: TurnSummary[]): string {
  if (!turns.length) return 'No turns recorded yet.';
  return turns.map((t, i) => {
    const files = `${t.changedFiles} ${t.changedFiles === 1 ? 'file ' : 'files'}`;
    const partial = t.status === 'ok' ? '' : '[partial] ';
    const label = t.prompt ? JSON.stringify(t.prompt) : '(no prompt)';
    return `#${i + 1} ${formatTime(t.time)}  ${t.agent.padEnd(11)} ${files.padStart(9)}  ${partial}${label}\n   ${t.id}`;
  }).join('\n');
}

/** Steps of one turn: number, local time, kind, then the command or edited paths. */
export function formatSteps(steps: Step[]): string {
  if (!steps.length) return 'No edit or shell steps in this turn.';
  return steps.map(s => {
    const detail = s.kind === 'shell' ? s.command ?? '' : (s.paths ?? []).join(', ');
    const missing = s.ref ? '' : `  (no snapshot: ${s.reason ?? s.status})`;
    return `${s.n}. ${formatTime(s.time).slice(11)}  ${s.kind.padEnd(5)}  ${detail}${missing}`;
  }).join('\n');
}

/** Marks, newest first: number, local time, label, then ref. */
export function formatMarks(marks: Mark[]): string {
  if (!marks.length) return 'No marks yet. Create one with `turnback mark <label>`.';
  return marks.map((m, i) => `#${i + 1} ${formatTime(m.time)}  ${JSON.stringify(m.label)}\n   ${m.ref}`).join('\n');
}

const ACTION_WORD = { create: 'restore', modify: 'revert', delete: 'remove' } as const;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A restore plan for people: a title line, one line per file, then a count unless the result follows. */
export function formatPlan(title: string, plan: Pick<RestorePlan, 'scope' | 'actions' | 'skippedLarge'>, applying = false): string {
  const lines = [title];
  if (plan.scope === 'recorded-paths') lines.push('(edits-only mode: only paths recorded by edit tools are restored)');
  for (const a of plan.actions) {
    const note = a.uncertain ? "  (changed since Turnback's last snapshot, maybe by you)" : '';
    lines.push(`  ${ACTION_WORD[a.action].padEnd(8)} ${a.path}${note}`);
  }
  if (plan.skippedLarge.length) lines.push(`Skipped, over 5 MB: ${plan.skippedLarge.join(', ')}`);
  if (!plan.actions.length) lines.push('Nothing to change.');
  else if (!applying) lines.push(`${plural(plan.actions.length, 'file')} would change.`);
  return lines.join('\n');
}

/** Outcome of an applied restore, with the way back. */
export function formatRestoreResult(result: Pick<RestoreResult, 'applied' | 'failed' | 'safety'>, operation: Operation, agentTurn: boolean): string {
  const lines = [`Restored ${plural(result.applied.length, 'file')}.`];
  if (result.failed.length) lines.push(`Failed: ${result.failed.join(', ')}`);
  lines.push(operation === 'redo'
    ? `The files before this redo are kept in ${result.safety}.`
    : 'Changed your mind? Run: turnback redo --yes');
  if (agentTurn) lines.push("The agent's conversation is not restored; tell the agent what changed.");
  return lines.join('\n');
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['kB', 'MB', 'GB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

/** `turnback status` as aligned fields; details stay in `--json`. */
export function formatStatus(s: ReturnType<Store['status']>): string {
  const problems = [
    s.skippedFiles.length ? `${plural(s.skippedFiles.length, 'file')} skipped` : '',
    s.failures.length ? `${plural(s.failures.length, 'failed or unprotected snapshot')}` : '',
    s.corrupt.length ? `${plural(s.corrupt.length, 'corrupt shadow repo')} moved aside` : '',
  ].filter(Boolean);
  const rows: [string, string][] = [
    ['Workspace', s.workspace],
    ['Mode', s.mode],
    ['Turns', String(s.turns)],
    ['Storage', `${formatBytes(s.storageBytes)} in ${s.storage}`],
    ['Last gc', s.lastGc ? formatTime(s.lastGc) : 'never'],
    ['Problems', problems.length ? `${problems.join(', ')} (details: turnback status --json)` : 'none'],
  ];
  return rows.map(([k, v]) => `${k.padEnd(10)}${v}`).join('\n');
}

/** Config files written or cleaned by install/uninstall, relative to the workspace root when inside it. */
export function formatConfigFiles(heading: string, files: string[], root: string): string {
  if (!files.length) return `${heading}: nothing to change.`;
  const shown = files.map(f => {
    const rel = path.relative(root, f);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.replaceAll('\\', '/') : f;
  });
  return `${heading}:\n${shown.map(f => `  ${f}`).join('\n')}`;
}

const LABEL_WIDTH = 60;

/** `turnback blame`: the label column shows only where the author changes. */
export function formatBlame(lines: BlameLine[], numbers: Map<string, number>): string {
  if (!lines.length) return '(empty file)';
  const label = (l: BlameLine) => {
    if (!l.turn) return l.source === 'before' ? '(before Turnback)' : '(outside a turn)';
    const head = `#${numbers.get(l.turn.id) ?? '?'} ${l.turn.agent} ${formatTime(l.turn.time).slice(5)} `;
    const room = LABEL_WIDTH - head.length - 2;
    const prompt = l.turn.prompt ?? '(no prompt)';
    return head + `"${prompt.length > room ? prompt.slice(0, room - 1) + '…' : prompt}"`;
  };
  const labels = lines.map(label);
  const width = Math.max(...labels.map(l => l.length));
  const digits = String(lines.at(-1)!.line).length;
  return lines.map((l, i) => {
    const shown = i > 0 && labels[i] === labels[i - 1] ? '' : labels[i];
    return `${shown.padEnd(width)} │ ${String(l.line).padStart(digits)} │ ${l.text}`;
  }).join('\n');
}

/** What `recover` brings back: `src/app.ts` for a file, `src/ (3 files)` for a folder. */
export function formatRecoverTarget(rel: string, paths: string[]): string {
  return paths.length === 1 && paths[0] === rel ? rel : `${rel}/ (${paths.length} ${paths.length === 1 ? 'file' : 'files'})`;
}

/** `turnback du`: every workspace's data, largest first, with what can be freed. */
export function formatDiskUsage(home: string, list: WorkspaceUsage[], prunable: WorkspaceUsage[]): string {
  const total = list.reduce((n, u) => n + u.bytes, 0);
  const lines = [`Turnback data in ${home}: ${formatBytes(total)} in ${plural(list.length, 'workspace')}`];
  if (!list.length) return lines[0];
  lines.push('');
  const sizes = list.map(u => formatBytes(u.bytes));
  const width = Math.max(...sizes.map(s => s.length));
  list.forEach((u, i) => {
    const where = u.root ? (u.exists ? u.root : `${u.root} (no longer exists)`) : u.near ? `(unknown workspace, has files in ${u.near})` : '(unknown workspace)';
    const extra = [plural(u.turns, 'turn'), u.lastActivity ? `last used ${u.lastActivity.slice(0, 10)}` : '',
      u.garbageBytes ? `${formatBytes(u.garbageBytes)} reclaimable` : ''].filter(Boolean).join(' · ');
    lines.push(`  ${sizes[i].padStart(width)}  ${where}  ${extra}`);
  });
  const garbage = list.reduce((n, u) => n + u.garbageBytes, 0);
  if (garbage) lines.push('', `${formatBytes(garbage)} is left over from interrupted writes. Free it with: turnback du --compact`);
  if (prunable.length) {
    const bytes = prunable.reduce((n, u) => n + u.bytes, 0);
    lines.push('', `${plural(prunable.length, 'workspace')} (${formatBytes(bytes)}) ${prunable.length === 1 ? 'no longer exists or is' : 'no longer exist or are'} unknown and idle for 30 days. Review with: turnback du --prune`);
  }
  return lines.join('\n');
}
