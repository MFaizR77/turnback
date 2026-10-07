import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Agent } from '../core/types.js';
import { opencodePluginSource } from './opencode-plugin.js';
import { codexConfigDir, codexPluginEnabled } from './codex-plugin.js';

const AGENTS: Exclude<Agent, 'manual'>[] = ['claude', 'codex', 'gemini', 'cursor', 'opencode', 'antigravity'];
/** Marks entries owned by Turnback, so reinstall and uninstall never touch other entries. */
const MARKER = 'turnback:';
const TOML_BLOCK = /\n?# turnback begin[\s\S]*?# turnback end\n?/g;

/** Agents installed through a hook config file. */
type HookAgent = Exclude<Agent, 'opencode' | 'manual'>;

interface AgentSpec {
  /** Hook file, relative to home (user level) or the project root. */
  hooksFile: (project: boolean) => string;
  /** Hook event → tool matcher (empty = all). */
  events: Record<string, string>;
  /** Timeout units differ: Gemini uses milliseconds, the others seconds. */
  timeout: number;
  /**
   * `grouped`: `{ hooks: { Event: [{ matcher, hooks: [...] }] } }`.
   * `flat`: Cursor's `{ hooks: { event: [{ command }] } }`.
   * `named`: Antigravity's `{ <name>: { Event: [...] } }`; Turnback owns the `turnback` key.
   */
  layout: 'grouped' | 'flat' | 'named';
  /** Where the MCP server is registered; `inline` = in the same hook file, `undefined` = not supported at this level. */
  mcp: 'inline' | { file: (base: string, project: boolean) => string | undefined; format: 'json' | 'toml' };
}

const SPECS: Record<HookAgent, AgentSpec> = {
  claude: {
    hooksFile: () => '.claude/settings.json',
    events: { SessionStart: '', UserPromptSubmit: '', PreToolUse: 'Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit', Stop: '' },
    timeout: 30,
    layout: 'grouped',
    mcp: { file: (base, project) => path.join(base, project ? '.mcp.json' : '.claude.json'), format: 'json' },
  },
  codex: {
    hooksFile: () => '.codex/hooks.json',
    events: { SessionStart: '', UserPromptSubmit: '', PreToolUse: 'Bash|apply_patch|Edit|Write', Stop: '' },
    timeout: 30,
    layout: 'grouped',
    mcp: { file: base => path.join(base, '.codex', 'config.toml'), format: 'toml' },
  },
  gemini: {
    hooksFile: () => '.gemini/settings.json',
    events: { SessionStart: '', BeforeAgent: '', BeforeTool: 'write_file|replace|run_shell_command', AfterAgent: '' },
    timeout: 30_000,
    layout: 'grouped',
    mcp: 'inline',
  },
  cursor: {
    hooksFile: () => '.cursor/hooks.json',
    events: { sessionStart: '', beforeSubmitPrompt: '', preToolUse: 'Write|StrReplace|Delete', beforeShellExecution: '', stop: '' },
    timeout: 30,
    layout: 'flat',
    mcp: { file: base => path.join(base, '.cursor', 'mcp.json'), format: 'json' },
  },
  antigravity: {
    hooksFile: project => project ? '.agents/hooks.json' : '.gemini/config/hooks.json',
    events: { PreInvocation: '', PreToolUse: 'write_to_file|replace_file_content|multi_replace_file_content|run_command', Stop: '' },
    timeout: 30,
    layout: 'named',
    // Antigravity only reads MCP servers from the user-level config.
    mcp: { file: (base, project) => project ? undefined : path.join(base, '.gemini', 'config', 'mcp_config.json'), format: 'json' },
  },
};

/** Hook event → tool matcher for one agent; plugin hook files must match it. */
export const hookEvents = (agent: HookAgent) => SPECS[agent].events;

