import { existsSync } from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { applyRestore, planRestore, redoTarget } from '../src/core/restore.js';
import { Store } from '../src/core/store.js';
import { hook, tempProject } from './helpers.js';

let p: ReturnType<typeof tempProject>;
beforeEach(() => {
  process.env.TURNBACK_MAX_FILES = '3';
  p = tempProject('turnback-large-');
  for (const name of ['a', 'b', 'c', 'd', 'e']) p.write(`${name}.txt`, `${name}0`);
});
afterEach(() => { delete process.env.TURNBACK_MAX_FILES; });

it('switches large workspaces to edits-only and leaves shell commands unprotected', () => {
  const s = new Store(p.root);
  expect(s.warm().note).toMatch(/edits-only/);
  expect(s.mode()).toBe('edits-only');
  expect(s.status().mode).toBe('edits-only');
  expect(hook(p.root, 'shell', 't1', { command: 'rm -rf .' })?.status).toBe('unprotected');
});

it('restores only paths recorded by edit hooks', () => {
  new Store(p.root).warm();
  expect(hook(p.root, 'edit', 't1', { paths: [p.file('a.txt')] })?.status).toBe('ok');
  p.write('a.txt', 'agent');
  expect(hook(p.root, 'edit', 't1', { paths: [p.file('new.txt')] })?.status).toBe('ok');
  p.write('new.txt', 'created');
  expect(hook(p.root, 'turn-end')?.status).toBe('ok');
  // Changes that bypass edit hooks are not recorded, so restore must not touch them.
  p.write('b.txt', 'unrecorded');

  const s = new Store(p.root);
  const plan = planRestore(s, 't1');
  expect(plan.scope).toBe('recorded-paths');
  expect(plan.actions.map(a => `${a.action}:${a.path}`)).toEqual(['modify:a.txt', 'delete:new.txt']);

  const result = applyRestore(s, 't1', { token: plan.token, operation: 'undo' });
  expect(result.failed).toEqual([]);
  expect(p.read('a.txt')).toBe('a0');
  expect(existsSync(p.file('new.txt'))).toBe(false);
  expect(p.read('b.txt')).toBe('unrecorded');
  expect(p.read('c.txt')).toBe('c0');

  const redo = planRestore(s, redoTarget(s)!);
  expect(redo.actions.map(a => `${a.action}:${a.path}`)).toEqual(['modify:a.txt', 'create:new.txt']);
  applyRestore(s, redoTarget(s)!, { token: redo.token, operation: 'redo' });
  expect(p.read('a.txt')).toBe('agent');
  expect(p.read('new.txt')).toBe('created');
  expect(p.read('b.txt')).toBe('unrecorded');
});

it('keeps earlier turns restorable across later edits', () => {
  new Store(p.root).warm();
  hook(p.root, 'edit', 't1', { paths: [p.file('a.txt')] });
  p.write('a.txt', 'one');
  hook(p.root, 'turn-end', 't1');
  hook(p.root, 'edit', 't2', { paths: [p.file('c.txt')] });
  p.write('c.txt', 'two');
  hook(p.root, 'turn-end', 't2');

  const s = new Store(p.root);
  expect(planRestore(s, 't2').actions.map(a => a.path)).toEqual(['c.txt']);
  applyRestore(s, 't1');
  expect(p.read('a.txt')).toBe('a0');
  expect(p.read('c.txt')).toBe('c0');
});

it('decides the mode before the first change of a workspace that was never warmed', () => {
  // No warm ran: the first edit must not take a full snapshot of a workspace above the limit.
  expect(hook(p.root, 'edit', 't1', { paths: [p.file('a.txt')] })?.status).toBe('ok');
  const s = new Store(p.root);
  expect(s.mode()).toBe('edits-only');
  const baseline = s.entries().find(e => e.kind === 'baseline' && e.status === 'ok')!;
  expect([...s.repo.tree(baseline.ref!).keys()]).toEqual(['a.txt']);
  expect(hook(p.root, 'shell', 't1', { command: 'rm -rf .' })?.status).toBe('unprotected');
});

it('stops scanning once the workspace is known to be over the limit', () => {
  const scan = new Store(p.root).workspace.scan({ files: 2, bytes: Infinity });
  expect(scan.truncated).toBe(true);
  expect(scan.paths).toHaveLength(3);
  expect(new Store(p.root).workspace.scan().truncated).toBeUndefined();
});

it('keeps an edits-only decision without scanning again', () => {
  const s = new Store(p.root);
  s.warm();
  expect(s.warm().note).toMatch(/already/);
});

it('reports status without scanning the workspace once edits-only mode is decided', async () => {
  const { vi } = await import('vitest');
  const s = new Store(p.root);
  s.warm();
  const scan = vi.spyOn(s.workspace, 'scan');
  const status = s.status();
  expect(status.mode).toBe('edits-only');
  expect(status.skippedFiles).toEqual([]);
  expect(scan).not.toHaveBeenCalled();
});

it('stops the status scan at the edits-only limit when no mode is decided yet', async () => {
  const { vi } = await import('vitest');
  const s = new Store(p.root);
  const scan = vi.spyOn(s.workspace, 'scan');
  expect(s.status().mode).toBe('edits-only');
  expect(scan).toHaveBeenCalledTimes(1);
  expect(scan.mock.calls[0][0]).toMatchObject({ files: 3 });
  expect(scan.mock.results[0].value.paths.length).toBeLessThanOrEqual(4);
});

it('still lists skipped files in a full-mode workspace', () => {
  delete process.env.TURNBACK_MAX_FILES;
  p.write('big.bin', Buffer.alloc(5 * 1024 * 1024 + 1));
  const status = new Store(p.root).status();
  expect(status.mode).toBe('full');
  expect(status.skippedFiles).toEqual(['big.bin']);
});
