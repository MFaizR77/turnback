import path from 'node:path';
import { userConfig } from './config.js';
import { turnKey } from './journal.js';
import { hadShell, STILL_WARMING } from './recorder.js';
import { Store } from './store.js';
import type { Entry, HookEvent, Turn } from './types.js';

export const DEFAULT_WARN_DELETES = 20;
/** File names that usually hold secrets or keys. */
export const SENSITIVE = /^(\.env(?!\.(example|sample|template)$)(\..+)?|id_(rsa|dsa|ecdsa|ed25519)|.+\.(pem|key|p12|pfx|jks|keystore)|credentials(\.json)?|\.npmrc|\.netrc|\.git-credentials)$/i;

/**
 * A one-line warning for a finished turn that deleted many files, changed secrets, edited other
 * workspaces, or could not be saved; undefined when there is nothing to say. Only reads the shadow repo.
 */
export function turnWarning(event: HookEvent, foreignRoots: string[]): string | undefined {
  const config = userConfig();
  if (config.warnings === false) return undefined;
  const store = new Store(event.cwd);
  const turn = store.findTurn(turnKey(event));
  if (!turn) return unsavedWarning(store, event);
  if (!turn.end) return undefined;

  const warnDeletes = config.warnDeletes ?? DEFAULT_WARN_DELETES;
  const changes = mayWarn(store, turn, warnDeletes) ? store.repo.diffNameStatus(turn.baseline, turn.end) : [];
  const deleted = changes.filter(c => c.status === 'D').length;
  const secrets = changes.map(c => c.path).filter(isSensitive);
  const parts: string[] = [];
  if (deleted >= warnDeletes) parts.push(`deleted ${deleted} files`);
  if (secrets.length) parts.push(`changed ${secrets.slice(0, 3).join(', ')}${secrets.length > 3 ? ` and ${secrets.length - 3} more` : ''}`);
  if (foreignRoots.length) parts.push(`edited files outside this workspace (${foreignRoots.join(', ')})`);
  if (!parts.length) return undefined;
  return `turnback: this turn ${parts.join('; ')}. Review with \`turnback undo --dry-run\` or /turnback:undo.`;
}

const isSensitive = (rel: string) => SENSITIVE.test(path.posix.basename(rel));

/**
 * Without a shell command a turn changes only its edited paths (see `endTurn`). Too few of them to
 * reach the delete limit and none that looks like a secret means no warning, so the diff is skipped.
 */
function mayWarn(store: Store, turn: Turn, warnDeletes: number): boolean {
  if (hadShell(turn.entries)) return true;
  const edited = store.relativePaths(turn.entries.flatMap(e => e.paths ?? []));
  return !edited.length || edited.length >= warnDeletes || edited.some(isSensitive);
}

/**
 * A turn that changed files without a baseline cannot be undone; without this warning the user finds
 * out only when an undo fails. Steps that edits-only mode leaves unprotected by design are not a reason.
 */
function unsavedWarning(store: Store, event: HookEvent): string | undefined {
  const reason = unsavedReason(store.entries().filter(e => turnKey(e) === turnKey(event)));
  if (!reason) return undefined;
  return `turnback: this turn's changes could not be saved, so it cannot be undone (${reason}). Run \`turnback status\` for details.`;
}

function unsavedReason(entries: Entry[]): string | undefined {
  const failed = entries.find(e => e.kind === 'baseline' && e.status !== 'ok');
  if (failed) return (failed.note ?? failed.status).split('\n')[0].slice(0, 160);
  if (entries.some(e => e.note === STILL_WARMING)) return 'the first snapshot of this workspace was still being written';
  return undefined;
}
