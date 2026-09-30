import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { Store } from '../src/core/store.js';
import { hook, tempDir, tempProject } from './helpers.js';

function editTurn(p: ReturnType<typeof tempProject>, turn: string, rel: string, content: string) {
  hook(p.root, 'turn-start', turn, { prompt: `change ${rel}` });
  hook(p.root, 'edit', turn, { paths: [p.file(rel)] });
  p.write(rel, content);
  hook(p.root, 'turn-end', turn);
}

it('lists the turns that changed a file or folder, newest first', () => {
  const p = tempProject('turnback-log-');
  mkdirSync(p.file('src'));
  p.write('src/a.txt', '0');
  p.write('b.txt', '0');
  editTurn(p, 't1', 'src/a.txt', '1');
  editTurn(p, 't2', 'b.txt', '1');
  editTurn(p, 't3', 'src/a.txt', '2');
  const store = new Store(p.root);

  const history = store.fileHistory(p.file('src/a.txt'));
  expect(history.map(t => t.id.split(':').at(-1))).toEqual(['t3', 't1']);
  expect(history[0].prompt).toBe('change src/a.txt');
  expect(store.fileHistory(p.file('src')).map(t => t.id.split(':').at(-1))).toEqual(['t3', 't1']);
  expect(store.fileHistory(p.file('missing.txt'))).toEqual([]);
});

it('rejects paths outside the workspace', () => {
  const p = tempProject('turnback-log-out-');
  expect(() => new Store(p.root).fileHistory(path.resolve(p.root, '..', 'elsewhere.txt'))).toThrow(/outside workspace/);
});

it('lists changed turns for the workspace root, leaving out unchanged turns', () => {
  const p = tempProject('turnback-log-root-');
  p.write('a.txt', '0');
  editTurn(p, 't1', 'a.txt', '1');
  editTurn(p, 't2', 'a.txt', '1');
  const store = new Store(p.root);
  expect(store.fileHistory(p.file('.')).map(t => t.id.split(':').at(-1))).toEqual(['t1']);
});

it('accepts a directory alias of the workspace root but rejects an outside alias', () => {
  const p = tempProject('turnback-log-alias-');
  p.write('a.txt', '0');
  editTurn(p, 't1', 'a.txt', '1');
  const store = new Store(p.root);
  const links = tempDir('turnback-log-links-');
  const alias = path.join(links, 'workspace');
  const outside = path.join(links, 'outside');
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  symlinkSync(p.root, alias, type);
  symlinkSync(tempDir('turnback-log-foreign-'), outside, type);

  expect(store.fileHistory(alias).map(t => t.id.split(':').at(-1))).toEqual(['t1']);
  expect(store.fileHistory(path.join(alias, 'a.txt')).map(t => t.id.split(':').at(-1))).toEqual(['t1']);
  expect(() => store.fileHistory(outside)).toThrow(/outside workspace/);
});

it('matches file and folder casing according to the platform without matching sibling folders', () => {
  const p = tempProject('turnback-log-case-');
  mkdirSync(p.file('src'));
  mkdirSync(p.file('src-other'));
  p.write('src/a.txt', '0');
  p.write('src-other/a.txt', '0');
  editTurn(p, 't1', 'src/a.txt', '1');
  editTurn(p, 't2', 'src-other/a.txt', '1');
  const store = new Store(p.root);
  const expected = existsSync(p.file('SRC/A.TXT')) ? ['t1'] : [];
  expect(store.fileHistory(p.file('SRC/A.TXT')).map(t => t.id.split(':').at(-1))).toEqual(expected);
  expect(store.fileHistory(p.file('SRC')).map(t => t.id.split(':').at(-1))).toEqual(expected);
  expect(store.fileHistory(p.file('src')).map(t => t.id.split(':').at(-1))).toEqual(['t1']);
});

it('asks git for the changed files of each turn only once per process', async () => {
  const { vi } = await import('vitest');
  const p = tempProject('turnback-log-cache-');
  p.write('a.txt', '0');
  editTurn(p, 't1', 'a.txt', '1');
  editTurn(p, 't2', 'a.txt', '2');
  const store = new Store(p.root);
  const spy = vi.spyOn(store.repo, 'diffNames');
  const git = vi.spyOn(store.repo as any, 'list');
  store.turns().map(t => store.summarize(t));
  store.fileHistory(p.file('a.txt'));
  store.turns().map(t => store.summarize(t));
  expect(spy).toHaveBeenCalledTimes(6);
  expect(git).toHaveBeenCalledTimes(2);
});
