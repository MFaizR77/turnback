import { existsSync, rmSync } from 'node:fs';
import { expect, it } from 'vitest';
import { applyRestore, findRecoverable, redoTarget } from '../src/core/restore.js';
import { Store } from '../src/core/store.js';
import { hook, tempProject } from './helpers.js';

/** Turn t1 deletes gone.txt and edits a.txt; turn t2 edits a.txt again. */
function history() {
  const p = tempProject('turnback-recover-');
  p.write('gone.txt', 'keep me\n');
  p.write('a.txt', 'a0');
  hook(p.root, 'turn-start', 't1');
  hook(p.root, 'shell', 't1', { command: 'rm gone.txt' });
  rmSync(p.file('gone.txt'));
  p.write('a.txt', 'a1');
  hook(p.root, 'turn-end', 't1');
  hook(p.root, 'turn-start', 't2');
  hook(p.root, 'edit', 't2', { paths: [p.file('a.txt')] });
  p.write('a.txt', 'a2');
  hook(p.root, 'turn-end', 't2');
  return p;
}

it('brings back a file deleted turns ago without touching other files', () => {
  const p = history();
  const store = new Store(p.root);
  const found = findRecoverable(store, p.file('gone.txt'))!;
  expect(found).toBeDefined();
  expect(found.turn?.id).toContain('t1');
  applyRestore(store, found.ref, { paths: [p.file('gone.txt')] });
  expect(p.read('gone.txt')).toBe('keep me\n');
  expect(p.read('a.txt')).toBe('a2');
  applyRestore(store, redoTarget(store)!, { operation: 'redo' });
  expect(existsSync(p.file('gone.txt'))).toBe(false);
});

it('picks the newest version that differs from the file on disk', () => {
  const p = history();
  const found = findRecoverable(new Store(p.root), p.file('a.txt'))!;
  const store = new Store(p.root);
  applyRestore(store, found.ref, { paths: [p.file('a.txt')] });
  expect(p.read('a.txt')).toBe('a1');
});

it('returns nothing for a file no snapshot has', () => {
  const p = history();
  p.write('new.txt', 'x');
  expect(findRecoverable(new Store(p.root), p.file('never.txt'))).toBeUndefined();
});

it('skips a deleted snapshot ref and restores the next available version', () => {
  const p = history();
  const store = new Store(p.root);
  const latest = findRecoverable(store, p.file('a.txt'))!;
  expect(latest).toBeDefined();
  const refs = [...new Set(store.entries().flatMap(e => e.ref ? [e.ref] : []))];
  const versions = store.repo.lookup(refs, 'a.txt');
  const oid = versions.get(latest.ref)?.oid;
  expect(oid).toBeDefined();
  const deleted = refs.filter(ref => versions.get(ref)?.oid === oid);
  for (const ref of deleted) store.repo.deleteRef(ref);
  expect(deleted.every(ref => !store.repo.refExists(ref))).toBe(true);
  expect(store.entries().some(e => e.ref === latest.ref)).toBe(true);
  expect(store.repo.lookup([latest.ref], 'a.txt').get(latest.ref)).toEqual({ exists: false, oid: undefined });

  const found = findRecoverable(store, p.file('a.txt'))!;
  expect(found).toBeDefined();
  expect(found.ref).not.toBe(latest.ref);
  expect(store.repo.refExists(found.ref)).toBe(true);
  applyRestore(store, found.ref, { paths: [p.file('a.txt')] });
  expect(p.read('a.txt')).toBe('a0');
  expect(existsSync(p.file('gone.txt'))).toBe(false);
});

it('returns nothing when every snapshot holding the file has been deleted', () => {
  const p = history();
  const store = new Store(p.root);
  const refs = [...new Set(store.entries().flatMap(e => e.ref ? [e.ref] : []))];
  const versions = store.repo.lookup(refs, 'gone.txt');
  const deleted = refs.filter(ref => versions.get(ref)?.oid);
  expect(deleted.length).toBeGreaterThan(0);
  for (const ref of deleted) store.repo.deleteRef(ref);
  expect(deleted.every(ref => !store.repo.refExists(ref))).toBe(true);
  expect(store.entries().some(e => e.ref && deleted.includes(e.ref))).toBe(true);
  expect(refs.some(ref => store.repo.refExists(ref))).toBe(true);
  expect(findRecoverable(store, p.file('gone.txt'))).toBeUndefined();
  expect(existsSync(p.file('gone.txt'))).toBe(false);
  expect(p.read('a.txt')).toBe('a2');
});
