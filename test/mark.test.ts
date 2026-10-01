import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { applyRestore, redoTarget } from '../src/core/restore.js';
import { Store } from '../src/core/store.js';
import { hook, tempProject } from './helpers.js';

it('restores the workspace to a named mark and back', () => {
  const p = tempProject('turnback-mark-');
  p.write('a.txt', 'before');
  const store = new Store(p.root);
  expect(store.mark('  before migration ')).toMatchObject({ label: 'before migration' });
  p.write('a.txt', 'after');
  p.write('new.txt', 'x');

  applyRestore(store, 'before migration');
  expect(p.read('a.txt')).toBe('before');
  expect(existsSync(p.file('new.txt'))).toBe(false);
  applyRestore(store, redoTarget(store)!, { operation: 'redo' });
  expect(p.read('a.txt')).toBe('after');
});

it('lists marks newest first and resolves a reused label to the newest', () => {
  const p = tempProject('turnback-marks-');
  p.write('a.txt', '1');
  const store = new Store(p.root);
  store.mark('checkpoint');
  p.write('a.txt', '2');
  store.mark('checkpoint');
  p.write('a.txt', '3');
  expect(store.marks().map(m => m.label)).toEqual(['checkpoint', 'checkpoint']);
  applyRestore(store, 'checkpoint');
  expect(p.read('a.txt')).toBe('2');
});

it('prefers a turn over a mark with the same name', () => {
  const p = tempProject('turnback-mark-turn-');
  p.write('a.txt', 'old');
  const store = new Store(p.root);
  p.write('a.txt', 'checkpoint');
  const mark = store.mark('t');
  p.write('a.txt', 'old');
  hook(p.root, 'edit', 't', { paths: [p.file('a.txt')] });
  p.write('a.txt', 'agent');
  hook(p.root, 'turn-end', 't');
  p.write('a.txt', 'later');
  applyRestore(store, 't');
  expect(p.read('a.txt')).toBe('old');
  p.write('a.txt', 'later');
  applyRestore(store, mark.ref);
  expect(p.read('a.txt')).toBe('checkpoint');
});

it('refuses labels matching a full or short turn ID before taking a snapshot', () => {
  const p = tempProject('turnback-mark-collision-');
  p.write('a.txt', 'old');
  const store = new Store(p.root);
  hook(p.root, 'edit', 't', { paths: [p.file('a.txt')] });
  p.write('a.txt', 'agent');
  hook(p.root, 'turn-end', 't');
  const turn = store.turns()[0];
  const entries = store.entries();
  const refs = () => spawnSync('git', [`--git-dir=${store.repo.gitDir}`, 'for-each-ref', 'refs/turnback'], { encoding: 'utf8', windowsHide: true }).stdout;
  const before = refs();
  for (const label of ['t', `  ${turn.id}  `]) {
    expect(() => store.mark(label)).toThrow(`Mark label "${label.trim()}" matches a turn ID; choose a different label`);
    expect(store.entries()).toEqual(entries);
    expect(refs()).toBe(before);
    expect(store.marks()).toEqual([]);
    expect(p.read('a.txt')).toBe('agent');
  }
  expect(store.mark('checkpoint-t')).toMatchObject({ label: 'checkpoint-t' });
  p.write('a.txt', 'later');
  applyRestore(store, 'checkpoint-t');
  expect(p.read('a.txt')).toBe('agent');
});

it('keeps marks through gc and refuses empty labels and edits-only mode', () => {
  const p = tempProject('turnback-mark-gc-');
  p.write('a.txt', 'kept');
  const store = new Store(p.root);
  store.mark('keep me');
  store.gc({ now: Date.now() + 365 * 24 * 3600 * 1000, keepTurns: 0 });
  p.write('a.txt', 'changed');
  applyRestore(store, 'keep me');
  expect(p.read('a.txt')).toBe('kept');

  expect(() => store.mark('   ')).toThrow(/label/);
  mkdirSync(store.dir, { recursive: true });
  writeFileSync(path.join(store.dir, 'mode.json'), JSON.stringify({ mode: 'edits-only' }));
  expect(() => store.mark('big repo')).toThrow(/edits-only/);
});