/** Install hooks and the MCP server. Other config is kept; calling again does not duplicate entries. */
export function install(which: string, project: boolean, root: string, cli: string, withMcp = true): string[] {
  requireGit();
  const touched: string[] = [];
  for (const agent of selectAgents(which)) {
    const base = project ? root : homedir();
    if (agent === 'claude') {
      const userDir = process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude');
      // Plugins can be enabled at user, project, or local scope; any of them already records turns here.
      const settings = [...new Set([base, root])].flatMap(dir => ['settings.json', 'settings.local.json'].map(f => path.join(dir, '.claude', f)));
      settings.push(path.join(userDir, 'settings.json'));
      if (claudePluginEnabled(settings)) {
        touched.push('skipped claude: the Turnback plugin is enabled and already records turns');
        continue;
      }
    }
    if (agent === 'opencode') {
      touched.push(...installOpencode(base, project, cli, withMcp));
      continue;
    }
    if (agent === 'codex' && codexPluginEnabled(root)) {
      touched.push('skipped codex: the Turnback plugin is enabled; review and trust its hooks in /hooks');
      continue;
    }
    const spec = SPECS[agent];
    const file = hooksConfigFile(agent, spec, base, project);
    const config = readJson(file);
    if (spec.layout === 'named') {
      config.turnback = namedHooks(agent, spec, cli);
    } else {
      const hooks = config.hooks ??= {};
      for (const [event, matcher] of Object.entries(spec.events)) {
        hooks[event] = [...withoutTurnback(spec, hooks[event]), hookEntry(agent, spec, event, matcher, cli)];
      }
      if (spec.layout === 'flat') config.version = 1;
    }
    if (withMcp && spec.mcp === 'inline') (config.mcpServers ??= {}).turnback = mcpServer(cli);
    writeJson(file, config);
    touched.push(file);

    const mcpFile = withMcp && spec.mcp !== 'inline' ? mcpConfigFile(agent, spec, base, project) : undefined;
    if (mcpFile && spec.mcp !== 'inline') {
      if (spec.mcp.format === 'toml') writeToml(mcpFile, cli);
      else updateJson(mcpFile, m => { (m.mcpServers ??= {}).turnback = mcpServer(cli); });
      touched.push(mcpFile);
    }
  }
  return touched;
}

/** True if a Claude Code settings file enables a `turnback@<marketplace>` plugin, whose hooks already record turns. */
export function claudePluginEnabled(settingsFiles: string[]): boolean {
  return settingsFiles.some(file => {
    try {
      const enabled = JSON.parse(readFileSync(file, 'utf8')).enabledPlugins ?? {};
      return Object.entries(enabled).some(([id, on]) => id.startsWith('turnback@') && on === true);
    } catch {
      return false;
    }
  });
}

/** Remove only entries owned by Turnback. */
export function uninstall(which: string, project: boolean, root: string): string[] {
  const touched: string[] = [];
  for (const agent of selectAgents(which)) {
    const base = project ? root : homedir();
    if (agent === 'opencode') {
      touched.push(...uninstallOpencode(base, project));
      continue;
    }
    const spec = SPECS[agent];
    const file = hooksConfigFile(agent, spec, base, project);
    if (existsSync(file)) {
      updateJson(file, config => {
        if (spec.layout === 'named') delete config.turnback;
        else for (const event of Object.keys(config.hooks ?? {})) config.hooks[event] = withoutTurnback(spec, config.hooks[event]);
        if (spec.mcp === 'inline') delete config.mcpServers?.turnback;
      });
      touched.push(file);
    }
    if (spec.mcp === 'inline') continue;
    const mcpFile = mcpConfigFile(agent, spec, base, project);
    if (!mcpFile || !existsSync(mcpFile)) continue;
    if (spec.mcp.format === 'toml') writeFileSync(mcpFile, readFileSync(mcpFile, 'utf8').replace(TOML_BLOCK, '\n'));
    else updateJson(mcpFile, m => { delete m.mcpServers?.turnback; });
    touched.push(mcpFile);
  }
  return touched;
}

function hooksConfigFile(agent: HookAgent, spec: AgentSpec, base: string, project: boolean): string {
  return agent === 'codex' && !project ? path.join(codexConfigDir(), 'hooks.json') : path.join(base, spec.hooksFile(project));
}

function mcpConfigFile(agent: HookAgent, spec: AgentSpec, base: string, project: boolean): string | undefined {
  if (spec.mcp === 'inline') return undefined;
  return agent === 'codex' && !project ? path.join(codexConfigDir(), 'config.toml') : spec.mcp.file(base, project);
}

function requireGit(): void {
  const match = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true }).stdout?.match(/(\d+)\.(\d+)/);
  const [major, minor] = match ? [Number(match[1]), Number(match[2])] : [0, 0];
  if (major < 2 || (major === 2 && minor < 25)) throw new Error('Git >= 2.25 is required');
}

function selectAgents(which: string): Exclude<Agent, 'manual'>[] {
  const selected = which === 'all' ? AGENTS : AGENTS.filter(a => a === which);
  if (!selected.length) throw new Error(`Unknown agent: ${which}`);
  return selected;
}

const quote = (cli: string) => `"${cli.replaceAll('"', '\\"')}"`;
const hookCommand = (cli: string, ...args: string[]) => `node ${quote(cli)} hook ${args.join(' ')}`;

