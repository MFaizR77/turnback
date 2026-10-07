import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';

export const codexConfigDir = () => process.env.CODEX_HOME || path.join(homedir(), '.codex');

/** Project plugin settings override user settings, including an explicit disable. */
export function codexPluginEnabled(root: string): boolean {
  const enabled = new Map<string, boolean>();
  const files = new Set([path.join(codexConfigDir(), 'config.toml'), path.join(root, '.codex', 'config.toml')]);
  for (const file of files) {
    if (!existsSync(file)) continue;
    let config;
    try { config = parse(readFileSync(file, 'utf8')); }
    catch { throw new Error(`Cannot parse ${file} as TOML; fix it before installing Turnback`); }
    const plugins = config.plugins;
    if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins) || plugins instanceof Date) continue;
    for (const [id, settings] of Object.entries(plugins)) {
      if (!id.startsWith('turnback@') || !settings || typeof settings !== 'object' || Array.isArray(settings)) continue;
      if ('enabled' in settings && typeof settings.enabled === 'boolean') enabled.set(id, settings.enabled);
    }
  }
  return [...enabled.values()].some(Boolean);
}
