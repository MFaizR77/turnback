import { expect, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import { record } from '../src/core/recorder.js';
import { htmlReport, sessionReport } from '../src/core/report.js';
import { Store } from '../src/core/store.js';
import { tempProject } from './helpers.js';

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
