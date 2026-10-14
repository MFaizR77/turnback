import { BARE_SAFE, QUOTE_SAFE } from '../core/quote.js';

/**
 * The single page of `turnback ui`: turn list on the left, the selected turn's steps and diff on the right.
 * Data is always inserted with textContent. String.raw keeps the page's own backslashes; the page script
 * uses no template literals, so the only interpolations are the shared quoting rules from quote.ts.
 */
export const UI_PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Turnback</title>
<link rel="icon" href="data:,">
<style>
:root {
  --bg: #f7f6f3; --panel: #ffffff; --ink: #1d1c1a; --muted: #6d6a64; --line: #e4e1db;
  --accent: #b45309; --accent-soft: #fbf1e4; --code: #f1efeb;
  --add: #0f5f26; --add-bg: #e6f5eb; --del: #a1122a; --del-bg: #fcebed;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #131211; --panel: #1b1a18; --ink: #ebe9e5; --muted: #a09c94; --line: #2d2b28;
    --accent: #f59e0b; --accent-soft: #2a2114; --code: #23211e;
    --add: #86e0a4; --add-bg: #11261a; --del: #ff9eaa; --del-bg: #2c141a;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
code, pre, .mono { font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; font-size: 12.5px; }
button { font: inherit; color: inherit; }
header { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 14px; height: 52px; padding: 0 20px; background: var(--panel); border-bottom: 1px solid var(--line); }
.brand { font-weight: 700; font-size: 16px; letter-spacing: -0.01em; white-space: nowrap; }
.brand span { color: var(--accent); }
.ws { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); }
.ghost { border: 1px solid var(--line); background: transparent; border-radius: 6px; padding: 4px 10px; cursor: pointer; }
.ghost:hover { border-color: var(--muted); }
main { display: grid; grid-template-columns: minmax(280px, 380px) 1fr; }
aside { position: sticky; top: 52px; height: calc(100vh - 52px); overflow: auto; border-right: 1px solid var(--line); background: var(--panel); }
.section-title { margin: 0; padding: 14px 16px 6px; font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
.turn { display: block; width: 100%; text-align: left; padding: 10px 16px; border: 0; border-left: 3px solid transparent; border-bottom: 1px solid var(--line); background: transparent; cursor: pointer; }
.turn:hover { background: var(--bg); }
.turn[aria-pressed="true"] { background: var(--accent-soft); border-left-color: var(--accent); }
.meta { display: flex; flex-wrap: wrap; gap: 4px 10px; color: var(--muted); font-size: 12px; }
.num { font-weight: 600; color: var(--ink); }
.badge { padding: 0 6px; border-radius: 4px; background: var(--del-bg); color: var(--del); font-size: 11px; }
.prompt { margin-top: 2px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.none { color: var(--muted); font-style: italic; }
.mark { padding: 10px 16px; border-bottom: 1px solid var(--line); }
.empty { padding: 16px; color: var(--muted); }
#detail { min-width: 0; padding: 24px 32px 64px; }
h2 { margin: 0 0 6px; font-size: 20px; line-height: 1.35; letter-spacing: -0.01em; overflow-wrap: anywhere; }
h3 { margin: 28px 0 10px; font-size: 13px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); }
.hint { margin: -4px 0 10px; color: var(--muted); font-size: 13px; }
.cmd { display: flex; align-items: center; gap: 8px; margin: 6px 0; max-width: 100%; }
.cmd code { flex: 1; min-width: 0; padding: 6px 10px; border-radius: 6px; background: var(--code); overflow-x: auto; white-space: nowrap; }
.copy { flex: none; border: 1px solid var(--line); background: var(--panel); border-radius: 6px; padding: 4px 10px; cursor: pointer; font-size: 12px; }
.copy:hover { border-color: var(--accent); color: var(--accent); }
ol.steps { list-style: none; margin: 0; padding: 0; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
ol.steps li { padding: 10px 14px; border-bottom: 1px solid var(--line); }
ol.steps li:last-child { border-bottom: 0; }
.step-head { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
.kind { padding: 0 6px; border-radius: 4px; background: var(--code); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
.kind.shell { background: var(--accent-soft); color: var(--accent); }
.step-detail { flex: 1 1 100%; max-height: 7.5em; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
pre.diff { margin: 0; padding: 12px 0; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); overflow: auto; line-height: 1.45; }
pre.diff span { display: block; padding: 0 14px; white-space: pre; }
.l-add { background: var(--add-bg); color: var(--add); }
.l-del { background: var(--del-bg); color: var(--del); }
.l-hunk { color: var(--muted); }
.l-file { margin-top: 10px; font-weight: 700; }
.notice { padding: 8px 12px; border-radius: 6px; background: var(--accent-soft); color: var(--accent); }
.error { color: var(--del); }
@media (max-width: 800px) {
  main { grid-template-columns: 1fr; }
  aside { position: static; height: auto; max-height: 45vh; border-right: 0; border-bottom: 1px solid var(--line); }
  #detail { padding: 20px 16px 48px; }
}
</style>
</head>
<body>
<header>
  <div class="brand">Turn<span>back</span></div>
  <div class="ws mono" id="workspace"></div>
  <button class="ghost" id="refresh" type="button">Refresh</button>
</header>
<main>
  <aside>
    <h2 class="section-title">Turns</h2>
    <div id="turns"><p class="empty">Loading…</p></div>
    <div id="marks-section" hidden>
      <h2 class="section-title">Marks</h2>
      <div id="marks"></div>
    </div>
  </aside>
  <section id="detail"><p class="empty">Select a turn to see its steps and changes.</p></section>
</main>
<script>
(function () {
  'use strict';
  var state = { turns: [], marks: [], selected: null, buttons: {} };

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }
  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function when(iso) {
    var d = new Date(iso);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function clock(iso) {
    var d = new Date(iso);
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function files(n) { return n + (n === 1 ? ' file' : ' files'); }
  // Same rules as shellArg in quote.ts: a bare word, a double-quoted literal, or nothing.
  function quote(s) {
    if (/${BARE_SAFE.source}/.test(s)) return s;
    if (/${QUOTE_SAFE.source}/u.test(s)) return '"' + s + '"';
    return null;
  }
  function line(before, arg, after) {
    if (arg === null) return null;
    return after ? before + ' ' + arg + ' ' + after : before + ' ' + arg;
  }
  function getJson(url) {
    return fetch(url, { cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
      return res.json();
    });
  }

  function selectText(node) {
    var range = document.createRange();
    range.selectNodeContents(node);
    var selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
  function command(text) {
    if (text === null) return el('p', 'hint', 'This name has characters that are unsafe to paste into a shell. Use the CLI with turnback list --json instead.');
    var row = el('div', 'cmd');
    var code = el('code', null, text);
    var button = el('button', 'copy', 'Copy');
    button.type = 'button';
    button.addEventListener('click', function () {
      var done = function () {
        button.textContent = 'Copied';
        setTimeout(function () { button.textContent = 'Copy'; }, 1200);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { selectText(code); });
      } else {
        selectText(code);
      }
    });
    row.appendChild(code);
    row.appendChild(button);
    return row;
  }

  function renderList() {
    var list = document.getElementById('turns');
    list.replaceChildren();
    state.buttons = {};
    if (!state.turns.length) {
      list.appendChild(el('p', 'empty', 'No turns recorded yet. A turn appears here after an agent edits a file or runs a shell command.'));
    }
    state.turns.forEach(function (t, i) {
      var button = el('button', 'turn');
      button.type = 'button';
      button.setAttribute('aria-pressed', String(state.selected === t.id));
      var meta = el('div', 'meta');
      meta.appendChild(el('span', 'num', '#' + (i + 1)));
      meta.appendChild(el('span', null, when(t.time)));
      meta.appendChild(el('span', null, t.agent));
      meta.appendChild(el('span', null, files(t.changedFiles)));
      if (t.status !== 'ok') meta.appendChild(el('span', 'badge', 'partial'));
      button.appendChild(meta);
      button.appendChild(el('div', t.prompt ? 'prompt' : 'prompt none', t.prompt || '(no prompt)'));
      button.addEventListener('click', function () { showTurn(t.id); });
      state.buttons[t.id] = button;
      list.appendChild(button);
    });

    var marks = document.getElementById('marks');
    marks.replaceChildren();
    document.getElementById('marks-section').hidden = !state.marks.length;
    state.marks.forEach(function (m) {
      var item = el('div', 'mark');
      item.appendChild(el('div', 'meta', when(m.time)));
      item.appendChild(el('div', 'prompt', m.label));
      item.appendChild(command(line('turnback restore', quote(m.label), '--dry-run')));
      marks.appendChild(item);
    });
  }

  function renderSteps(container, turn, steps) {
    container.replaceChildren();
    if (!steps.length) {
      container.appendChild(el('p', 'empty', 'No edit or shell steps in this turn.'));
      return;
    }
    var list = el('ol', 'steps');
    steps.forEach(function (s) {
      var item = el('li');
      var head = el('div', 'step-head');
      head.appendChild(el('span', 'num', s.n + '.'));
      head.appendChild(el('span', 'meta', clock(s.time)));
      head.appendChild(el('span', 'kind ' + s.kind, s.kind));
      var detail = s.kind === 'shell' ? (s.command || '') : (s.paths || []).join(', ');
      head.appendChild(el('code', 'step-detail', detail));
      item.appendChild(head);
      if (s.ref) item.appendChild(command(line('turnback restore', quote(turn.id), '--before-step ' + s.n + ' --dry-run')));
      else item.appendChild(el('div', 'hint', 'No snapshot (' + s.status + '); this step cannot be restored.'));
      list.appendChild(item);
    });
    container.appendChild(list);
  }

  function lineClass(line) {
    if (line.indexOf('diff --git') === 0) return 'l-file';
    if (line.indexOf('+++') === 0 || line.indexOf('---') === 0 || line.indexOf('@@') === 0) return 'l-hunk';
    if (line.charAt(0) === '+') return 'l-add';
    if (line.charAt(0) === '-') return 'l-del';
    return '';
  }
  function renderDiff(container, turn, data) {
    container.replaceChildren();
    if (!data.diff) {
      container.appendChild(el('p', 'empty', 'No file changes recorded for this turn.'));
      return;
    }
    if (data.truncated) {
      container.appendChild(el('p', 'notice', 'This diff is too large to show in full. Run the command below for the whole patch.'));
      container.appendChild(command(line('turnback diff', quote(turn.id), '')));
    }
    var pre = el('pre', 'diff');
    data.diff.split('\n').forEach(function (line) { pre.appendChild(el('span', lineClass(line), line)); });
    container.appendChild(pre);
  }

  function showTurn(id) {
    var turn = state.turns.filter(function (t) { return t.id === id; })[0];
    if (!turn) return;
    state.selected = id;
    Object.keys(state.buttons).forEach(function (key) { state.buttons[key].setAttribute('aria-pressed', String(key === id)); });

    var detail = document.getElementById('detail');
    detail.replaceChildren();
    detail.appendChild(el('h2', turn.prompt ? null : 'none', turn.prompt || '(no prompt)'));
    var meta = el('div', 'meta');
    [when(turn.time), turn.agent, files(turn.changedFiles), turn.status === 'ok' ? 'complete' : 'partial'].forEach(function (text) { meta.appendChild(el('span', null, text)); });
    detail.appendChild(meta);

    detail.appendChild(el('h3', null, 'Undo this turn'));
    detail.appendChild(el('p', 'hint', 'Preview first; add --yes to apply. The UI never changes files itself.'));
    detail.appendChild(command(line('turnback restore', quote(turn.id), '--dry-run')));

    detail.appendChild(el('h3', null, 'Steps'));
    detail.appendChild(el('p', 'hint', 'Restoring to just before a step keeps the work of the steps above it.'));
    var steps = el('div', null);
    steps.appendChild(el('p', 'empty', 'Loading…'));
    detail.appendChild(steps);

    detail.appendChild(el('h3', null, 'Changes'));
    var diff = el('div', null);
    diff.appendChild(el('p', 'empty', 'Loading…'));
    detail.appendChild(diff);

    var base = 'api/turns/' + encodeURIComponent(id);
    getJson(base + '/steps').then(function (data) {
      if (state.selected === id) renderSteps(steps, turn, data.steps);
    }, function (e) { steps.replaceChildren(el('p', 'error', 'Could not load steps: ' + e.message)); });
    getJson(base + '/diff').then(function (data) {
      if (state.selected === id) renderDiff(diff, turn, data);
    }, function (e) { diff.replaceChildren(el('p', 'error', 'Could not load changes: ' + e.message)); });
  }

  function load() {
    getJson('api/turns').then(function (data) {
      state.turns = data.turns;
      state.marks = data.marks;
      document.getElementById('workspace').textContent = data.workspace;
      document.title = 'Turnback · ' + data.workspace.split(/[\\/]/).pop();
      renderList();
      var keep = state.turns.some(function (t) { return t.id === state.selected; });
      if (keep) showTurn(state.selected);
      else if (state.turns.length) showTurn(state.turns[0].id);
    }, function (e) {
      document.getElementById('turns').replaceChildren(el('p', 'empty error', 'Could not load turns: ' + e.message + '. Is turnback ui still running?'));
    });
  }

  document.getElementById('refresh').addEventListener('click', load);
  load();
})();
</script>
</body>
</html>
`;
