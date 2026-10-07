import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { VERSION } from '../src/core/config.js';
import { hookEvents } from '../src/agents/install.js';

const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const HOOK_COMMAND = 'node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" hook claude';
const SKILLS = ['undo', 'turns', 'diff-turn', 'report'];

it('keeps every version in sync', () => {
  const version = json('package.json').version;
  expect(VERSION).toBe(version);
  expect(json('server.json').version).toBe(version);
  expect(json('server.json').packages[0].version).toBe(version);
  expect(json('.claude-plugin/plugin.json').version).toBe(version);
  expect(json('.codex-plugin/plugin.json').version).toBe(version);
  expect(json('.claude-plugin/marketplace.json').plugins[0].source.version).toBe(`^${version}`);
  expect(json('.agents/plugins/marketplace.json').plugins[0].source.version).toBe(`^${version}`);
});

it('selects Codex hooks independently from Claude Code and uses the same installer events', () => {
  const file = json('.codex-plugin/plugin.json').hooks;
  expect(file).toBe('./hooks/codex.json');
  const hooks = json(file).hooks;
  const events = hookEvents('codex');
  expect(Object.keys(hooks).sort()).toEqual(Object.keys(events).sort());
  for (const [event, matcher] of Object.entries(events)) {
    expect(hooks[event]).toHaveLength(1);
    expect(hooks[event][0].matcher ?? '').toBe(matcher);
    expect(hooks[event][0].hooks).toEqual([{ type: 'command', command: 'node "${PLUGIN_ROOT}/dist/cli.js" hook codex', timeout: 30 }]);
  }
});

it('registers the same Claude Code hooks as the installer, with a quoted plugin path', () => {
  const hooks = json('hooks/hooks.json').hooks;
  const events = hookEvents('claude');
  expect(Object.keys(hooks).sort()).toEqual(Object.keys(events).sort());
  for (const [event, matcher] of Object.entries(events)) {
    expect(hooks[event]).toHaveLength(1);
    expect(hooks[event][0].matcher ?? '').toBe(matcher);
    expect(hooks[event][0].hooks).toEqual([{ type: 'command', command: HOOK_COMMAND, timeout: 30 }]);
  }
});

it('declares the MCP server with the project folder as workspace', () => {
  const server = json('.claude-plugin/plugin.json').mcpServers.turnback;
  expect(server.command).toBe('node');
  expect(server.args).toEqual(['${CLAUDE_PLUGIN_ROOT}/dist/cli.js', 'mcp']);
  expect(server.env.TURNBACK_WORKSPACE).toBe('${CLAUDE_PROJECT_DIR}');
});

it('names each skill after its folder and describes it', () => {
  for (const skill of SKILLS) {
    const text = readFileSync(`skills/${skill}/SKILL.md`, 'utf8');
    expect(text).toMatch(new RegExp(`^---\nname: ${skill}\ndescription: .+`, 'm'));
  }
});

it('ships the plugin, but not the marketplace, in the npm package', () => {
  const r = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8', shell: true, windowsHide: true });
  const files: string[] = JSON.parse(r.stdout)[0].files.map((f: { path: string }) => f.path.replaceAll('\\', '/'));
  const expected = ['.codex-plugin/plugin.json', 'mcp/codex.json', '.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/codex.json', 'dist/cli.js', ...SKILLS.map(s => `skills/${s}/SKILL.md`)];
  for (const file of expected) expect(files).toContain(file);
  expect(files).not.toContain('.claude-plugin/marketplace.json');
  expect(files).not.toContain('.agents/plugins/marketplace.json');
  // Claude Code auto-discovers .mcp.json; Codex's config must not override its server.
  expect(files).not.toContain('.mcp.json');
}, 60_000);
