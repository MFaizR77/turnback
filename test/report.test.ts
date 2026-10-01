import { expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { record } from '../src/core/recorder.js';
import { htmlReport, PR_END, PR_START, prReport, sessionReport, withPrSection } from '../src/core/report.js';
import { sleep } from '../src/core/config.js';
import { Store } from '../src/core/store.js';
import { CLI, tempProject } from './helpers.js';

function turn(p: ReturnType<typeof tempProject>, session: string, id: string, prompt: string, change: () => void) {
  const base = { agent: 'codex' as const, session, turn: id, cwd: p.root };
  record({ ...base, kind: 'turn-start', prompt });
  record({ ...base, kind: 'shell', command: `run ${id}` });
  change();
  record({ ...base, kind: 'turn-end' });
}

it('summarizes the latest session as markdown', () => {
  const p = tempProject('turnback-report-');
  p.write('a.txt', '0');
  turn(p, 'old', 't0', 'older session', () => p.write('a.txt', '1'));
  turn(p, 's1', 't1', 'Add b', () => p.write('b.txt', 'b'));
  turn(p, 's1', 't2', 'Change a', () => p.write('a.txt', '2'));
  const text = sessionReport(new Store(p.root));
  expect(text).toMatch(/^# Turnback report/m);
  expect(text).toContain('Session `s1`');
  expect(text).toContain('2 turns');
  expect(text).toMatch(/## 1\. Add b[\s\S]*## 2\. Change a/);
  expect(text).toContain('`run t1`');
  expect(text).toContain('`b.txt` (added)');
  expect(text).toContain('`a.txt` (modified)');
  expect(text).not.toContain('older session');
  expect(sessionReport(new Store(p.root), 'old')).toContain('older session');
});

it('says so when there is nothing to report', () => {
  const p = tempProject('turnback-report-empty-');
  expect(sessionReport(new Store(p.root))).toBe('No turns recorded yet.');
  expect(() => sessionReport(new Store(p.root), 'nope')).toThrow(/No turns in session nope/);
});

it('writes a self-contained HTML report with escaped text and diffs', () => {
  const p = tempProject('turnback-report-html-');
  p.write('a.txt', '0\n');
  turn(p, 's1', 't1', 'Add <script>alert(1)</script>', () => p.write('b.txt', 'b\n'));
  turn(p, 's1', 't2', 'Change a', () => p.write('a.txt', '2\n'));
  const html = htmlReport(new Store(p.root));
  expect(html).toMatch(/^<!doctype html>/);
  expect(html).not.toContain('<script>alert(1)</script>');
  expect(html).toContain('Add &lt;script&gt;alert(1)&lt;/script&gt;');
  expect(html).toContain('<details>');
  expect(html).toMatch(/class="add">\+2/);
  expect(html).not.toMatch(/<(script|link)\b/);
});

it('cuts a long diff in the HTML report and says so', () => {
  const p = tempProject('turnback-report-cut-');
  turn(p, 's1', 't1', 'big', () => p.write('big.txt', 'x'.repeat(50) + '\n'));
  const html = htmlReport(new Store(p.root), undefined, 20);
  expect(html).toContain('Diff cut at 20 characters');
});

it('keeps the contents of secret files out of the HTML report', () => {
  const p = tempProject('turnback-report-secret-');
  p.write('.env', 'API_KEY=old\n');
  turn(p, 's1', 't1', 'rotate key', () => { p.write('.env', 'API_KEY=sk-live-secret\n'); p.write('a.txt', 'visible\n'); });
  const html = htmlReport(new Store(p.root));
  expect(html).not.toContain('sk-live-secret');
  expect(html).not.toContain('API_KEY=old');
  expect(html).toContain('visible');
  expect(html).toMatch(/<code>\.env<\/code> <span class="M">modified<\/span> \(content hidden\)/);
});

it('hides nested credentials and keystores while showing environment template diffs', () => {
  const p = tempProject('turnback-report-credentials-');
  mkdirSync(p.file('config'));
  turn(p, 's1', 't1', 'configure project', () => {
    p.write('config/.git-credentials', 'private-git-value\n');
    p.write('config/client.jks', 'private-jks-value\n');
    p.write('config/client.keystore', 'private-keystore-value\n');
    p.write('config/.env.example', 'PUBLIC_EXAMPLE=value\n');
  });
  const html = htmlReport(new Store(p.root));
  for (const name of ['.git-credentials', 'client.jks', 'client.keystore']) {
    expect(html).toContain(`<code>config/${name}</code> <span class="A">added</span> (content hidden)`);
  }
  expect(html).not.toContain('private-');
  expect(html).toContain('PUBLIC_EXAMPLE=value');
});

const git = (p: ReturnType<typeof tempProject>, ...args: string[]) =>
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-C', p.root, ...args], { encoding: 'utf8', windowsHide: true });

/**
 * main has a.txt from an earlier turn; branch `feat` (from main) has a turn that changes a.txt and
 * adds c.txt, both committed, and a turn that only changes b.txt, which is not in the branch.
 */
function prHistory() {
  const p = tempProject('turnback-report-pr-');
  p.write('b.txt', 'b0');
  git(p, 'add', '.');
  git(p, 'commit', '-q', '-m', 'init');
  git(p, 'branch', '-M', 'main');
  turn(p, 's0', 't0', 'before the branch', () => p.write('a.txt', 'a0'));
  sleep(1100);
  git(p, 'add', '.');
  git(p, 'commit', '-q', '-m', 'a on main');
  sleep(1100);
  git(p, 'checkout', '-q', '-b', 'feat');
  turn(p, 's1', 't1', 'Retry failed | requests\nwith backoff', () => { p.write('a.txt', 'a1'); p.write('c.txt', 'c'); });
  turn(p, 's1', 't2', 'Unrelated tweak', () => p.write('b.txt', 'b1'));
  git(p, 'add', 'a.txt', 'c.txt');
  git(p, 'commit', '-q', '-m', 'feature');
  return p;
}

it('lists only turns since the branch point that changed files in the pull request', () => {
  const p = prHistory();
  const text = prReport(new Store(p.root), 'main');
  expect(text.startsWith(PR_START)).toBe(true);
  expect(text.trimEnd().endsWith(PR_END)).toBe(true);
  expect(text).toContain('### AI provenance');
  expect(text).toContain('Retry failed \| requests with backoff');
  expect(text).toContain('`a.txt`, `c.txt`');
  expect(text).not.toContain('Unrelated tweak');
  expect(text).not.toContain('before the branch');
  expect(text).toContain('[Turnback](https://github.com/MFaizR77/turnback)');
});

it('shortens long prompts and says so when no turn changed the pull request', () => {
  const p = prHistory();
  turn(p, 's2', 't3', 'x'.repeat(300), () => p.write('c.txt', 'c2'));
  expect(prReport(new Store(p.root), 'main')).toMatch(/x{119}…/);
  git(p, 'checkout', '-q', '-f', 'main');
  git(p, 'checkout', '-q', '-b', 'empty');
  expect(prReport(new Store(p.root), 'main')).toContain('No recorded agent turn changed the files in this pull request.');
});

it('replaces an earlier provenance section in a pull request body instead of adding another', () => {
  const section = `${PR_START}\nnew\n${PR_END}\n`;
  expect(withPrSection('Fixes #1', section)).toBe(`Fixes #1\n\n${section}`);
  expect(withPrSection(`Intro\n\n${PR_START}\nold\n${PR_END}\n\nOutro`, section)).toBe(`Intro\n\n${section}\nOutro`);
  expect(withPrSection('', section)).toBe(section);
});

it('prints the section and, with --apply, puts it in the pull request through gh', () => {
  const p = prHistory();
  const env = { ...process.env, TURNBACK_HOME: p.home };
  const run = (args: string[], extra = {}) => spawnSync(process.execPath, [CLI, 'report', ...args], { cwd: p.root, encoding: 'utf8', env: { ...env, ...extra }, windowsHide: true });

  const printed = run(['--pr', '--base', 'main']);
  expect(printed.status).toBe(0);
  expect(printed.stdout).toContain('### AI provenance');
  expect(printed.stdout).toContain('`a.txt`, `c.txt`');

  // A stand-in for gh: `pr view` prints a body, `pr edit` saves what it was given.
  const fake = path.join(p.home, 'gh.cjs');
  writeFileSync(fake, `const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[1] === 'view') process.stdout.write('Fixes #1\\n');
else fs.writeFileSync(${JSON.stringify(path.join(p.home, 'edited.md'))}, fs.readFileSync(0, 'utf8') + '\\n---\\n' + args.join(' '));`);
  const applied = run(['--pr', '--base', 'main', '--apply'], { TURNBACK_GH_SCRIPT: fake });
  expect(applied.status).toBe(0);
  expect(applied.stdout).toContain('Updated the pull request description');
  const edited = readFileSync(path.join(p.home, 'edited.md'), 'utf8');
  expect(edited.startsWith(`Fixes #1\n\n${PR_START}`)).toBe(true);
  expect(edited).toContain('pr edit --body-file -');

  const missing = run(['--pr', '--base', 'nope']);
  expect(missing.status).toBe(2);
  expect(missing.stderr).toContain('nope');
}, 60_000);
