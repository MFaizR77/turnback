import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { applyRestore } from '../src/core/restore.js';
import { Store } from '../src/core/store.js';
import { CLI, tempProject } from './helpers.js';

type P = ReturnType<typeof tempProject>;

/** Send one Claude hook event; returns the git commands it ran (TURNBACK_TRACE_GIT) and its output. */
function send(p: P, payload: object) {
  const r = spawnSync(process.execPath, [CLI, 'hook', 'claude'], {
    cwd: p.root, input: JSON.stringify({ session_id: 's', cwd: p.root, ...payload }), encoding: 'utf8',
    env: { ...process.env, TURNBACK_HOME: p.home, TURNBACK_TRACE_GIT: '1' }, windowsHide: true,
  });
  const git = r.stderr.split('\n').flatMap(line => /^git (\S+) \d+ms$/.exec(line)?.[1] ?? []);
  return { git, stdout: r.stdout, status: r.status };
}

const edit = (p: P, rel: string) => send(p, { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: p.file(rel) } });

function editTurn(p: P, files: Record<string, string>, prompt = 'edit') {
  send(p, { hook_event_name: 'UserPromptSubmit', prompt });
  const edits = Object.entries(files).map(([rel, content]) => {
    const traced = edit(p, rel);
    p.write(rel, content);
    return traced;
  });
  return { edits, stop: send(p, { hook_event_name: 'Stop' }) };
}

it('snapshots with only git add and write-tree, and leaves a valid shadow repo', () => {
  const p = tempProject('turnback-procs-');
  p.write('a.txt', 'a0');
  p.write('b.txt', 'b0');
  spawnSync(process.execPath, [CLI, 'warm'], { cwd: p.root, env: { ...process.env, TURNBACK_HOME: p.home }, windowsHide: true });
  const { edits, stop } = editTurn(p, { 'a.txt': 'a1', 'b.txt': 'b1' });
  expect(edits[1].git).toEqual(['add', 'write-tree']);
  expect(stop.git).toEqual(['add', 'write-tree']);

  const store = new Store(p.root);
  const fsck = spawnSync('git', [`--git-dir=${store.repo.gitDir}`, 'fsck', '--no-progress', '--strict'], { encoding: 'utf8', windowsHide: true });
  expect(fsck.status, fsck.stderr).toBe(0);
  const turn = store.turns()[0];
  expect(store.repo.refExists(turn.end!)).toBe(true);
  expect(store.repo.diffNameStatus(turn.baseline, turn.end!).map(c => c.path)).toEqual(['a.txt', 'b.txt']);
  applyRestore(store, turn.id);
  expect(p.read('a.txt')).toBe('a0');
  expect(p.read('b.txt')).toBe('b0');
}, 60_000);

it('still compares the turn when an edited file looks like a secret, and warns', () => {
  const p = tempProject('turnback-procs-secret-');
  p.write('.env', 'A=1');
  const { stop } = editTurn(p, { '.env': 'A=2' });
  expect(stop.git).toContain('diff');
  expect(JSON.parse(stop.stdout).systemMessage).toContain('changed .env');
}, 60_000);
