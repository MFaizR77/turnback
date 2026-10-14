import { spawnSync } from 'node:child_process';
import { existsSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, expect, it } from 'vitest';
import { applyRestore, planRestore } from '../src/core/restore.js';
import { Store } from '../src/core/store.js';
import { hook, tempProject } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;
let p: ReturnType<typeof tempProject>;

beforeEach(() => {
  p = tempProject('turnback-gc-');
  p.write('a.txt', 'v0');
  for (const [i, turn] of ['t1', 't2', 't3'].entries()) {
    hook(p.root, 'edit', turn, { paths: [p.file('a.txt')] });
    p.write('a.txt', `v${i + 1}`);
    hook(p.root, 'turn-end', turn);
  }
});

const refCount = (s: Store) =>
  spawnSync('git', [`--git-dir=${s.repo.gitDir}`, 'for-each-ref', 'refs/turnback'], { encoding: 'utf8' })
    .stdout.split('\n').filter(Boolean).length;

it('keeps recent turns under the default retention', () => {
  const s = new Store(p.root);
  expect(s.gc()).toEqual({ expired: 0, deletedRefs: 0, compacted: false });
  expect(s.turns()).toHaveLength(3);
});

it('expires old turns, deletes only unshared refs, and keeps the rest restorable', () => {
  const s = new Store(p.root);
  const before = refCount(s);
  const result = s.gc({ now: Date.now() + 8 * DAY, keepTurns: 1 });
  expect(result.expired).toBe(2);
  expect(result.deletedRefs).toBeGreaterThan(0);
  expect(refCount(s)).toBe(before - result.deletedRefs);
  expect(s.turns().map(t => t.id)).toEqual(['codex:s:t3']);
  expect(() => planRestore(s, 't1')).toThrow(/Unknown/);

  applyRestore(s, 't3');
  expect(p.read('a.txt')).toBe('v2');
});

it('runs automatic gc at most once a day', () => {
  const s = new Store(p.root);
  expect(s.gcIfDue()).toBeDefined();
  expect(s.gcIfDue()).toBeUndefined();
  expect(s.gcIfDue(Date.now() + 2 * DAY)).toBeDefined();
});

const looseObjects = (s: Store) => s.repo.objectStats().loose;

it('cleans up leftovers of an interrupted write and packs objects even when no turn expires', () => {
  const s = new Store(p.root);
  const leftover = path.join(s.repo.gitDir, 'objects', 'pack', 'tmp_pack_test');
  writeFileSync(leftover, 'partial pack');
  expect(s.repo.objectStats().garbage).toBe(1);
  expect(looseObjects(s)).toBeGreaterThan(0);
  expect(s.gc()).toEqual({ expired: 0, deletedRefs: 0, compacted: true });
  expect(existsSync(leftover)).toBe(false);
  expect(looseObjects(s)).toBe(0);
  applyRestore(s, 't1');
  expect(p.read('a.txt')).toBe('v0');
});

it('packs loose objects when asked, as turnback gc does', () => {
  const s = new Store(p.root);
  expect(looseObjects(s)).toBeGreaterThan(0);
  expect(s.gc({ compact: true }).compacted).toBe(true);
  expect(looseObjects(s)).toBe(0);
  expect(s.turns()).toHaveLength(3);
});

const refNames = (s: Store) =>
  spawnSync('git', [`--git-dir=${s.repo.gitDir}`, 'for-each-ref', '--format=%(refname)', 'refs/turnback'], { encoding: 'utf8' })
    .stdout.split('\n').filter(Boolean);

it('expires old warm and restore snapshots like turns, but keeps marks and the latest snapshot', () => {
  const s = new Store(p.root);
  const mark = s.mark('keep me');
  p.write('a.txt', 'w1');
  expect(s.warm().status).toBe('ok');
  const warmRef = s.entries().at(-1)!.ref!;
  applyRestore(s, 't3');
  const restoreRefs = s.entries().filter(e => e.session === 'restore').map(e => e.ref!);
  // A later agent turn means a redo can no longer need the restore's safety snapshots.
  hook(p.root, 'edit', 't4', { paths: [p.file('a.txt')] });
  p.write('a.txt', 'w2');
  hook(p.root, 'turn-end', 't4');
  p.write('a.txt', 'w3');
  const latest = s.warm().ref!;

  s.gc({ now: Date.now() + 8 * DAY, keepTurns: 0 });
  const refs = refNames(s);
  expect(refs).toEqual(expect.arrayContaining([mark.ref, latest]));
  expect(refs.filter(r => [warmRef, ...restoreRefs].includes(r))).toEqual([]);
  applyRestore(s, 'keep me');
  expect(p.read('a.txt')).toBe('v3');
});

it('removes files left by old sessions and interrupted writes', () => {
  const s = new Store(p.root);
  const at = (file: string, age: number) => {
    writeFileSync(file, '{}');
    const time = new Date(Date.now() - age);
    utimesSync(file, time, time);
    return file;
  };
  const oldSession = at(path.join(s.dir, 'active-old.json'), 8 * DAY);
  const session = at(path.join(s.dir, 'active-new.json'), 0);
  const oldPaths = at(path.join(s.dir, 'paths-old'), 2 * 60 * 60 * 1000);
  const paths = at(path.join(s.dir, 'paths-new'), 0);
  const oldTmp = at(path.join(s.repo.gitDir, 'refs', 'turnback', 's', 'x.123.tmp'), 2 * 60 * 60 * 1000);

  s.gc();
  expect([oldSession, oldPaths, oldTmp].filter(existsSync)).toEqual([]);
  expect([session, paths].filter(existsSync)).toEqual([session, paths]);
});
