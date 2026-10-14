import { randomBytes } from 'node:crypto';
import { readdirSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { turnKey } from '../src/core/journal.js';
import { Store } from '../src/core/store.js';
import { turnWarning } from '../src/core/warnings.js';
import { hook, tempProject } from './helpers.js';

afterEach(() => { delete process.env.TURNBACK_HOOK_WAIT_MS; });

const turnEntries = (store: Store, turn: string) => store.entries().filter(e => turnKey(e) === `codex:s:${turn}`);

/** A warmed workspace with `a.txt` changed since the warm, so the next baseline must write the index. */
function warmedAndChanged() {
  const p = tempProject('turnback-speed-');
  p.write('a.txt', 'a0');
  p.write('b.txt', 'b0');
  const store = new Store(p.root);
  expect(store.warm().status).toBe('ok');
  p.write('a.txt', 'a1');
  return { p, store, indexLock: path.join(store.repo.gitDir, 'index.lock') };
}

it('removes an index.lock left by a killed git process and snapshots again', () => {
  const { p, store, indexLock } = warmedAndChanged();
  writeFileSync(indexLock, '');
  const old = new Date(Date.now() - 5 * 60_000);
  utimesSync(indexLock, old, old);

  expect(hook(p.root, 'edit', 't1', { paths: [p.file('b.txt')] })?.status).toBe('ok');
  expect(turnEntries(store, 't1').find(e => e.kind === 'baseline')?.status).toBe('ok');
  expect(readdirSync(store.repo.gitDir)).not.toContain('index.lock');
});

it('tries a failed baseline once per turn instead of on every tool call', () => {
  const { p, store, indexLock } = warmedAndChanged();
  // A fresh lock may belong to a git process that is still running, so it is left alone.
  writeFileSync(indexLock, '');

  hook(p.root, 'edit', 't1', { paths: [p.file('a.txt')] });
  const start = performance.now();
  const second = hook(p.root, 'edit', 't1', { paths: [p.file('b.txt')] });
  hook(p.root, 'shell', 't1', { command: 'ls' });

  expect(second).toMatchObject({ status: 'unprotected', note: expect.stringMatching(/earlier in this turn/) });
  expect(turnEntries(store, 't1').filter(e => e.kind === 'baseline')).toHaveLength(1);
  expect(performance.now() - start).toBeLessThan(2_000);
});

it('waits for a running warm once per turn and for a bounded time', () => {
  process.env.TURNBACK_HOOK_WAIT_MS = '400';
  const { p, store } = warmedAndChanged();
  const lock = path.join(store.dir, 'lock');
  writeFileSync(lock, `${process.pid}\n${Date.now()}`);

  let start = performance.now();
  const first = hook(p.root, 'edit', 't1', { paths: [p.file('a.txt')] });
  expect(performance.now() - start).toBeGreaterThanOrEqual(400);
  expect(performance.now() - start).toBeLessThan(5_000);
  expect(first).toMatchObject({ status: 'unprotected', note: expect.stringMatching(/first snapshot/) });

  start = performance.now();
  expect(hook(p.root, 'edit', 't1', { paths: [p.file('b.txt')] })?.status).toBe('unprotected');
  expect(performance.now() - start).toBeLessThan(300);

  // Once the warm is done, the next tool call in the same turn takes the baseline.
  unlinkSync(lock);
  expect(hook(p.root, 'edit', 't1', { paths: [p.file('b.txt')] })?.status).toBe('ok');
});

it('does not wait for a lock left by a killed process', () => {
  process.env.TURNBACK_HOOK_WAIT_MS = '3000';
  const { p, store } = warmedAndChanged();
  const lock = path.join(store.dir, 'lock');
  writeFileSync(lock, '1\n0');
  const old = new Date(Date.now() - 5 * 60_000);
  utimesSync(lock, old, old);

  const start = performance.now();
  expect(hook(p.root, 'edit', 't1', { paths: [p.file('a.txt')] })?.status).toBe('ok');
  expect(performance.now() - start).toBeLessThan(2_500);
});

it('warns at the end of a turn whose changes could not be saved', () => {
  const { p, indexLock } = warmedAndChanged();
  writeFileSync(indexLock, '');
  hook(p.root, 'edit', 't1', { paths: [p.file('a.txt')] });
  p.write('a.txt', 'a2');
  hook(p.root, 'turn-end', 't1');
  const warning = turnWarning({ agent: 'codex', session: 's', turn: 't1', cwd: p.root, kind: 'turn-end' }, []);
  expect(warning).toMatch(/could not be saved/);
  expect(warning).toMatch(/turnback status/);
});

it('writes a first snapshot of a few large files as a pack, not as loose objects', () => {
  const p = tempProject('turnback-speed-pack-');
  // Fewer objects than git's unpack limit (100), which fast-import would otherwise store loose.
  for (let i = 0; i < 5; i++) p.write(`big${i}.bin`, randomBytes(300_000));
  const store = new Store(p.root);
  expect(store.warm().status).toBe('ok');
  expect(store.repo.objectStats().looseBytes).toBeLessThan(100_000);
});
