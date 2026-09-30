import { formatTime } from './format.js';
import type { Store } from './store.js';

export interface TurnStats {
  days: number;
  since: string;
  turns: number;
  byAgent: Record<string, number>;
  created: number;
  modified: number;
  deleted: number;
  deletedByAgent: Record<string, number>;
  commands: number;
  /** Restores and undos, not redos. */
  restores: number;
  restoredFiles: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** What agents did in this workspace during the last `days` days, and what Turnback brought back. */
export function turnStats(store: Store, days = 7, now = Date.now()): TurnStats {
  const cutoff = now - days * DAY_MS;
  const recent = (time: string) => Date.parse(time) >= cutoff && Date.parse(time) <= now;
  const stats: TurnStats = {
    days, since: new Date(cutoff).toISOString(), turns: 0, byAgent: {},
    created: 0, modified: 0, deleted: 0, deletedByAgent: {}, commands: 0, restores: 0, restoredFiles: 0,
  };
  for (const turn of store.turns()) {
    if (!recent(turn.time)) continue;
    stats.turns++;
    stats.byAgent[turn.agent] = (stats.byAgent[turn.agent] ?? 0) + 1;
    stats.commands += store.steps(turn.id).filter(s => s.kind === 'shell').length;
    if (!turn.end) continue;
    for (const change of store.repo.diffNameStatus(turn.baseline, turn.end)) {
      if (change.status === 'A') stats.created++;
      else if (change.status === 'D') {
        stats.deleted++;
        stats.deletedByAgent[turn.agent] = (stats.deletedByAgent[turn.agent] ?? 0) + 1;
      }
      else stats.modified++;
    }
  }
  for (const e of store.entries()) {
    if ((e.kind === 'restore' || e.kind === 'undo') && e.paths && recent(e.time)) {
      stats.restores++;
      stats.restoredFiles += e.paths.length;
    }
  }
  return stats;
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const agents = (s: TurnStats) => Object.entries(s.byAgent).sort((a, b) => b[1] - a[1]).map(([a, n]) => `${a} ${n}`).join(', ');

export function formatStats(s: TurnStats): string {
  const rows: [string, string][] = [
    ['Turns', s.turns ? `${s.turns}  (${agents(s)})` : '0'],
    ['Files', `created ${s.created}, changed ${s.modified}, deleted ${s.deleted}`],
    ['Commands', count(s.commands, 'shell command')],
    ['Restores', `${s.restores}, bringing back ${count(s.restoredFiles, 'file')}`],
  ];
  return [`Last ${count(s.days, 'day')} in this workspace (since ${formatTime(s.since)})`, ...rows.map(([k, v]) => `${k.padEnd(13)}${v}`)].join('\n');
}

/** Font size that keeps monospace text within 1040px (a character is about 0.6em wide). */
const fit = (text: string, max: number) => Math.min(max, Math.floor(1040 / (text.length * 0.6)));
const xml = (text: string) => text.replace(/[<>&"']/g, c => `&#${c.charCodeAt(0)};`);

/** A 1200×630 card for sharing, with no external resources. */
export function statsCard(s: TurnStats): string {
  const period = s.days === 7 ? 'this week' : `in the last ${count(s.days, 'day')}`;
  // `turnback run` turns are commands the user ran, not an agent's work.
  const who = s.turns && Object.keys(s.byAgent).every(a => a === 'manual') ? 'Commands' : 'Agents';
  const agentDeleted = s.deletedByAgent
    ? Object.entries(s.deletedByAgent).filter(([a]) => a !== 'manual').reduce((sum, [, n]) => sum + n, 0)
    : s.deleted;
  const deletedCount = who === 'Commands' ? (s.deletedByAgent?.manual ?? s.deleted) : agentDeleted;
  const headline = `${who} deleted ${count(deletedCount, 'file')} ${period}.`;
  const saved = s.restoredFiles ? `Turnback brought back ${count(s.restoredFiles, 'file')}.` : 'Nothing needed undoing.';
  const detail = `${count(s.turns, 'turn')} (${agents(s) || 'no agents'}) · ${s.created} created · ${s.modified} changed · ${count(s.commands, 'shell command')}`;
  const font = `font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<rect width="1200" height="630" fill="#16181d"/>
<text x="80" y="130" ${font} font-size="40" fill="#7ec88e">turnback stats</text>
<text x="80" y="260" ${font} font-size="${fit(headline, 48)}" fill="#ec6e6e">${xml(headline)}</text>
<text x="80" y="340" ${font} font-size="${fit(saved, 42)}" fill="#d8dce4">${xml(saved)}</text>
<text x="80" y="440" ${font} font-size="${fit(detail, 24)}" fill="#78808e">${xml(detail)}</text>
<text x="80" y="560" ${font} font-size="26" fill="#7ab2f7">github.com/MFaizR77/turnback · undo for AI coding agents</text>
</svg>
`;
}
