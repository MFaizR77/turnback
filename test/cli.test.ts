import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { install } from '../src/agents/install.js';
import { Store } from '../src/core/store.js';
import { CLI, tempProject } from './helpers.js';

const AGENTS = ['claude', 'codex', 'gemini', 'cursor', 'opencode', 'antigravity'];
/** Antigravity payloads do not name their event; the installed hook passes it as an argument. */
const EVENT_ARG: Record<string, string[]> = { antigravity: ['PreToolUse'] };

function cli(root: string, home: string, args: string[], input?: string) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, input, encoding: 'utf8', env: { ...process.env, TURNBACK_HOME: home } });
}

it('every agent hook fails open when storage cannot be created', () => {
  const p = tempProject('turnback-hooks-');
  p.write('a.txt', 'x');
  const blockedHome = p.file('blocking-file');
  writeFileSync(blockedHome, 'not a directory');
  for (const agent of AGENTS) {
    const payload = readFileSync(path.resolve(`test/fixtures/${agent}.json`), 'utf8');
    const r = cli(p.root, blockedHome, ['hook', agent, ...EVENT_ARG[agent] ?? []], payload);
    expect(r.status).toBe(0);
    // Antigravity treats any PreToolUse output, even `{}`, as a decision; only silence is neutral.
    if (agent === 'antigravity') expect(r.stdout).toBe('');
    else expect(JSON.parse(r.stdout)).toEqual(agent === 'cursor' ? { permission: 'allow' } : {});
  }
});

it('serializes ten concurrent hooks without blocking agent tools', async () => {
  const p = tempProject('turnback-parallel-');
  p.write('a.txt', 'x');
  const payload = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', turn_id: 't', tool_name: 'Bash', tool_input: { command: 'echo ok' }, cwd: p.root });
  const run = () => new Promise<{ code: number | null; output: string }>(resolve => {
    const child = spawn(process.execPath, [CLI, 'hook', 'codex'], { cwd: p.root, env: { ...process.env, TURNBACK_HOME: p.home }, windowsHide: true });
    let output = '';
    child.stdout.on('data', chunk => output += chunk);
    child.on('close', code => resolve({ code, output }));
    child.stdin.end(payload);
  });

  const results = await Promise.all(Array.from({ length: 10 }, run));
  expect(results.every(r => r.code === 0 && r.output.trim() === '{}')).toBe(true);
  const entries = new Store(p.root).entries().filter(e => e.agent === 'codex');
  expect(entries.length).toBeGreaterThanOrEqual(10);
  expect(entries.every(e => e.status === 'ok' || e.status === 'skipped')).toBe(true);
}, 30_000);

