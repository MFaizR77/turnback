#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hookResponse, parseHook } from '../agents/adapters.js';
import { dataHome, VERSION } from '../core/config.js';
import { parseArgs, type Args } from './args.js';
import { exportCommit, exportPatch } from '../core/export.js';
import { compareTurns } from '../core/compare.js';
import { htmlReport, sessionOf, sessionReport } from '../core/report.js';
import { formatStats, statsCard, turnStats } from '../core/stats.js';
import { formatBlame, formatConfigFiles, formatMarks, formatPlan, formatRestoreResult, formatStatus, formatSteps, formatTime, formatTurns } from '../core/format.js';
import { install, uninstall } from '../agents/install.js';
import { shellArg } from '../core/quote.js';
import { pendingForeignRoots, record } from '../core/recorder.js';
import { changedFiles, runAsTurn } from '../core/run.js';
import { blameFile } from '../core/blame.js';
import { turnWarning } from '../core/warnings.js';
import { applyRestore, findRecoverable, planRestore, redoTarget, undoTarget, type Operation } from '../core/restore.js';
import { Store } from '../core/store.js';
import type { Agent, HookEvent, Turn } from '../core/types.js';

const USAGE = `Usage:
  turnback install|uninstall <claude|codex|gemini|cursor|opencode|antigravity|all> [--project] [--no-mcp]
  turnback list [--json] | status [--json] | gc
  turnback steps <turn> [--json]
  turnback log <file|folder> [--json]
  turnback blame <file> [-L <start>,<end>] [--json]
  turnback search <text> [--json]
  turnback diff <turn>
  turnback mark <label> | marks [--json]
  turnback restore <turn|mark|snapshot> [--before-step <n>] [--path <p>...] [--dry-run | --yes] [--json]
  turnback undo | redo [--dry-run | --yes] [--json]
  turnback recover <file> [--dry-run | --yes] [--json]
  turnback run [--label <text>] -- <command...>
  turnback export <turn...> [--out <file.patch>] | --commit [--message <text>]
  turnback report [--session <id>] [--html [--out <file>]]
  turnback stats [--days <n>] [--json] [--svg <file>]
  turnback compare <turnA> <turnB> [--json]
  turnback ui [--port <n>] [--no-open]
  turnback mcp
  turnback --version`;

const CLI = fileURLToPath(import.meta.url);

function output(value: unknown): void {
  process.stdout.write(typeof value === 'string' ? value + '\n' : JSON.stringify(value, null, 2) + '\n');
}

const configFiles = (args: Args, heading: string, files: string[], root: string) =>
  args.flags.has('--json') ? files : formatConfigFiles(heading, files, root);

/** Hook entry point: always answers "allow", whatever happens while recording. */
async function runHook(agent: Agent, eventName?: string): Promise<void> {
  let response = hookResponse(agent, eventName);
  try {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    const payload = JSON.parse(raw || '{}');
    response = hookResponse(agent, payload.hook_event_name ?? eventName);
    const event = parseHook(agent, payload, process.cwd(), eventName);
    if (event) {
      const foreign = event.kind === 'turn-end' ? pendingForeignRoots(event) : [];
      record(event);
      if (needsWarm(event)) warmInBackground(event.cwd);
      if (event.kind === 'turn-end') {
        const warning = turnWarning(event, foreign);
        if (warning) response = hookResponse(agent, payload.hook_event_name ?? eventName, warning);
      }
    }
  } catch (e) {
    logHookError(e);
  }
  if (response) process.stdout.write(response + '\n');
}

/** Warm at session start, or at a turn start while the workspace has no snapshot (Antigravity has no session hook). */
function needsWarm(event: HookEvent): boolean {
  if (event.kind === 'session-start') return true;
  return event.kind === 'turn-start' && !new Store(event.cwd).latestRef();
}

