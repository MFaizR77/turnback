import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { tempDir, tempProject } from './helpers.js';

it('records a shell deletion and restores through a plugin without node_modules', async () => {
  const plugin = path.join(tempDir('turnback-codex-plugin-'), 'plugin with spaces');
  mkdirSync(plugin);
  for (const file of ['dist', '.codex-plugin', 'mcp', 'hooks']) {
    cpSync(path.resolve(file), path.join(plugin, file), { recursive: true });
  }
  const manifest = JSON.parse(readFileSync(path.join(plugin, '.codex-plugin/plugin.json'), 'utf8'));
  const hooks = JSON.parse(readFileSync(path.join(plugin, manifest.hooks), 'utf8')).hooks;
  const p = tempProject('turnback-codex-plugin-workspace-');
  p.write('app.txt', 'original');
  p.write('.gitignore', '.env\n');
  p.write('.env', 'TOKEN=fixture\n');
  const send = (event: string, payload: object = {}) => {
    const command = hooks[event][0].hooks[0].command.replaceAll('${PLUGIN_ROOT}', plugin);
    const result = spawnSync(command, {
      cwd: p.root, shell: true, encoding: 'utf8', windowsHide: true, timeout: 15_000,
      env: { ...process.env, TURNBACK_HOME: p.home, PLUGIN_ROOT: plugin },
      input: JSON.stringify({ hook_event_name: event, session_id: 'plugin-session', turn_id: 't', cwd: p.root, ...payload }),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({});
  };
  send('UserPromptSubmit', { prompt: 'delete app and env' });
  send('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'delete app.txt and .env' } });
  rmSync(p.file('app.txt'));
  rmSync(p.file('.env'));
  send('Stop');

  const server = JSON.parse(readFileSync(path.join(plugin, manifest.mcpServers), 'utf8')).mcpServers.turnback;
  const env = Object.fromEntries(server.env_vars.map((name: string) => [name, process.env[name]]));
  const client = new Client({ name: 'plugin-test', version: '0.9.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: server.args, cwd: path.resolve(plugin, server.cwd), env,
  }));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: { workspace: p.root, ...args } });
    expect(result.isError).not.toBe(true);
    return result.structuredContent as any;
  };
  try {
    const { turns } = await call('list_turns');
    expect(turns).toHaveLength(1);
    expect(turns[0].agent).toBe('codex');
    expect(turns[0].changedFiles).toBe(2);
    const plan = await call('restore', { target: turns[0].id });
    expect(plan.confirm_token).toBeTypeOf('string');
    await call('restore', { target: turns[0].id, token: plan.confirm_token });
    expect(p.read('app.txt')).toBe('original');
    expect(p.read('.env')).toBe('TOKEN=fixture\n');
    const redo = await call('redo');
    await call('redo', { token: redo.confirm_token });
    expect(existsSync(p.file('app.txt'))).toBe(false);
    expect(existsSync(p.file('.env'))).toBe(false);
    expect(await call('recover_file', { path: 'app.txt' })).toHaveProperty('target');
  } finally {
    await client.close();
  }
}, 30_000);
