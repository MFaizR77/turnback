import { rmSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { formatStats, statsCard, turnStats } from '../src/core/stats.js';
import { applyRestore, undoTarget } from '../src/core/restore.js';
import { Store } from '../src/core/store.js';
import { hook, tempProject } from './helpers.js';

function twoTurns() {
  const p = tempProject('turnback-stats-');
  p.write('a.txt', 'a');
  p.write('b.txt', 'b');
  p.write('c.txt', 'c');
  hook(p.root, 'turn-start', 't1');
  hook(p.root, 'shell', 't1', { command: 'rm a.txt b.txt' });
  rmSync(p.file('a.txt'));
  rmSync(p.file('b.txt'));
  p.write('new.txt', 'n');
  hook(p.root, 'turn-end', 't1');
  hook(p.root, 'turn-start', 't2');
  hook(p.root, 'edit', 't2', { paths: [p.file('c.txt')] });
  p.write('c.txt', 'c2');
  hook(p.root, 'turn-end', 't2');
  const store = new Store(p.root);
  applyRestore(store, undoTarget(store)!, { operation: 'undo' });
  return new Store(p.root);
}

it('counts turns, files by change, shell commands, and files brought back', () => {
  const s = turnStats(twoTurns(), 7);
  expect(s).toMatchObject({ turns: 2, byAgent: { codex: 2 }, created: 1, modified: 1, deleted: 2, commands: 1, restores: 1, restoredFiles: 1 });
});

it('leaves out turns older than the window', () => {
  const s = turnStats(twoTurns(), 7, Date.now() + 8 * 24 * 60 * 60 * 1000);
  expect(s.turns).toBe(0);
  expect(s.restores).toBe(0);
});

it('counts shell steps from existing turn entries without re-reading each turn', () => {
  const p = tempProject('turnback-stats-commands-');
  hook(p.root, 'shell', 't1', { command: '' });
  hook(p.root, 'shell', 't1', { command: 'echo later' });
  hook(p.root, 'edit', 't2', { paths: [p.file('a.txt')] });
  hook(p.root, 'shell', 't2', { command: 'echo second turn' });
  const store = new Store(p.root);
  const expected = store.turns().reduce((n, turn) => n + store.steps(turn.id).filter(s => s.kind === 'shell').length, 0);
  expect(expected).toBe(3);
  const steps = vi.spyOn(store, 'steps');
  const entries = vi.spyOn(store, 'entries');
  try {
    expect(turnStats(store).commands).toBe(expected);
    expect(steps).not.toHaveBeenCalled();
    expect(entries).toHaveBeenCalledTimes(2);
  } finally {
    steps.mockRestore();
    entries.mockRestore();
  }
});

it('keeps shell counting consistent with step status and command presence', () => {
  const p = tempProject('turnback-stats-step-kinds-');
  hook(p.root, 'shell', 't1', { command: 'echo baseline' });
  const store = new Store(p.root);
  for (const entry of [
    { kind: 'baseline', status: 'failed', command: 'failed baseline' },
    { kind: 'unprotected', status: 'failed', command: 'unprotected' },
    { kind: 'shell', status: 'failed', command: '' },
    { kind: 'shell', status: 'ok' },
    { kind: 'edit', status: 'ok', command: 'edit with command' },
    { kind: 'turn-end', status: 'ok', command: 'not a step' },
  ] as const) {
    store.log({ agent: 'codex', session: 's', turn: 't1', ...entry });
  }
  expect(store.steps('t1').filter(s => s.kind === 'shell')).toHaveLength(3);
  expect(turnStats(store).commands).toBe(3);
});

it.each(['restore', 'undo'] as const)('counts files brought back by a partly failed %s', kind => {
  const p = tempProject('turnback-stats-partial-');
  const store = new Store(p.root);
  const entry = store.log({
    agent: 'turnback', session: 'restore', turn: 'target', kind,
    status: 'failed', paths: ['a.txt', 'b.txt'],
    note: JSON.stringify({ target: 'target', skipped: [], failed: ['c.txt'] }),
  });
  const s = turnStats(store, 7, Date.parse(entry.time));
  expect(s).toMatchObject({ restores: 1, restoredFiles: 2 });
  expect(formatStats(s)).toMatch(/^Restores +1, bringing back 2 files$/m);
  expect(statsCard(s)).toContain('Turnback brought back 2 files.');
});

it.each([
  { kind: 'restore', paths: [], restores: 1 },
  { kind: 'undo', paths: undefined, restores: 0 },
  { kind: 'redo', paths: ['a.txt', 'b.txt'], restores: 0 },
] as const)('handles $kind entries with paths $paths', ({ kind, paths, restores }) => {
  const p = tempProject('turnback-stats-paths-');
  const store = new Store(p.root);
  const entry = store.log({
    agent: 'turnback', session: 'restore', turn: 'target', kind,
    status: 'failed', paths: paths ? [...paths] : undefined,
  });
  expect(turnStats(store, 7, Date.parse(entry.time))).toMatchObject({ restores, restoredFiles: 0 });
});

it.each([
  { offset: -1, restores: 0 },
  { offset: 0, restores: 1 },
  { offset: 24 * 60 * 60 * 1000, restores: 1 },
  { offset: 24 * 60 * 60 * 1000 + 1, restores: 0 },
])('keeps partly failed restores within the window at offset $offset', ({ offset, restores }) => {
  const p = tempProject('turnback-stats-window-');
  const store = new Store(p.root);
  const entry = store.log({
    agent: 'turnback', session: 'restore', turn: 'target', kind: 'restore',
    status: 'failed', paths: ['a.txt', 'b.txt'],
  });
  expect(turnStats(store, 1, Date.parse(entry.time) + offset)).toMatchObject({ restores, restoredFiles: restores * 2 });
});

it('formats text and an SVG card with escaped text', () => {
  const s = turnStats(twoTurns(), 7);
  const text = formatStats(s);
  expect(text).toMatch(/^Turns +2 +\(codex 2\)$/m);
  expect(text).toMatch(/deleted 2/);
  const svg = statsCard({ ...s, byAgent: { '<script>': 1 } });
  expect(svg).toMatch(/^<svg /);
  expect(svg).toContain('deleted 2 files');
  expect(svg).not.toContain('<script>');
});

it('says commands, not agents, when every turn came from turnback run', () => {
  const s = turnStats(twoTurns(), 7);
  expect(statsCard({ ...s, byAgent: { manual: 2 } })).toContain('Commands deleted 2 files this week.');
  expect(statsCard({ ...s, byAgent: { manual: 1, codex: 1 } })).toContain('Agents deleted 2 files this week.');
});

it('does not claim anything was kept when nothing was restored', () => {
  const s = turnStats(twoTurns(), 7);
  const card = statsCard({ ...s, restores: 0, restoredFiles: 0 });
  expect(card).not.toContain('kept a copy');
  expect(card).toContain('Nothing needed undoing.');
});

it('counts only agent deletions in the headline when turns are mixed', () => {
  const p = tempProject('turnback-stats-mix-');
  p.write('a.txt', 'a');
  p.write('b.txt', 'b');
  hook(p.root, 'turn-start', 't1', { agent: 'manual' });
  hook(p.root, 'shell', 't1', { agent: 'manual', command: 'rm a.txt' });
  rmSync(p.file('a.txt'));
  hook(p.root, 'turn-end', 't1', { agent: 'manual' });

  hook(p.root, 'turn-start', 't2', { agent: 'codex' });
  hook(p.root, 'shell', 't2', { agent: 'codex', command: 'rm b.txt' });
  rmSync(p.file('b.txt'));
  hook(p.root, 'turn-end', 't2', { agent: 'codex' });

  const store = new Store(p.root);
  const s = turnStats(store, 7);
  expect(s.deleted).toBe(2);
  expect(s.deletedByAgent).toEqual({ manual: 1, codex: 1 });
  expect(statsCard(s)).toContain('Agents deleted 1 file this week.');
});