function runRestore(store: Store, operation: Operation, args: Args): void {
  const step = args.values.get('--before-step');
  const n = Number(step);
  if (args.flags.has('--before-step') || step !== undefined && (!step.trim() || !Number.isSafeInteger(n) || n < 1)) {
    throw new Error('--before-step must be a step number from turnback steps <turn>');
  }
  const target = operation === 'undo' ? undoTarget(store)
    : operation === 'redo' ? redoTarget(store)
    : step !== undefined && args.positional[0] ? store.stepRef(args.positional[0], n)
    : args.positional[0];
  if (!target) throw new Error(operation === 'restore' ? 'Missing target turn or snapshot' : `Nothing to ${operation}`);
  const paths = args.paths.length ? args.paths : undefined;
  const turn = operation === 'redo' ? undefined : store.findTurn(step !== undefined ? args.positional[0] ?? '' : target);
  applyPlan(store, operation, target, paths, planTitle(store, operation, target, args.positional[0], step), args, isAgentTurn(turn));
}

const isAgentTurn = (turn?: Turn) => !!turn && turn.agent !== 'manual';

/** `turnback run [--label <text>] -- <command...>`: record any command as one turn. */
function runCommand(rest: string[]): void {
  let split = rest.indexOf('--');
  if (split < 0) {
    split = 0;
    while (rest[split] === '--label' && rest[split + 1] !== undefined) split += 2;
  }
  const own = parseArgs(rest.slice(0, split));
  const argv = rest.slice(split + (rest[split] === '--' ? 1 : 0));
  if (!argv[0] || argv[0].startsWith('-') || own.flags.has('--label')) {
    process.stderr.write('Usage: turnback run [--label <text>] -- <command...>\n');
    process.exitCode = 2;
    return;
  }
  const cwd = process.cwd();
  const result = runAsTurn(cwd, argv, own.values.get('--label'));
  const summary = changedFiles(cwd, result.turn);
  const lines = [];
  if (result.endError) lines.push(`turnback: the end of this turn was not recorded (${result.endError}); see turnback status.`);
  if (result.unprotected) lines.push(`turnback: the files before this command were not saved (${result.unprotected}); see turnback status.`);
  if (summary) {
    lines.push(`turnback: recorded as turn #${summary.index}: ${summary.files} ${summary.files === 1 ? 'file' : 'files'} changed. Undo with: turnback undo --yes`);
  }
  if (lines.length) process.stderr.write(lines.join('\n') + '\n');
  process.exitCode = result.status;
}

/** Print a restore plan, then apply it when `--yes` is given. */
function applyPlan(store: Store, operation: Operation, target: string, paths: string[] | undefined, title: string, args: Args, agentTurn: boolean): void {
  const plan = planRestore(store, target, paths);
  const json = args.flags.has('--json');
  output(json
    ? { target, scope: plan.scope, actions: plan.actions, skippedLarge: plan.skippedLarge }
    : formatPlan(title, plan, args.flags.has('--yes') && !args.flags.has('--dry-run')));
  if (args.flags.has('--dry-run')) return;
  if (!args.flags.has('--yes')) {
    output('Use --yes to apply this plan.');
    return;
  }
  const result = applyRestore(store, target, { paths, token: plan.token, operation });
  if (json) {
    output({ applied: result.applied, failed: result.failed, safety: result.safety });
    if (agentTurn) output('Agent conversation context is not restored; tell the agent what changed.');
  } else {
    output(formatRestoreResult(result, operation, agentTurn));
  }
  if (result.failed.length) process.exitCode = 1;
}

/** `turn "<prompt>" (<agent>, <time>)`, or the turn ID when it has no prompt. */
function describeTurn(turn: Turn): string {
  const prompt = turn.entries.find(e => e.kind === 'turn-start')?.prompt;
  return `turn ${prompt ? JSON.stringify(prompt) : turn.id} (${turn.agent}, ${formatTime(turn.time)})`;
}