it('undoes a destructive shell turn end to end through the CLI', () => {
  const p = tempProject('turnback-e2e-');
  mkdirSync(p.file('src'));
  p.write('src/app.ts', 'export const app = 1;\n');
  p.write('.gitignore', '.env\n');
  p.write('.env', 'SECRET=1\n');
  const send = (payload: object) => cli(p.root, p.home, ['hook', 'claude'], JSON.stringify({ session_id: 's', cwd: p.root, ...payload }));

  send({ hook_event_name: 'UserPromptSubmit', prompt: 'clean up' });
  send({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf src .env' } });
  rmSync(p.file('src'), { recursive: true });
  rmSync(p.file('.env'));
  p.write('junk.txt', 'junk');
  send({ hook_event_name: 'Stop' });

  const list = JSON.parse(cli(p.root, p.home, ['list', '--json']).stdout);
  expect(list).toHaveLength(1);
  expect(list[0].changedFiles).toBe(3);

  const dry = cli(p.root, p.home, ['undo', '--dry-run']);
  expect(dry.status).toBe(0);
  expect(dry.stdout).toMatch(/^Undo turn "clean up" \(claude, /);
  expect(dry.stdout).toMatch(/^ {2}restore +src\/app\.ts$/m);
  expect(dry.stdout).toMatch(/^ {2}remove +junk\.txt$/m);
  expect(JSON.parse(cli(p.root, p.home, ['undo', '--dry-run', '--json']).stdout).actions).toHaveLength(3);
  expect(existsSync(p.file('src/app.ts'))).toBe(false);

  const undo = cli(p.root, p.home, ['undo', '--yes']);
  expect(undo.status).toBe(0);
  expect(undo.stdout).toContain('Restored 3 files.');
  expect(undo.stdout).toContain('turnback redo --yes');
  expect(p.read('src/app.ts')).toBe('export const app = 1;\n');
  expect(p.read('.env')).toBe('SECRET=1\n');
  expect(existsSync(p.file('junk.txt'))).toBe(false);

  expect(cli(p.root, p.home, ['redo', '--yes']).status).toBe(0);
  expect(existsSync(p.file('src/app.ts'))).toBe(false);
  expect(p.read('junk.txt')).toBe('junk');
}, 30_000);

it('undoes an Antigravity turn recorded from event-name arguments', () => {
  const p = tempProject('turnback-agy-');
  p.write('a.txt', 'hello\n');
  const base = { conversationId: 'c', workspacePaths: [p.root.replaceAll('\\', '/')] };
  const send = (event: string, payload: object = {}) => cli(p.root, p.home, ['hook', 'antigravity', event], JSON.stringify({ ...base, ...payload }));

  expect(send('PreInvocation', { invocationNum: 0 }).stdout).toBe('');
  send('PreToolUse', { toolCall: { name: 'write_to_file', args: { TargetFile: p.file('a.txt'), CodeContent: 'hello world' } } });
  p.write('a.txt', 'hello world');
  send('PostInvocation', { invocationNum: 0 });
  send('PreInvocation', { invocationNum: 1 });
  send('PreToolUse', { toolCall: { name: 'run_command', args: { CommandLine: 'rm a.txt', Cwd: p.root } } });
  rmSync(p.file('a.txt'));
  send('Stop', { terminationReason: 'NO_TOOL_CALL', fullyIdle: true });

  const list = JSON.parse(cli(p.root, p.home, ['list', '--json']).stdout);
  expect(list).toHaveLength(1);
  expect(list[0].agent).toBe('antigravity');
  expect(cli(p.root, p.home, ['undo', '--yes']).status).toBe(0);
  expect(p.read('a.txt')).toBe('hello\n');
}, 30_000);

it('undoes an OpenCode turn through the generated plugin', async () => {
  const p = tempProject('turnback-opencode-');
  p.write('a.txt', 'hello\n');
  install('opencode', true, p.root, CLI, false);
  const { Turnback } = await import(pathToFileURL(p.file('.opencode/plugins/turnback.js')).href);
  const hooks = await Turnback({ directory: p.root });

  await hooks['chat.message']({ sessionID: 'ses_1' }, {});
  await hooks['tool.execute.before']({ tool: 'edit', sessionID: 'ses_1', callID: 'c1' }, { args: { filePath: p.file('a.txt') } });
  p.write('a.txt', 'hello world');
  await hooks['tool.execute.before']({ tool: 'bash', sessionID: 'ses_1', callID: 'c2' }, { args: { command: 'rm a.txt' } });
  rmSync(p.file('a.txt'));
  await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_1' } } });

  const list = JSON.parse(cli(p.root, p.home, ['list', '--json']).stdout);
  expect(list.map((t: { agent: string }) => t.agent)).toEqual(['opencode']);
  expect(cli(p.root, p.home, ['undo', '--yes']).status).toBe(0);
  expect(p.read('a.txt')).toBe('hello\n');
}, 30_000);

it('prints usage and exits 2 for an unknown command', () => {
  const p = tempProject('turnback-usage-');
  const r = cli(p.root, p.home, ['bogus']);
  expect(r.status).toBe(2);
  expect(r.stdout).toMatch(/Usage:/);
});

it('lists steps and restores to just before one', () => {
  const p = tempProject('turnback-steps-cli-');
  p.write('a.txt', 'v0');
  const send = (payload: object) => cli(p.root, p.home, ['hook', 'codex'], JSON.stringify({ session_id: 's', turn_id: 't', cwd: p.root, ...payload }));
  send({ hook_event_name: 'UserPromptSubmit', prompt: 'two steps' });
  send({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo v1 > a.txt' } });
  p.write('a.txt', 'v1');
  send({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo v2 > a.txt' } });
  p.write('a.txt', 'v2');
  send({ hook_event_name: 'Stop' });

  const steps = cli(p.root, p.home, ['steps', 't']);
  expect(steps.stdout).toMatch(/^1\. .*echo v1 > a\.txt/m);
  expect(steps.stdout).toMatch(/^2\. .*echo v2 > a\.txt/m);
  expect(cli(p.root, p.home, ['restore', 't', '--before-step', '2', '--yes']).status).toBe(0);
  expect(p.read('a.txt')).toBe('v1');
  const bad = cli(p.root, p.home, ['restore', 't', '--before-step', '9', '--yes']);
  expect(bad.status).toBe(2);
  expect(bad.stderr).toContain('has 2 steps');
}, 30_000);

it('prints status and install results as text, with --json for the raw data', () => {
  const p = tempProject('turnback-text-');
  p.write('a.txt', 'x');
  const installed = cli(p.root, p.home, ['install', 'claude', '--project', '--no-mcp']);
  expect(installed.stdout).toBe('Installed Turnback in:\n  .claude/settings.json\n');
  expect(cli(p.root, p.home, ['status']).stdout).toMatch(/^Turns +0$/m);
  expect(JSON.parse(cli(p.root, p.home, ['status', '--json']).stdout).turns).toBe(0);
  expect(cli(p.root, p.home, ['uninstall', 'claude', '--project']).stdout).toMatch(/^Removed Turnback from:\n {2}\.claude\/settings\.json/);
}, 30_000);

it('recovers one deleted file through the CLI', () => {
  const p = tempProject('turnback-recover-cli-');
  p.write('gone.txt', 'keep\n');
  p.write('other.txt', 'o\n');
  const send = (payload: object) => cli(p.root, p.home, ['hook', 'claude'], JSON.stringify({ session_id: 's', cwd: p.root, ...payload }));
  send({ hook_event_name: 'UserPromptSubmit', prompt: 'tidy up' });
  send({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm gone.txt other.txt' } });
  rmSync(p.file('gone.txt'));
  rmSync(p.file('other.txt'));
  send({ hook_event_name: 'Stop' });

  const dry = cli(p.root, p.home, ['recover', 'gone.txt', '--dry-run']);
  expect(dry.stdout).toMatch(/^Recover gone\.txt from just before turn "tidy up" \(claude, /);
  expect(dry.stdout).toMatch(/^ {2}restore +gone\.txt$/m);
  expect(dry.stdout).not.toContain('other.txt');
  expect(cli(p.root, p.home, ['recover', 'gone.txt', '--yes']).status).toBe(0);
  expect(p.read('gone.txt')).toBe('keep\n');
  expect(existsSync(p.file('other.txt'))).toBe(false);

  const none = cli(p.root, p.home, ['recover', 'never.txt']);
  expect(none.status).toBe(1);
  expect(none.stdout).toContain('No snapshot has a version of never.txt');
}, 30_000);

it('names the completed turn when recovering its end snapshot', () => {
  const p = tempProject('turnback-recover-end-cli-');
  const run = cli(p.root, p.home, ['run', '--label', 'create file', '--', process.execPath, '-e', "require('node:fs').writeFileSync('made.txt', 'made')"]);
  expect(run.status).toBe(0);
  rmSync(p.file('made.txt'));
  const dry = cli(p.root, p.home, ['recover', 'made.txt', '--dry-run']);
  expect(dry.status).toBe(0);
  expect(dry.stdout).toMatch(/^Recover made\.txt from turn "create file" \(manual, /);
  expect(existsSync(p.file('made.txt'))).toBe(false);
});

it('records any command as a turn with turnback run, and undoes it', () => {
  const p = tempProject('turnback-run-');
  p.write('a.txt', 'a\n');
  const run = cli(p.root, p.home, ['run', '--label', 'codegen', '--', process.execPath, '-e', "require('fs').rmSync('a.txt'); require('fs').writeFileSync('b.txt', 'b')"]);
  expect(run.status).toBe(0);
  expect(run.stderr).toMatch(/recorded as turn #1: 2 files changed/);
  expect(existsSync(p.file('a.txt'))).toBe(false);

  const list = JSON.parse(cli(p.root, p.home, ['list', '--json']).stdout);
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ agent: 'manual', prompt: 'codegen', changedFiles: 2 });

  const undo = cli(p.root, p.home, ['undo', '--yes']);
  expect(undo.stdout).toMatch(/^Undo turn "codegen" \(manual, /);
  expect(undo.stdout).not.toContain('conversation');
  expect(p.read('a.txt')).toBe('a\n');
  expect(existsSync(p.file('b.txt'))).toBe(false);
}, 30_000);

it('turnback run passes the exit code through and still records the turn', () => {
  const p = tempProject('turnback-run-fail-');
  p.write('a.txt', 'a\n');
  const run = cli(p.root, p.home, ['run', '--', process.execPath, '-e', "require('fs').writeFileSync('a.txt', 'x'); process.exit(3)"]);
  expect(run.status).toBe(3);
  const list = JSON.parse(cli(p.root, p.home, ['list', '--json']).stdout);
  expect(list[0]).toMatchObject({ agent: 'manual', changedFiles: 1 });
  expect(list[0].prompt).toContain('process.exit(3)');
  expect(cli(p.root, p.home, ['run']).status).toBe(2);
}, 30_000);

it('prints stats and writes the share card', () => {
  const p = tempProject('turnback-stats-cli-');
  p.write('a.txt', 'a\n');
  cli(p.root, p.home, ['run', '--', process.execPath, '-e', "require('fs').rmSync('a.txt')"]);
  const text = cli(p.root, p.home, ['stats']);
  expect(text.stdout).toMatch(/^Turns +1 +\(manual 1\)$/m);
  expect(cli(p.root, p.home, ['stats', '--svg', 'card.svg']).status).toBe(0);
  expect(p.read('card.svg')).toContain('Commands deleted 1 file this week.');
  expect(cli(p.root, p.home, ['stats', '--days', '0']).status).toBe(2);
}, 30_000);

it('writes the session report as HTML', () => {
  const p = tempProject('turnback-report-cli-');
  p.write('a.txt', 'a\n');
  cli(p.root, p.home, ['run', '--label', 'edit a', '--', process.execPath, '-e', "require('fs').writeFileSync('a.txt', 'b')"]);
  const r = cli(p.root, p.home, ['report', '--html', '--out', 'r.html']);
  expect(r.stdout).toBe('Wrote r.html\n');
  expect(p.read('r.html')).toContain('<h2>1. edit a</h2>');
  const auto = cli(p.root, p.home, ['report', '--html']);
  expect(auto.stdout).toBe('Wrote turnback-report-run.html\n');
}, 30_000);

it('blames a file through the CLI, with a line range and JSON', () => {
  const p = tempProject('turnback-blame-cli-');
  p.write('f.txt', 'a\nb\nc\n');
  cli(p.root, p.home, ['run', '--label', 'change b', '--', process.execPath, '-e', "require('fs').writeFileSync('f.txt', 'a\\nB\\nc\\n')"]);
  const text = cli(p.root, p.home, ['blame', 'f.txt']);
  expect(text.stdout).toMatch(/^#1 manual .*"change b" +│ 2 │ B$/m);
  expect(cli(p.root, p.home, ['blame', 'f.txt', '-L', '2,2']).stdout.trim().split('\n')).toHaveLength(1);
  const json = JSON.parse(cli(p.root, p.home, ['blame', 'f.txt', '--json']).stdout);
  expect(json[1]).toMatchObject({ line: 2, text: 'B', source: 'turn', turn: { agent: 'manual', prompt: 'change b' } });
  expect(cli(p.root, p.home, ['blame', 'f.txt', '-L', '3,1']).status).toBe(2);
  const gone = cli(p.root, p.home, ['blame', 'nope.txt']);
  expect(gone.status).toBe(2);
  expect(gone.stderr).toContain('turnback recover nope.txt');
}, 30_000);

it('keeps blame recovery suggestions usable from a subdirectory', () => {
  const p = tempProject('turnback-blame-path-cli-');
  mkdirSync(p.file('src'));
  const result = cli(p.file('src'), p.home, ['blame', 'missing file.txt']);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('turnback recover "missing file.txt"');
  expect(result.stderr).not.toContain('turnback recover src/');
  const directory = cli(p.root, p.home, ['blame', 'src']);
  expect(directory.status).toBe(2);
  expect(directory.stderr).toContain('src is a directory');
  expect(directory.stderr).not.toContain('turnback recover');
}, 30_000);

it('reports a blame range beyond the file without calling a nonempty file empty', () => {
  const p = tempProject('turnback-blame-range-');
  p.write('f.txt', 'a\nb\nc\n');
  for (const extra of [[], ['--json']]) {
    const result = cli(p.root, p.home, ['blame', 'f.txt', '-L', '4,20', ...extra]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('f.txt has 3 lines');
    expect(result.stdout).toBe('');
  }
  const partial = cli(p.root, p.home, ['blame', 'f.txt', '-L', '3,20', '--json']);
  expect(partial.status).toBe(0);
  expect(JSON.parse(partial.stdout)).toEqual([{ line: 3, text: 'c', source: 'before' }]);
  p.write('one.txt', 'one');
  const single = cli(p.root, p.home, ['blame', 'one.txt', '-L', '2,2']);
  expect(single.status).toBe(2);
  expect(single.stderr).toContain('one.txt has 1 line');

  p.write('empty.txt', '');
  const empty = cli(p.root, p.home, ['blame', 'empty.txt', '-L', '1,20']);
  expect(empty.status).toBe(0);
  expect(empty.stdout.trim()).toBe('(empty file)');
  expect(JSON.parse(cli(p.root, p.home, ['blame', 'empty.txt', '-L', '1,20', '--json']).stdout)).toEqual([]);
}, 30_000);

it('passes arguments through turnback run unchanged', () => {
  const p = tempProject('turnback-run-args-');
  p.write('a.txt', 'a\n');
  const args = ['%OS%', 'a b\\', 'xy', 'C:\\Program Files\\x\\', 'q"uote', '\\d+', 'a&b', '$HOME', "it's", '(x)'];
  const r = cli(p.root, p.home, ['run', '--', process.execPath, '-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...args]);
  expect(JSON.parse(r.stdout)).toEqual(args);
}, 30_000);

it('looks up one path per snapshot without listing whole trees in blame and recover', () => {
  const p = tempProject('turnback-lookup-');
  p.write('f.txt', 'a\n');
  for (const t of ['t1', 't2', 't3']) {
    cli(p.root, p.home, ['run', '--label', t, '--', process.execPath, '-e', `require('fs').appendFileSync('f.txt', '${t}\\n')`]);
  }
  const traced = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], {
    cwd: p.root, encoding: 'utf8', env: { ...process.env, TURNBACK_HOME: p.home, TURNBACK_TRACE_GIT: '1' },
  }).stderr;
  expect(traced(['blame', 'f.txt'])).not.toMatch(/git ls-tree/);
  expect(traced(['recover', 'never.txt'])).not.toMatch(/git ls-tree/);
}, 60_000);

it('prints the version with --version, -v, and version', () => {
  const p = tempProject('turnback-version-');
  const { version } = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8'));
  for (const flag of ['--version', '-v', 'version']) {
    const r = cli(p.root, p.home, [flag]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${version}\n`);
  }
}, 30_000);

it('leaves the agent note out of --json restores of turnback run turns', () => {
  const p = tempProject('turnback-run-json-');
  p.write('a.txt', 'a\n');
  cli(p.root, p.home, ['run', '--', process.execPath, '-e', "require('fs').writeFileSync('a.txt', 'b')"]);
  expect(cli(p.root, p.home, ['undo', '--yes', '--json']).stdout).not.toContain('conversation');
}, 30_000);
