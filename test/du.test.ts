import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { diskUsage, prunable, pruneWorkspaces } from '../src/core/du.js';
import { workspaceDataDir } from '../src/core/config.js';
import { Store } from '../src/core/store.js';
import { CLI, hook, tempDir, tempProject } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;

function cli(root: string, home: string, args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, TURNBACK_HOME: home }, windowsHide: true });
}

/** One finished turn in `root`, recorded under the current TURNBACK_HOME. */
function oneTurn(root: string, turn = 't1') {
  writeFileSync(path.join(root, 'a.txt'), 'old');
  hook(root, 'edit', turn, { paths: [path.join(root, 'a.txt')] });
  writeFileSync(path.join(root, 'a.txt'), turn);
  hook(root, 'turn-end', turn);
}

it('remembers which workspace a data folder belongs to', () => {
  const p = tempProject('turnback-du-root-');
  oneTurn(p.root);
  const store = new Store(p.root);
  const file = path.join(workspaceDataDir(store.root), 'workspace.json');
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ root: store.root });
});

it('lists every workspace with its size, turns, and whether it still exists, largest first', () => {
  const p = tempProject('turnback-du-list-');
  oneTurn(p.root);
  const other = tempDir('turnback-du-other-');
  oneTurn(other, 't1');
  oneTurn(other, 't2');
  const usage = diskUsage(p.home);
  expect(usage).toHaveLength(2);
  expect(usage.map(u => u.bytes)).toEqual([...usage.map(u => u.bytes)].sort((a, b) => b - a));
  const mine = usage.find(u => u.root === new Store(p.root).root)!;
  expect(mine).toMatchObject({ exists: true, turns: 1, garbageBytes: 0 });
  expect(mine.bytes).toBeGreaterThan(0);
  expect(Date.parse(mine.lastActivity!)).toBeGreaterThan(Date.now() - 60_000);
  expect(usage.find(u => u.root === new Store(other).root)).toMatchObject({ exists: true, turns: 2 });
});

it('counts leftovers of interrupted writes as reclaimable', () => {
  const p = tempProject('turnback-du-garbage-');
  oneTurn(p.root);
  const dir = workspaceDataDir(new Store(p.root).root);
  writeFileSync(path.join(dir, 'repo.git', 'objects', 'pack', 'tmp_pack_test'), Buffer.alloc(4096));
  expect(diskUsage(p.home)[0].garbageBytes).toBeGreaterThanOrEqual(4096);
});

it('marks data of deleted workspaces and long-idle unknown ones as prunable, and removes only those', () => {
  const p = tempProject('turnback-du-prune-');
  oneTurn(p.root);
  const gone = tempDir('turnback-du-gone-');
  oneTurn(gone);
  const goneDir = workspaceDataDir(new Store(gone).root);
  rmSync(gone, { recursive: true, force: true });

  // A data folder from before 0.9.0: no workspace.json. One idle for 40 days, one used yesterday.
  const old = path.join(p.home, 'aaaaaaaaaaaaaaaaaaaaaaaa');
  const recent = path.join(p.home, 'bbbbbbbbbbbbbbbbbbbbbbbb');
  for (const [dir, age] of [[old, 40 * DAY], [recent, DAY]] as const) {
    mkdirSync(dir);
    const journal = path.join(dir, 'journal.jsonl');
    writeFileSync(journal, JSON.stringify({ agent: 'codex', session: 's', turn: 't', kind: 'turn-end', status: 'ok', id: 'x', time: new Date(Date.now() - age).toISOString() }) + '\n');
    const t = new Date(Date.now() - age);
    utimesSync(journal, t, t);
  }

  const usage = diskUsage(p.home);
  expect(usage).toHaveLength(4);
  expect(usage.find(u => u.dir === goneDir)).toMatchObject({ exists: false });
  expect(usage.find(u => u.dir === old)).toMatchObject({ root: undefined, exists: false });
  const candidates = prunable(usage);
  expect(candidates.map(u => u.dir).sort()).toEqual([goneDir, old].sort());

  expect(pruneWorkspaces(candidates)).toEqual({ removed: 2, bytes: candidates.reduce((n, u) => n + u.bytes, 0) });
  expect(existsSync(goneDir)).toBe(false);
  expect(existsSync(old)).toBe(false);
  expect(existsSync(recent)).toBe(true);
  expect(new Store(p.root).turns()).toHaveLength(1);
});

it('shows usage and prunes through the CLI, with a plan before --yes', () => {
  const p = tempProject('turnback-du-cli-');
  oneTurn(p.root);
  const gone = tempDir('turnback-du-cli-gone-');
  oneTurn(gone);
  const goneDir = workspaceDataDir(new Store(gone).root);
  rmSync(gone, { recursive: true, force: true });

  const list = cli(p.root, p.home, ['du']);
  expect(list.status).toBe(0);
  expect(list.stdout).toMatch(/^Turnback data in .+: .+ in 2 workspaces$/m);
  expect(list.stdout).toContain(new Store(p.root).root);
  expect(list.stdout).toMatch(/\(no longer exists\)/);
  expect(list.stdout).toContain('turnback du --prune');
  expect(JSON.parse(cli(p.root, p.home, ['du', '--json']).stdout)).toHaveLength(2);

  const plan = cli(p.root, p.home, ['du', '--prune']);
  expect(plan.stdout).toContain('Would remove the data of 1 workspace');
  expect(plan.stdout).toContain('Use --yes to remove it.');
  expect(existsSync(goneDir)).toBe(true);

  const done = cli(p.root, p.home, ['du', '--prune', '--yes']);
  expect(done.status).toBe(0);
  expect(done.stdout).toMatch(/^Removed the data of 1 workspace \(.+\)\.$/m);
  expect(existsSync(goneDir)).toBe(false);
  expect(new Store(p.root).turns()).toHaveLength(1);
});

it('packs every workspace with --compact, including ones with no recorded workspace', () => {
  const p = tempProject('turnback-du-compact-');
  oneTurn(p.root);
  const dir = workspaceDataDir(new Store(p.root).root);
  rmSync(path.join(dir, 'workspace.json'));
  const leftover = path.join(dir, 'repo.git', 'objects', 'pack', 'tmp_pack_test');
  writeFileSync(leftover, Buffer.alloc(4096));

  const result = cli(p.root, p.home, ['du', '--compact']);
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/^Packed 1 workspace: .+ → .+\.$/m);
  expect(existsSync(leftover)).toBe(false);
  expect(new Store(p.root).turns()).toHaveLength(1);
});

it('hints where an unknown workspace was from the files it recorded', () => {
  const p = tempProject('turnback-du-near-');
  oneTurn(p.root);
  const store = new Store(p.root);
  rmSync(path.join(workspaceDataDir(store.root), 'workspace.json'));
  expect(diskUsage(p.home)[0]).toMatchObject({ root: undefined, near: path.dirname(path.join(p.root, 'a.txt')) });
});
