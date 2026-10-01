import path from 'node:path';
import { userConfig } from './config.js';
import { turnKey } from './journal.js';
import { hadShell } from './recorder.js';
import { Store } from './store.js';
import type { HookEvent } from './types.js';

export const DEFAULT_WARN_DELETES = 20;
/** File names that usually hold secrets or keys. */
export const SENSITIVE = /^(\.env(?!\.(example|sample|template)$)(\..+)?|id_(rsa|dsa|ecdsa|ed25519)|.+\.(pem|key|p12|pfx|jks|keystore)|credentials(\.json)?|\.npmrc|\.netrc|\.git-credentials)$/i;

/**
 * A one-line warning for a finished turn that deleted many files, changed secrets, or edited other
 * workspaces; undefined when there is nothing to say. Only reads the shadow repo.
 */
export function turnWarning(event: HookEvent, foreignRoots: string[]): string | undefined {
  const config = userConfig();
  if (config.warnings === false) return undefined;
  const store = new Store(event.cwd);
  const turn = store.findTurn(turnKey(event));
  if (!turn?.end) return undefined;

  // Without a shell command, the end snapshot covers only the edited paths (see `endTurn`), so the
  // turn changed nothing else. Too few of them to reach the delete limit and none that looks like a
  // secret means no warning is possible, and the diff (one git process) is skipped.
  const warnDeletes = config.warnDeletes ?? DEFAULT_WARN_DELETES;
  const edited = store.relativePaths(turn.entries.flatMap(e => e.paths ?? []));
  const quiet = !hadShell(turn.entries) && edited.length > 0 && edited.length < warnDeletes
    && !edited.some(p => SENSITIVE.test(path.posix.basename(p)));
  const changes = quiet ? [] : store.repo.diffNameStatus(turn.baseline, turn.end);
  const deleted = changes.filter(c => c.status === 'D').length;
  const secrets = changes.map(c => c.path).filter(p => SENSITIVE.test(path.posix.basename(p)));
  const parts: string[] = [];
  if (deleted >= warnDeletes) parts.push(`deleted ${deleted} files`);
  if (secrets.length) parts.push(`changed ${secrets.slice(0, 3).join(', ')}${secrets.length > 3 ? ` and ${secrets.length - 3} more` : ''}`);
  if (foreignRoots.length) parts.push(`edited files outside this workspace (${foreignRoots.join(', ')})`);
  if (!parts.length) return undefined;
  return `turnback: this turn ${parts.join('; ')}. Review with \`turnback undo --dry-run\` or /turnback:undo.`;
}
