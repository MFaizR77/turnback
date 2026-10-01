import { spawnSync } from 'node:child_process';
import { formatTime } from './format.js';
import type { NameStatus } from '../git/shadow.js';
import type { Store } from './store.js';
import type { Turn } from './types.js';
import { SENSITIVE } from './warnings.js';

const STATUS = { A: 'added', M: 'modified', D: 'deleted', T: 'type changed' } as const;
/** Same limit as `turnback ui`, per turn. */
const MAX_DIFF_CHARS = 400_000;

/** Session part of a turn ID (`agent:session:turn`). */
export const sessionOf = (turnId: string) => turnId.split(':').slice(1, -1).join(':');

const code = (text: string) => '`' + text.replaceAll('`', "'") + '`';

interface ReportTurn {
  turn: Turn;
  prompt?: string;
  changes: NameStatus[];
  commands: string[];
}

/** The latest session (or `session`), oldest turn first; `undefined` when nothing is recorded yet. */
function sessionTurns(store: Store, session?: string): { id: string; turns: ReportTurn[] } | undefined {
  const all = store.turns();
  if (!all.length && !session) return undefined;
  const id = session ?? sessionOf(all[0].id);
  const turns = all.filter(t => sessionOf(t.id) === id).reverse();
  if (!turns.length) throw new Error(`No turns in session ${id}`);
  return {
    id,
    turns: turns.map(turn => ({
      turn,
      prompt: store.summarize(turn, []).prompt,
      changes: turn.end ? store.repo.diffNameStatus(turn.baseline, turn.end) : [],
      commands: store.steps(turn.id).flatMap(s => s.command ? [s.command] : []),
    })),
  };
}

