// Prepare an installable local marketplace from the npm package, without changing Codex settings.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this helper with npm run plugin:codex:dev.');

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repo, encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `${command} exited ${result.status}`);
  return result.stdout;
}

const root = mkdtempSync(path.join(tmpdir(), 'turnback-codex-dev-'));
const pack = JSON.parse(run(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', root]))[0];
const plugin = path.join(root, 'turnback');
mkdirSync(plugin);
run('tar', ['-xf', path.join(root, pack.filename), '-C', plugin, '--strip-components=1']);
const catalogDir = path.join(root, '.agents', 'plugins');
mkdirSync(catalogDir, { recursive: true });
writeFileSync(path.join(catalogDir, 'marketplace.json'), JSON.stringify({
  name: 'turnback-dev',
  interface: { displayName: 'Turnback (development)' },
  plugins: [{
    name: 'turnback',
    source: { source: 'local', path: './turnback' },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    category: 'Productivity',
  }],
}, null, 2) + '\n');
console.log(`Local marketplace: ${root}`);
console.log('Add that directory with codex plugin marketplace add, then install turnback@turnback-dev.');
console.log('Keep this directory while testing; see guide/INSTALL.md for hook trust and migration.');
