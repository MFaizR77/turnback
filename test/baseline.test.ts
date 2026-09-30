import { chmodSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { applyRestore, planRestore } from '../src/core/restore.js';
import { Store } from '../src/core/store.js';
import { Workspace } from '../src/workspace/workspace.js';
import { hook, tempProject } from './helpers.js';

let p: ReturnType<typeof tempProject>;
beforeEach(() => { p = tempProject(); });
afterEach(() => { delete process.env.TURNBACK_IMPORT_BATCH_BYTES; });

const objects = (store: Store) => {
  const dir = path.join(store.repo.gitDir, 'objects');
  const loose = readdirSync(dir).filter(d => /^[0-9a-f]{2}$/.test(d)).flatMap(d => readdirSync(path.join(dir, d)));
  const packs = readdirSync(path.join(dir, 'pack')).filter(f => f.endsWith('.pack'));
  return { loose: loose.length, packs: packs.length };
};

function writeFiles(count: number) {
  mkdirSync(p.file('src'));
  for (let i = 0; i < count; i++) p.write(`src/f${i}.txt`, `file ${i}\n`);
}

// fast-import unpacks runs below 100 objects (git's unpackLimit) into loose objects, so use more.
it('writes the first snapshot as one pack instead of loose objects', () => {
  writeFiles(150);
  const store = new Store(p.root);
  expect(store.warm().status).toBe('ok');
  // Only the commit and trees may be written outside the pack, never one object per file.
  expect(objects(store)).toMatchObject({ packs: 1 });
  expect(objects(store).loose).toBeLessThan(5);
});

it('restores unusual file names and modes from the first snapshot', () => {
  const names = ['with space.txt', 'ünïcode ☃.txt', 'semi;colon.txt', 'nested/deeper/file.txt'];
  if (process.platform !== 'win32') names.push('"quoted".txt', 'back\\slash.txt', 'new\nline.txt');
  mkdirSync(p.file('nested/deeper'), { recursive: true });
  for (const name of names) p.write(name, `content of ${name}\r\n`);
  p.write('empty.txt', '');
  p.write('run.sh', '#!/bin/sh\n');
  if (process.platform !== 'win32') chmodSync(p.file('run.sh'), 0o755);

  expect(hook(p.root, 'shell', 't1', { command: 'rm -rf *' })?.status).toBe('ok');
  for (const name of [...names, 'empty.txt']) p.write(name, 'overwritten');
  hook(p.root, 'turn-end');

  const result = applyRestore(new Store(p.root), 't1');
  expect(result.failed).toEqual([]);
  for (const name of names) expect(p.read(name)).toBe(`content of ${name}\r\n`);
  expect(p.read('empty.txt')).toBe('');
  if (process.platform !== 'win32') expect(statSync(p.file('run.sh')).mode & 0o111).not.toBe(0);
});

it('splits a large first snapshot into several imports and keeps it complete', () => {
  process.env.TURNBACK_IMPORT_BATCH_BYTES = '1200';
  writeFiles(250);
  const store = new Store(p.root);
  expect(store.warm().status).toBe('ok');
  expect(objects(store).packs).toBeGreaterThan(1);

  expect(hook(p.root, 'shell', 't1', { command: 'edit' })?.status).toBe('ok');
  for (let i = 0; i < 250; i++) p.write(`src/f${i}.txt`, 'changed');
  hook(p.root, 'turn-end');
  applyRestore(store, 't1');
  for (let i = 0; i < 250; i++) expect(p.read(`src/f${i}.txt`)).toBe(`file ${i}\n`);
  // Hundreds of small fast-import runs; on a busy Windows machine this can pass 30 s.
}, 120_000);

it('detects the next change against an imported baseline without rescanning content', () => {
  writeFiles(30);
  // Imported blobs are raw bytes; the project's line-ending rules must not make them look modified.
  p.write('.gitattributes', '* text=auto\n');
  p.write('crlf.txt', 'a\r\nb\r\n');
  const store = new Store(p.root);
  const warm = store.warm();
  p.write('src/f3.txt', 'edited');
  const next = store.snapshot('shell', { agent: 'codex', session: 's', turn: 't1' });
  expect(store.repo.diffNames(warm.ref!, next.ref!)).toEqual(['src/f3.txt']);
});

it.each([
  'tb-data', 'tb[data]', 'tb!data', 'tb#data',
  ...(process.platform === 'win32' ? [] : ['tb*data', 'tb?data']),
])('never snapshots its own data folder named %s inside the workspace', home => {
  const p = tempProject('turnback-home-inside-');
  process.env.TURNBACK_HOME = p.file(home);
  p.write('a.txt', 'a');
  // These names would match an unescaped character class or wildcard.
  mkdirSync(p.file('tbd'));
  p.write('tbd/keep.txt', 'keep');
  mkdirSync(p.file('tbXdata'));
  p.write('tbXdata/keep.txt', 'keep');
  hook(p.root, 'turn-start', 't');
  hook(p.root, 'shell', 't', { command: 'rm a.txt' });
  expect(new Workspace(p.root).scan().paths).toEqual(['a.txt', 'tbd/keep.txt', 'tbXdata/keep.txt']);
  rmSync(p.file('a.txt'));
  hook(p.root, 'turn-end', 't');
  const plan = planRestore(new Store(p.root), 't');
  expect(plan.actions.map(a => a.path)).toEqual(['a.txt']);
});
