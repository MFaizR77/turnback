import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:os';
import { record } from './recorder.js';
import { Store } from './store.js';
import type { HookEvent } from './types.js';

export interface RunResult {
  /** Exit code of the command, shell style: 128 + the signal number when a signal ended it. */
  status: number;
  turn: string;
  /** Why the snapshot before the command did not succeed, if it did not. */
  unprotected?: string;
  /** Why the end of the turn could not be recorded, if it could not. */
  endError?: string;
}

/** Signals that end the command but must leave Turnback alive to record the end of the turn. */
const HELD_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/** How a child process ended, as a shell reports it: its code, 128 + signal number, or 127 when it never started. */
export function exitStatus(child: { status: number | null; signal: NodeJS.Signals | null; error?: Error }): number {
  if (child.error) return 127;
  if (child.status !== null) return child.status;
  return 128 + (child.signal ? constants.signals[child.signal] ?? 2 : 2);
}

/**
 * Run a command as one turn of the `manual` agent: turn start, a shell snapshot, the command,
 * then turn end. The turn is recorded even when the command fails or is interrupted.
 */
export function runAsTurn(cwd: string, argv: string[], label?: string): RunResult {
  const join = (platform: NodeJS.Platform) => argv.length === 1 ? argv[0] : argv.map(a => quoteForShell(a, platform)).join(' ');
  // What runs is quoted for this platform's shell; what is recorded stays readable (sh quoting).
  const command = join(process.platform);
  const shown = join('linux');
  const base: Omit<HookEvent, 'kind'> = { agent: 'manual', session: 'run', turn: randomUUID(), cwd };
  record({ ...base, kind: 'turn-start', prompt: label ?? shown });
  const before = record({ ...base, kind: 'shell', command: shown });

  // Ctrl+C, a closed terminal, or a kill reach the command directly; Turnback stays alive to record the end of the turn.
  const ignore = () => {};
  for (const signal of HELD_SIGNALS) process.on(signal, ignore);
  try {
    const child = spawnSync(command, { cwd, shell: true, stdio: 'inherit', windowsHide: true });
    let endError: string | undefined;
    try {
      record({ ...base, kind: 'turn-end' });
    } catch (e) {
      endError = e instanceof Error ? e.message : String(e);
    }
    const unprotected = before?.status === 'ok' ? undefined : before?.note ?? before?.status ?? 'not recorded';
    return { status: exitStatus(child), turn: base.turn, unprotected, endError };
  } finally {
    for (const signal of HELD_SIGNALS) process.off(signal, ignore);
  }
}

/** Number of files the turn changed, for the summary line. */
export function changedFiles(cwd: string, turn: string): { index: number; files: number } | undefined {
  const store = new Store(cwd);
  const turns = store.turns();
  const index = turns.findIndex(t => t.id.endsWith(':' + turn));
  return index < 0 ? undefined : { index: index + 1, files: store.summarize(turns[index]).changedFiles };
}

/** Characters cmd.exe treats specially, escaped with `^` (the rule cross-spawn uses). */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * Quote one argument for the shell Node uses with `shell: true`: cmd.exe on Windows, sh elsewhere. On
 * Windows the argument is quoted for the program's parser, then every cmd.exe metacharacter is
 * escaped, quotes included, so `%VAR%` is never expanded.
 */
export function quoteForShell(arg: string, platform = process.platform): string {
  if (platform !== 'win32') return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
  if (/^[\w@+=:,./\\-]+$/.test(arg)) return arg;
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
  return quoted.replace(CMD_META, '^$1');
}
