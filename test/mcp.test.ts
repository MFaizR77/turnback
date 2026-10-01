import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { mkdirSync, rmSync } from 'node:fs';
import { beforeEach, expect, it } from 'vitest';
import { CLI, hook, tempProject } from './helpers.js';

let p: ReturnType<typeof tempProject>;

/** One Codex turn that changes a.txt from "old" to "agent". */
beforeEach(() => {
  p = tempProject('turnback-mcp-');
  p.write('a.txt', 'old');
  hook(p.root, 'edit', 't', { paths: [p.file('a.txt')] });
  p.write('a.txt', 'agent');
  hook(p.root, 'turn-end', 't');
});

async function connect(client: Client) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp'], env: { ...process.env, TURNBACK_HOME: p.home } });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: { workspace: p.root, ...args } });
  return { ...result, data: result.structuredContent as any };
}

it('serves read tools and a two-step restore', async () => {
  const client = await connect(new Client({ name: 'test', version: '1.0.0' }));
  try {
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(['blame_file', 'compare_turns', 'diff_range', 'diff_turn', 'file_history', 'list_turns', 'recover_file', 'redo', 'restore', 'search_turns', 'session_report', 'status', 'turn_steps']);
    expect(tools.find(t => t.name === 'restore')?.annotations?.destructiveHint).toBe(true);
    expect(tools.find(t => t.name === 'list_turns')?.annotations?.readOnlyHint).toBe(true);
    expect((await call(client, 'list_turns', {})).data.turns[0].changedFiles).toBe(1);

    const preview = await call(client, 'restore', { target: 't' });
    expect(preview.data.confirm_token).toBeTypeOf('string');
    expect(p.read('a.txt')).toBe('agent');

    const restored = await call(client, 'restore', { target: 't', token: preview.data.confirm_token });
    expect(restored.data.applied).toContain('a.txt');
    expect(p.read('a.txt')).toBe('old');
  } finally {
    await client.close();
  }
}, 15_000);

it('rejects a stale token and skips manual edits without elicitation', async () => {
  const client = await connect(new Client({ name: 'test', version: '1.0.0' }));
  try {
    const first = await call(client, 'restore', { target: 't' });
    await call(client, 'restore', { target: 't', token: first.data.confirm_token });

    const stalePreview = await call(client, 'redo', {});
    p.write('a.txt', 'manual');
    expect((await call(client, 'redo', { token: stalePreview.data.confirm_token })).isError).toBe(true);

    const preview = await call(client, 'redo', {});
    const cautious = await call(client, 'redo', { token: preview.data.confirm_token });
    expect(cautious.data.skipped).toContain('a.txt');
    expect(p.read('a.txt')).toBe('manual');
  } finally {
    await client.close();
  }
}, 15_000);

it('skips manual edits once when a modern client declines approval', async () => {
  p.write('a.txt', 'manual');
  const client = new Client({ name: 'modern-test', version: '1.0.0' }, { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: { pin: '2026-07-28' } } });
  let asked = 0;
  client.setRequestHandler('elicitation/create', async () => { asked++; return { action: 'decline' }; });
  await connect(client);
  try {
    const preview = await call(client, 'restore', { target: 't' });
    const result = await call(client, 'restore', { target: 't', token: preview.data.confirm_token });
    expect(result.isError).toBeFalsy();
    expect(result.data.skipped).toContain('a.txt');
    expect(asked).toBe(1);
    expect(p.read('a.txt')).toBe('manual');
  } finally {
    await client.close();
  }
}, 15_000);

it('asks a modern client to approve overwriting manual edits', async () => {
  p.write('a.txt', 'manual');
  const client = new Client({ name: 'modern-test', version: '1.0.0' }, { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: { pin: '2026-07-28' } } });
  client.setRequestHandler('elicitation/create', async () => ({ action: 'accept', content: {} }));
  await connect(client);
  try {
    const preview = await call(client, 'restore', { target: 't' });
    const result = await call(client, 'restore', { target: 't', token: preview.data.confirm_token });
    expect(result.data.applied).toContain('a.txt');
    expect(p.read('a.txt')).toBe('old');
  } finally {
    await client.close();
  }
}, 15_000);

it('uses TURNBACK_WORKSPACE when no workspace is given, ignoring unexpanded values', async () => {
  const run = async (value: string) => {
    const transport = new StdioClientTransport({
      command: process.execPath, args: [CLI, 'mcp'], cwd: p.home,
      env: { ...process.env, TURNBACK_HOME: p.home, TURNBACK_WORKSPACE: value },
    });
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(transport);
    try {
      const result = await client.callTool({ name: 'list_turns', arguments: {} });
      return (result.structuredContent as any).turns.length;
    } finally {
      await client.close();
    }
  };
  expect(await run(p.root)).toBe(1);
  expect(await run('${CLAUDE_PROJECT_DIR}')).toBe(0);
}, 30_000);