/** First line of a restore plan: what is being undone, named by its prompt when there is one. */
function planTitle(store: Store, operation: Operation, target: string, requested?: string, step?: string): string {
  const describe = (id: string) => {
    const turn = store.findTurn(id);
    return turn && describeTurn(turn);
  };
  if (operation === 'undo') return `Undo ${describe(target) ?? target}`;
  if (operation === 'redo') return 'Redo: return to the files as they were before the last restore';
  if (step !== undefined && requested) return `Restore ${describe(requested) ?? requested} to just before step ${step}`;
  const turn = describe(target);
  if (turn) return `Restore to the start of ${turn}`;
  return store.marks().some(m => m.label === target) ? `Restore to mark ${JSON.stringify(target)}` : `Restore to ${target}`;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'run') return runCommand(rest);
  const args = parseArgs(rest);

  if (command === '--version' || command === '-v' || command === 'version') return output(VERSION);
  if (command === 'hook') return runHook(args.positional[0] as Agent, args.positional[1]);
  if (command === 'mcp') return (await import('../mcp/server.js')).serveMcp();

  const store = new Store(process.cwd());
  switch (command) {
    case 'warm':
      store.warm();
      store.gcIfDue();
      return;
    case 'install':
      output(configFiles(args, 'Installed Turnback in',
        install(args.positional[0] ?? 'all', args.flags.has('--project'), store.root, CLI, !args.flags.has('--no-mcp')), store.root));
      warmInBackground(store.root);
      return;
    case 'uninstall':
      output(configFiles(args, 'Removed Turnback from', uninstall(args.positional[0] ?? 'all', args.flags.has('--project'), store.root), store.root));
      return;
    case 'list': {
      const turns = store.turns().map(t => store.summarize(t));
      output(args.flags.has('--json') ? turns : formatTurns(turns));
      return;
    }
    case 'status':
      output(args.flags.has('--json') ? store.status() : formatStatus(store.status()));
      return;
    case 'gc':
      output(store.gc());
      return;
    case 'steps': {
      const id = args.positional[0];
      if (!id) throw new Error('Missing turn id');
      const steps = store.steps(id);
      output(args.flags.has('--json') ? steps : formatSteps(steps));
      return;
    }
    case 'log': {
      const target = args.positional[0];
      if (!target) throw new Error('Missing file or folder');
      const history = store.fileHistory(path.resolve(target));
      output(args.flags.has('--json') ? history : history.length ? formatTurns(history) : `No recorded turn changed ${target}.`);
      return;
    }
    case 'mark': {
      const mark = store.mark(args.positional.join(' '));
      output(`Marked ${JSON.stringify(mark.label)} (${mark.ref}). Restore it with: turnback restore ${shellArg(mark.label)} --dry-run`);
      return;
    }
    case 'marks': {
      const marks = store.marks();
      output(args.flags.has('--json') ? marks : formatMarks(marks));
      return;
    }
    case 'ui': {
      const value = args.values.get('--port');
      const port = Number(value ?? 0);
      if (args.flags.has('--port') || value !== undefined && !value.trim() || !Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error('--port must be a whole number from 0 to 65535');
      }
      const { startUi } = await import('../ui/server.js');
      const ui = await startUi(store, port);
      output(`Turnback UI: ${ui.url}\nRead-only. Press Ctrl+C to stop.`);
      if (!args.flags.has('--no-open')) openBrowser(ui.url);
      return;
    }
    case 'export': {
      const ids = args.positional;
      if (args.flags.has('--commit')) {
        const result = exportCommit(store, ids, args.values.get('--message'));
        const skipped = result.ignored.length ? ` Skipped ignored: ${result.ignored.join(', ')}.` : '';
        output(`Committed ${result.paths.length} files as ${result.commit.slice(0, 12)}.${skipped}`);
        return;
      }
      const patch = exportPatch(store, ids);
      const out = args.values.get('--out');
      if (out) {
        writeFileSync(path.resolve(out), patch);
        output(`Wrote ${out}. Apply it with: git apply ${shellArg(out) ?? out}`);
      } else process.stdout.write(patch);
      return;
    }
    case 'search': {
      const turns = store.searchTurns(args.positional.join(' '));
      output(args.flags.has('--json') ? turns : turns.length ? formatTurns(turns) : 'No matching turns.');
      return;
    }
    case 'compare': {
      const [a, b] = args.positional;
      if (!a || !b) throw new Error('Usage: turnback compare <turnA> <turnB>');
      const c = compareTurns(store, a, b);
      if (args.flags.has('--json')) return output(c);
      output([
        `A: ${c.a}`, `B: ${c.b}`,
        `Only A: ${c.onlyA.join(', ') || '-'}`, `Only B: ${c.onlyB.join(', ') || '-'}`,
        `Both, different: ${c.both.join(', ') || '-'}`, `Both, same: ${c.same.join(', ') || '-'}`,
        '', c.patch,
      ].join('\n'));
      return;
    }
    case 'blame': {
      const file = args.positional[0];
      if (!file) throw new Error('Missing file');
      let lines = blameFile(store, path.resolve(file));
      const range = args.values.get('-L');
      if (range !== undefined) {
        const m = /^(\d+),(\d+)$/.exec(range);
        if (!m || Number(m[1]) < 1 || Number(m[1]) > Number(m[2])) throw new Error('-L needs <start>,<end> with 1 ≤ start ≤ end');
        if (lines.length && Number(m[1]) > lines.length) throw new Error(`${file} has ${lines.length} ${lines.length === 1 ? 'line' : 'lines'}`);
        lines = lines.filter(l => l.line >= Number(m[1]) && l.line <= Number(m[2]));
      }
      if (args.flags.has('--json')) {
        output(lines.map(({ turn, ...l }) => ({ ...l, turn: turn && { id: turn.id, agent: turn.agent, time: turn.time, prompt: turn.prompt } })));
        return;
      }
      output(formatBlame(lines, new Map(store.turns().map((t, i) => [t.id, i + 1]))));
      return;
    }
    case 'stats': {
      const days = Number(args.values.get('--days') ?? 7);
      if (!Number.isInteger(days) || days < 1) throw new Error('--days must be a whole number of days, 1 or more');
      const stats = turnStats(store, days);
      const svg = args.values.get('--svg');
      if (svg) {
        writeFileSync(svg, statsCard(stats));
        output(`Wrote ${svg}. Open it in a browser to share a screenshot.`);
        return;
      }
      output(args.flags.has('--json') ? stats : formatStats(stats));
      return;
    }
    case 'report': {
      const session = args.values.get('--session');
      if (!args.flags.has('--html')) return output(sessionReport(store, session));
      const html = htmlReport(store, session);
      const id = session ?? sessionOf(store.turns()[0].id);
      const out = args.values.get('--out') ?? `turnback-report-${id.replace(/[^\w.-]+/g, '_')}.html`;
      writeFileSync(path.resolve(out), html);
      output(`Wrote ${out}`);
      return;
    }
    case 'diff': {
      const id = args.positional[0];
      if (!id) throw new Error('Missing turn id');
      output(store.turnDiff(id, true).diff);
      return;
    }
    case 'restore':
    case 'undo':
    case 'redo':
      runRestore(store, command, args);
      return;
    case 'recover': {
      const file = args.positional[0];
      if (!file) throw new Error('Missing file');
      const abs = path.resolve(file);
      const found = findRecoverable(store, abs);
      if (!found) {
        output(`No snapshot has a version of ${file} that differs from the file on disk.`);
        process.exitCode = 1;
        return;
      }
      const mark = store.marks().find(m => m.ref === found.ref);
      const from = found.turn ? `${found.entry.kind === 'baseline' ? 'just before ' : ''}${describeTurn(found.turn)}`
        : mark ? `mark ${JSON.stringify(mark.label)}`
        : `the snapshot of ${formatTime(found.entry.time)}`;
      applyPlan(store, 'restore', found.ref, [abs], `Recover ${store.workspace.relative(abs)} from ${from}`, args, isAgentTurn(found.turn));
      return;
    }
    default:
      output(USAGE);
      if (command && command !== 'help' && command !== '--help') process.exitCode = 2;
  }
}

function warmInBackground(cwd: string): void {
  spawn(process.execPath, [CLI, 'warm'], { cwd, detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
}

/** Open a URL in the default browser; if that fails, the user opens the printed URL by hand. */
function openBrowser(url: string): void {
  const [command, argv, verbatim] = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '""', url], true]
    : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url], false];
  spawn(command, argv, { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: verbatim }).on('error', () => {}).unref();
}

function logHookError(error: unknown): void {
  try {
    const dir = path.join(dataHome(), 'logs');
    mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    appendFileSync(path.join(dir, `${now.slice(0, 10)}.log`), `${now} ${String(error)}\n`);
  } catch { /* hooks stay fail-open */ }
}

main().catch(e => {
  process.stderr.write(String(e instanceof Error ? e.message : e) + '\n');
  process.exitCode = 2;
});