const files = (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`;
const span = (turns: ReportTurn[]) => `${formatTime(turns[0].turn.time)} to ${formatTime(turns.at(-1)!.turn.time)}`;

/** Markdown report of one session's turns, oldest first: prompt, commands, and changed files. */
export function sessionReport(store: Store, session?: string): string {
  const report = sessionTurns(store, session);
  if (!report) return 'No turns recorded yet.';
  const { id, turns } = report;
  const lines = [
    `# Turnback report · ${store.root}`,
    '',
    `Session ${code(id)} · ${turns.length} ${turns.length === 1 ? 'turn' : 'turns'} · ${span(turns)}`,
  ];
  turns.forEach(({ turn, prompt, changes, commands }, i) => {
    lines.push('', `## ${i + 1}. ${prompt ?? '(no prompt)'}`, '');
    lines.push(`- ${turn.agent} · ${formatTime(turn.time)} · ${files(changes.length)}${turn.status === 'ok' ? '' : ' · partial'}`);
    lines.push(`- Turn: ${code(turn.id)}`);
    if (commands.length) lines.push(`- Commands: ${commands.map(code).join(', ')}`);
    if (changes.length) lines.push(`- Files: ${changes.map(c => `${code(c.path)} (${STATUS[c.status]})`).join(', ')}`);
  });
  return lines.join('\n') + '\n';
}

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (text: string) => text.replace(/[&<>"']/g, c => ENTITIES[c]);

const isSecret = (p: string) => SENSITIVE.test(p.split('/').at(-1)!);

/** One `<span>` per diff line, colored by its first character. */
function diffHtml(diff: string): string {
  return diff.split('\n').map(line => {
    const cls = line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') ? 'meta'
      : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('@@') ? 'hunk' : '';
    return cls ? `<span class="${cls}">${esc(line)}</span>` : esc(line);
  }).join('\n');
}

/** Self-contained HTML report of one session: the markdown report's content plus each turn's diff. */
export function htmlReport(store: Store, session?: string, maxDiff = MAX_DIFF_CHARS): string {
  const report = sessionTurns(store, session);
  if (!report) throw new Error('No turns recorded yet.');
  const { id, turns } = report;
  const sections = turns.map(({ turn, prompt, changes, commands }, i) => {
    // The page is meant to be shared: never include the contents of files that usually hold secrets.
    const shareable = changes.map(c => c.path).filter(p => !isSecret(p));
    const diff = turn.end && shareable.length ? store.repo.diffPatch(turn.baseline, turn.end, shareable) : '';
    const cut = diff.length > maxDiff;
    return `<section>
<h2>${i + 1}. ${esc(prompt ?? '(no prompt)')}</h2>
<p class="meta">${esc(turn.agent)} · ${esc(formatTime(turn.time))} · ${files(changes.length)}${turn.status === 'ok' ? '' : ' · partial'} · <code>${esc(turn.id)}</code></p>
${commands.length ? `<p>Commands: ${commands.map(c => `<code>${esc(c)}</code>`).join(' ')}</p>` : ''}
${changes.length ? `<ul>${changes.map(c => `<li><code>${esc(c.path)}</code> <span class="${c.status}">${STATUS[c.status]}</span>${isSecret(c.path) ? ' (content hidden)' : ''}</li>`).join('')}</ul>` : ''}
${diff ? `<details><summary>Diff</summary><pre>${diffHtml(diff.slice(0, maxDiff))}</pre>${cut ? `<p class="meta">Diff cut at ${maxDiff} characters; see <code>turnback diff ${esc(turn.id)}</code>.</p>` : ''}</details>` : ''}
</section>`;
  });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Turnback report · ${esc(id)}</title>
<style>
:root { color-scheme: light dark; --bg: #fff; --fg: #1f2328; --dim: #656d76; --line: #d0d7de; --add: #1a7f37; --del: #cf222e; --hunk: #8250df; --code: #f6f8fa; }
@media (prefers-color-scheme: dark) { :root { --bg: #0d1117; --fg: #e6edf3; --dim: #8d96a0; --line: #30363d; --add: #3fb950; --del: #f85149; --hunk: #bc8cff; --code: #161b22; } }
body { background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; max-width: 960px; margin: 0 auto; padding: 24px 16px; }
h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 17px; margin: 0 0 4px; overflow-wrap: anywhere; }
section { border-top: 1px solid var(--line); padding: 16px 0; }
.meta { color: var(--dim); font-size: 13px; }
code, pre { font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--code); border-radius: 4px; }
code { padding: 1px 4px; overflow-wrap: anywhere; }
pre { padding: 12px; overflow-x: auto; }
.add, .A { color: var(--add); } .del, .D { color: var(--del); } .hunk { color: var(--hunk); } pre .meta { font-weight: 600; }
summary { cursor: pointer; color: var(--dim); }
</style>
</head>
<body>
<h1>Turnback report</h1>
<p class="meta"><code>${esc(store.root)}</code> · session <code>${esc(id)}</code> · ${turns.length} ${turns.length === 1 ? 'turn' : 'turns'} · ${esc(span(turns))}</p>
${sections.join('\n')}
</body>
</html>
`;
}

export const PR_START = '<!-- turnback:start -->';
export const PR_END = '<!-- turnback:end -->';
const PROMPT_CHARS = 120;

/** Run git in the user's repository (read-only commands only). */
function userGit(root: string, args: string[]): string {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args[0]}: ${(r.stderr || '').trim() || 'failed'}`);
  return r.stdout;
}

/** One line for a markdown table cell: whitespace collapsed, `|` escaped, at most 120 characters. */
function cell(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const short = flat.length > PROMPT_CHARS ? flat.slice(0, PROMPT_CHARS - 1) + '…' : flat;
  return short.replaceAll('|', '\|');
}

/**
 * Markdown section for a pull request description: each turn since the branch left `base` that
 * changed files the branch changes, with its agent, time, prompt, and those files.
 */
export function prReport(store: Store, base: string): string {
  const files = new Set(userGit(store.root, ['diff', '--name-only', '--no-renames', '--relative', `${base}...HEAD`]).split('\n').filter(Boolean));
  const forkPoint = userGit(store.root, ['merge-base', base, 'HEAD']).trim();
  const since = Number(userGit(store.root, ['log', '-1', '--format=%ct', forkPoint]).trim()) * 1000;
  const rows = store.turns().reverse().flatMap(turn => {
    if (!turn.end || Date.parse(turn.time) < since) return [];
    const touched = store.repo.diffNameStatus(turn.baseline, turn.end).map(c => c.path).filter(p => files.has(p));
    return touched.length ? [{ turn, touched }] : [];
  });
  const lines = [PR_START, '### AI provenance', ''];
  if (!rows.length) lines.push('No recorded agent turn changed the files in this pull request.');
  else {
    lines.push('| # | Agent | When | Prompt | Files in this PR |', '|---|---|---|---|---|');
    rows.forEach(({ turn, touched }, i) => {
      const prompt = store.summarize(turn, []).prompt;
      lines.push(`| ${i + 1} | ${turn.agent} | ${formatTime(turn.time)} | ${prompt ? cell(prompt) : '(no prompt)'} | ${touched.map(code).join(', ')} |`);
    });
  }
  lines.push('', '<sub>Recorded by [Turnback](https://github.com/MFaizR77/turnback): each row is an agent turn that changed files in this pull request.</sub>', PR_END);
  return lines.join('\n') + '\n';
}

/** `body` with its provenance section replaced by `section`, or with `section` added at the end. */
export function withPrSection(body: string, section: string): string {
  const start = body.indexOf(PR_START);
  const end = body.indexOf(PR_END, start);
  if (start >= 0 && end >= 0) return body.slice(0, start) + section.trimEnd() + body.slice(end + PR_END.length);
  return body.trim() ? `${body.trimEnd()}\n\n${section}` : section;
}