it('lists the steps of a turn with their snapshot refs', async () => {
  const client = await connect(new Client({ name: 'test', version: '1.0.0' }));
  try {
    const { data } = await call(client, 'turn_steps', { turn: 't' });
    expect(data.steps).toHaveLength(1);
    expect(data.steps[0].ref).toMatch(/^refs\/turnback\//);
  } finally {
    await client.close();
  }
}, 15_000);

it('returns a session report as markdown', async () => {
  const client = await connect(new Client({ name: 'test', version: '1.0.0' }));
  try {
    const result = await call(client, 'session_report', {});
    expect((result.content as any)[0].text).toMatch(/^# Turnback report/);
  } finally {
    await client.close();
  }
}, 15_000);

it('shows what changed since a turn started, including uncommitted edits', async () => {
  const client = await connect(new Client({ name: 'test', version: '1.0.0' }));
  try {
    p.write('a.txt', 'later');
    const { data } = await call(client, 'diff_range', { from: 't', patch: true });
    expect(data.diff).toContain('+later');
    expect((await call(client, 'file_history', { path: 'a.txt' })).data.turns).toHaveLength(1);
    expect((await call(client, 'search_turns', { query: 'a.txt' })).data.turns).toHaveLength(1);
  } finally {
    await client.close();
  }
}, 15_000);

it('blames a file and finds a version to recover, leaving the restore to the restore tool', async () => {
  const client = await connect(new Client({ name: 'test', version: '1.0.0' }));
  try {
    const { tools } = await client.listTools();
    expect(tools.find(t => t.name === 'recover_file')?.annotations?.readOnlyHint).toBe(true);

    const blame = await call(client, 'blame_file', { path: 'a.txt' });
    expect(blame.data.lines).toEqual([{ line: 1, text: 'agent', source: 'turn', turn: expect.objectContaining({ agent: 'codex' }) }]);
    expect(blame.content[0].text).toMatch(/codex .*│ 1 │ agent/);

    const found = await call(client, 'recover_file', { path: 'a.txt' });
    expect(found.data).toMatchObject({ target: expect.stringMatching(/^refs\/turnback\//), paths: ['a.txt'] });
    expect(found.content[0].text).toMatch(/^Found a version of a\.txt from just before turn "codex:s:t" \(codex\)\./);
    expect(p.read('a.txt')).toBe('agent');
    const preview = await call(client, 'restore', { target: found.data.target, paths: found.data.paths });
    await call(client, 'restore', { target: found.data.target, paths: found.data.paths, token: preview.data.confirm_token });
    expect(p.read('a.txt')).toBe('old');

    expect((await call(client, 'recover_file', { path: 'never.txt' })).isError).toBe(true);
  } finally {
    await client.close();
  }
}, 60_000);

it('describes an end snapshot as a version from the completed turn', async () => {
  p.write('a.txt', 'manual');
  const client = await connect(new Client({ name: 'test', version: '1.0.0' }));
  try {
    const found = await call(client, 'recover_file', { path: 'a.txt' });
    expect(found.isError).toBeFalsy();
    expect(found.content[0].text).toMatch(/^Found a version of a\.txt from turn "codex:s:t" \(codex\)\./);
    expect(found.data).toMatchObject({ paths: ['a.txt'], turn: { id: 'codex:s:t' } });
    expect(p.read('a.txt')).toBe('manual');
  } finally {
    await client.close();
  }
}, 15_000);

it('finds the changed files of a deleted folder to recover', async () => {
  mkdirSync(p.file('src'));
  p.write('src/a.txt', 'a');
  p.write('src/b.txt', 'b');
  hook(p.root, 'turn-start', 't2');
  hook(p.root, 'shell', 't2', { command: 'rm -rf src' });
  rmSync(p.file('src'), { recursive: true });
  hook(p.root, 'turn-end', 't2');
  const client = await connect(new Client({ name: 'test', version: '1.0.0' }));
  try {
    const found = await call(client, 'recover_file', { path: 'src' });
    expect(found.isError).toBeFalsy();
    expect(found.data).toMatchObject({ paths: ['src/a.txt', 'src/b.txt'], turn: { id: 'codex:s:t2' } });
    expect(found.content[0].text).toMatch(/^Found a version of src\/ \(2 files\) from just before turn "codex:s:t2" \(codex\)\./);
    expect(found.content[0].text).toContain('paths ["src/a.txt","src/b.txt"]');
  } finally {
    await client.close();
  }
}, 15_000);