function hookEntry(agent: Agent, spec: AgentSpec, event: string, matcher: string, cli: string) {
  const command = `${hookCommand(cli, agent)} # ${MARKER}${event}`;
  const match = matcher ? { matcher } : {};
  if (spec.layout === 'flat') return { command, timeout: spec.timeout, ...match };
  return { ...match, hooks: [{ type: 'command', command, name: `${MARKER}${event}`, timeout: spec.timeout }] };
}

/**
 * Antigravity payloads do not name their event, so the event is passed as an argument.
 * Tool events use `{ matcher, hooks }` groups; the others list handlers directly.
 * On Windows Antigravity splits the command on spaces without a shell and passes quotes through,
 * so the CLI path is quoted only when it contains whitespace.
 */
function namedHooks(agent: Agent, spec: AgentSpec, cli: string) {
  const hooks: Record<string, unknown> = { enabled: true };
  const cliArg = /\s/.test(cli) ? quote(cli) : cli;
  for (const [event, matcher] of Object.entries(spec.events)) {
    const handler = { type: 'command', command: `node ${cliArg} hook ${agent} ${event}`, timeout: spec.timeout };
    hooks[event] = [event.endsWith('ToolUse') ? { matcher, hooks: [handler] } : handler];
  }
  return hooks;
}

const isTurnback = (hook: any) => String(hook?.name || hook?.command).includes(MARKER);

/** Drop Turnback entries from one event's hook list; groups left empty are dropped too. */
function withoutTurnback(spec: AgentSpec, groups: unknown): any[] {
  if (!Array.isArray(groups)) return [];
  if (spec.layout === 'flat') return groups.filter(g => !isTurnback(g));
  return groups
    .map(g => ({ ...g, hooks: Array.isArray(g?.hooks) ? g.hooks.filter((h: any) => !isTurnback(h)) : [] }))
    .filter(g => g.hooks.length);
}

const mcpServer = (cli: string) => ({ command: 'node', args: [cli, 'mcp'] });

/** OpenCode has no command hooks; a generated plugin forwards its events to `turnback hook opencode`. */
function installOpencode(base: string, project: boolean, cli: string, withMcp: boolean): string[] {
  const plugin = opencodePlugin(base, project);
  mkdirSync(path.dirname(plugin), { recursive: true });
  writeFileSync(plugin, opencodePluginSource(cli, MARKER));
  if (!withMcp) return [plugin];
  const config = opencodeConfig(base, project);
  updateJson(config, c => { (c.mcp ??= {}).turnback = { type: 'local', command: ['node', cli, 'mcp'], enabled: true }; });
  return [plugin, config];
}

function uninstallOpencode(base: string, project: boolean): string[] {
  const touched: string[] = [];
  const plugin = opencodePlugin(base, project);
  if (existsSync(plugin) && readFileSync(plugin, 'utf8').includes(MARKER)) {
    rmSync(plugin);
    touched.push(plugin);
  }
  const config = opencodeConfig(base, project);
  if (existsSync(config)) {
    updateJson(config, c => { delete c.mcp?.turnback; });
    touched.push(config);
  }
  return touched;
}

const opencodeDir = (base: string, project: boolean) =>
  project ? path.join(base, '.opencode') : path.join(process.env.XDG_CONFIG_HOME || path.join(base, '.config'), 'opencode');

const opencodePlugin = (base: string, project: boolean) => path.join(opencodeDir(base, project), 'plugins', 'turnback.js');

/** OpenCode reads `opencode.jsonc` or `opencode.json`; an existing file wins. */
function opencodeConfig(base: string, project: boolean): string {
  const dir = project ? base : opencodeDir(base, project);
  const jsonc = path.join(dir, 'opencode.jsonc');
  return existsSync(jsonc) ? jsonc : path.join(dir, 'opencode.json');
}

function writeToml(file: string, cli: string): void {
  const old = existsSync(file) ? readFileSync(file, 'utf8') : '';
  // Codex starts MCP servers with a minimal environment; TURNBACK_HOME must be forwarded explicitly.
  const block = `# turnback begin\n[mcp_servers.turnback]\ncommand = "node"\nargs = [${JSON.stringify(cli)}, "mcp"]\nenv_vars = ["TURNBACK_HOME"]\n# turnback end\n`;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${old.replace(TOML_BLOCK, '\n').trimEnd()}\n\n${block}`);
}

/** An existing file that cannot be parsed as JSON is never overwritten, so user config is not lost. */
function readJson(file: string): any {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, 'utf8');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Cannot parse ${file} as JSON; fix it or add the Turnback entries manually`);
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function updateJson(file: string, change: (value: any) => void): void {
  const value = readJson(file);
  change(value);
  writeJson(file, value);
}
