import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { Store } from '../src/core/store.js';
import { startUi, type UiServer } from '../src/ui/server.js';
import { CLI, hook, tempProject } from './helpers.js';

let p: ReturnType<typeof tempProject>;
let ui: UiServer;

beforeEach(async () => {
  p = tempProject('turnback-ui-');
  p.write('a.txt', 'old\n');
  hook(p.root, 'turn-start', 't', { prompt: 'edit a' });
  hook(p.root, 'edit', 't', { paths: [p.file('a.txt')] });
  p.write('a.txt', 'new\n');
  hook(p.root, 'turn-end', 't');
  ui = await startUi(new Store(p.root));
});
afterEach(() => ui.close());

const get = (rel: string) => fetch(new URL(rel, ui.url));

/** Raw request with a chosen Host header, which fetch does not allow overriding. */
function rawStatus(method: string, host: string): Promise<number> {
  const url = new URL(ui.url);
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: url.port, path: url.pathname + 'api/turns', method, headers: { host } }, res => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

it('serves a self-contained page on 127.0.0.1 behind a token', async () => {
  expect(ui.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/$/);
  const page = await get('');
  expect(page.headers.get('content-type')).toContain('text/html');
  const html = await page.text();
  expect(html).toContain('<title>Turnback</title>');
  expect(html).not.toMatch(/(src|href)="https?:/);
});

it('serves turns, steps, and diffs as JSON', async () => {
  const data = await (await get('api/turns')).json();
  expect(data.turns).toHaveLength(1);
  expect(data.turns[0].prompt).toBe('edit a');
  const id = encodeURIComponent(data.turns[0].id);
  expect((await (await get(`api/turns/${id}/steps`)).json()).steps).toHaveLength(1);
  const diff = await (await get(`api/turns/${id}/diff`)).json();
  expect(diff.diff).toContain('+new');
  expect(diff.truncated).toBe(false);
  expect((await get('api/turns/nope/diff')).status).toBe(404);
});

it('rejects requests without the token, from other hosts, or that write', async () => {
  const origin = new URL(ui.url).origin;
  expect((await fetch(origin + '/api/turns')).status).toBe(404);
  const port = new URL(ui.url).port;
  expect(await rawStatus('GET', `evil.example:${port}`)).toBe(403);
  expect(await rawStatus('POST', `127.0.0.1:${port}`)).toBe(405);
  expect(await rawStatus('GET', `localhost:${port}`)).toBe(200);
});

it('never inserts data as HTML', async () => {
  const html = await (await get('')).text();
  expect(html).not.toContain('innerHTML');
  expect(html).toContain('api/turns');
});

it.each([[], ['--port', '0']])('starts from the CLI and prints its URL with port options %j', async (...port) => {
  const child = spawn(process.execPath, [CLI, 'ui', '--no-open', ...port], { cwd: p.root, env: { ...process.env, TURNBACK_HOME: p.home }, windowsHide: true });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let out = '';
      child.stdout.on('data', chunk => {
        out += chunk;
        const m = /http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\//.exec(out);
        if (m) resolve(m[0]);
      });
      child.on('exit', code => reject(new Error(`ui exited with ${code}: ${out}`)));
    });
    const data = await (await fetch(new URL('api/turns', url))).json();
    expect(data.turns[0].prompt).toBe('edit a');
  } finally {
    child.kill();
  }
}, 30_000);
