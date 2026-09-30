import { mkdirSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { applyHunks, blameFile } from '../src/core/blame.js';
import { applyRestore, undoTarget } from '../src/core/restore.js';
import { Store } from '../src/core/store.js';
import { hook, tempProject } from './helpers.js';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

type P = ReturnType<typeof tempProject>;

/** One finished Codex turn that writes `content` to `rel` through an edit tool. */
function editTurn(p: P, turn: string, rel: string, content: string) {
  hook(p.root, 'turn-start', turn);
  hook(p.root, 'edit', turn, { paths: [p.file(rel)] });
  p.write(rel, content);
  hook(p.root, 'turn-end', turn);
}

const sources = (p: P, rel: string) => blameFile(new Store(p.root), p.file(rel)).map(l => l.turn ? l.turn.id.split(':').at(-1) : l.source);

it('carries labels through hunks', () => {
  expect(applyHunks(['a', 'b', 'c'], [{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 2 }], 'x')).toEqual(['x', 'x', 'b', 'c']);
  expect(applyHunks(['a', 'b'], [{ oldStart: 1, oldCount: 0, newStart: 2, newCount: 1 }], 'x')).toEqual(['a', 'x', 'b']);
  expect(applyHunks(['a', 'b'], [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 1 }], 'x')).toEqual(['x', 'a', 'b']);
  expect(applyHunks(['a', 'b', 'c'], [{ oldStart: 2, oldCount: 2, newStart: 1, newCount: 0 }], 'x')).toEqual(['a']);
});

it('labels lines by turn, before Turnback, and outside a turn', () => {
  const p = tempProject('turnback-blame-');
  p.write('f.txt', 'one\ntwo\nthree\nfour\n');
  editTurn(p, 't1', 'f.txt', 'one\nnew\ntwo\nthree\nfour\n');
  p.write('f.txt', 'one\nnew\ntwo\nTHREE\nfour\n');
  editTurn(p, 't2', 'f.txt', 'ONE\nnew\ntwo\nTHREE\nfour\n');
  expect(sources(p, 'f.txt')).toEqual(['t2', 't1', 'before', 'outside', 'before']);
  const lines = blameFile(new Store(p.root), p.file('f.txt'));
  expect(lines[0]).toMatchObject({ line: 1, text: 'ONE', source: 'turn' });
});

it('gives every line of a file created by a turn to that turn', () => {
  const p = tempProject('turnback-blame-new-');
  mkdirSync(p.file('app/[slug]'), { recursive: true });
  p.write('keep.txt', 'k');
  editTurn(p, 't1', 'app/[slug]/page.tsx', 'a\nb\n');
  expect(sources(p, 'app/[slug]/page.tsx')).toEqual(['t1', 't1']);
});

it('gives a line removed and written again to the later turn', () => {
  const p = tempProject('turnback-blame-again-');
  p.write('f.txt', 'a\nb\nc\n');
  editTurn(p, 't1', 'f.txt', 'a\nc\n');
  editTurn(p, 't2', 'f.txt', 'a\nb\nc\n');
  expect(sources(p, 'f.txt')).toEqual(['before', 't2', 'before']);
});

it('ignores a change of line endings alone', () => {
  const p = tempProject('turnback-blame-crlf-');
  p.write('f.txt', 'a\n');
  editTurn(p, 't1', 'f.txt', 'a\nb\n');
  p.write('f.txt', 'a\r\nb\r\n');
  expect(sources(p, 'f.txt')).toEqual(['before', 't1']);
  expect(blameFile(new Store(p.root), p.file('f.txt'))[1].text).toBe('b');
});

it('labels all lines before Turnback when no turn changed the file', () => {
  const p = tempProject('turnback-blame-none-');
  p.write('f.txt', 'a\nb\n');
  expect(sources(p, 'f.txt')).toEqual(['before', 'before']);
});

it('refuses binary files', () => {
  const p = tempProject('turnback-blame-bin-');
  writeFileSync(p.file('b.bin'), Buffer.from([1, 0, 2]));
  expect(() => blameFile(new Store(p.root), p.file('b.bin'))).toThrow('Binary or large file; blame shows text files only.');
});

it('identifies directories instead of suggesting recovery', () => {
  const p = tempProject('turnback-blame-directory-');
  mkdirSync(p.file('src'));
  expect(() => blameFile(new Store(p.root), p.file('src'))).toThrow('src is a directory');
});

it('quotes missing-file recovery paths relative to the current working directory', () => {
  const p = tempProject('turnback-blame-missing-');
  mkdirSync(p.file('src'));
  const target = p.file('src/missing file.txt');
  const store = new Store(p.root);
  const argument = path.relative(process.cwd(), store.workspace.abs('src/missing file.txt')).split(path.sep).join('/');
  expect(() => blameFile(store, target)).toThrow(`turnback recover "${argument}"`);
});

it('does not print a recovery command for filenames the shell quoting helper cannot represent', () => {
  const p = tempProject('turnback-blame-unsafe-name-');
  expect(() => blameFile(new Store(p.root), p.file('missing$file.txt'))).toThrow('is not on disk');
  expect(() => blameFile(new Store(p.root), p.file('missing$file.txt'))).not.toThrow(/run: turnback recover/);
});

it.each(['EACCES', 'EPERM'])('reports %s without suggesting that the file was deleted', code => {
  const p = tempProject('turnback-blame-denied-');
  p.write('f.txt', 'readable');
  const store = new Store(p.root);
  const read = vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
    throw Object.assign(new Error('read denied'), { code });
  });
  try {
    expect(() => blameFile(store, p.file('f.txt'))).toThrow('Cannot read f.txt: permission denied');
    expect(read).toHaveBeenCalledWith(store.workspace.abs('f.txt'));
  } finally {
    read.mockRestore();
  }
});

it('preserves other read errors instead of suggesting recovery', () => {
  const p = tempProject('turnback-blame-read-error-');
  p.write('f.txt', 'readable');
  const store = new Store(p.root);
  const read = vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
    throw Object.assign(new Error('read device failure'), { code: 'EIO' });
  });
  try {
    expect(() => blameFile(store, p.file('f.txt'))).toThrow('read device failure');
  } finally {
    read.mockRestore();
  }
});

it('handles a file without a final newline', () => {
  const p = tempProject('turnback-blame-eof-');
  p.write('f.txt', 'a\nb');
  editTurn(p, 't1', 'f.txt', 'a\nb\nc');
  const got = sources(p, 'f.txt');
  expect(got).toHaveLength(3);
  expect(got[0]).toBe('before');
  expect(got[2]).toBe('t1');
});

it('returns no lines for an empty file', () => {
  const p = tempProject('turnback-blame-empty-');
  p.write('f.txt', '');
  expect(blameFile(new Store(p.root), p.file('f.txt'))).toEqual([]);
});

it('treats changes of an unfinished turn as outside a turn', () => {
  const p = tempProject('turnback-blame-open-');
  p.write('f.txt', 'a\n');
  hook(p.root, 'turn-start', 't1');
  hook(p.root, 'edit', 't1', { paths: [p.file('f.txt')] });
  p.write('f.txt', 'a\nb\n');
  expect(sources(p, 'f.txt')).toEqual(['before', 'outside']);
});

it('gives lines restored by undo back to their earlier author', () => {
  const p = tempProject('turnback-blame-undo-');
  p.write('f.txt', 'a\nb\nc\n');
  editTurn(p, 't1', 'f.txt', 'a\nc\n');
  const store = new Store(p.root);
  applyRestore(store, undoTarget(store)!, { operation: 'undo' });
  expect(sources(p, 'f.txt')).toEqual(['before', 'before', 'before']);
});

it('labels every change of an unfinished turn outside, even after several snapshots', () => {
  const p = tempProject('turnback-blame-open2-');
  p.write('f.txt', 'a\n');
  hook(p.root, 'turn-start', 't1');
  hook(p.root, 'edit', 't1', { paths: [p.file('f.txt')] });
  p.write('f.txt', 'a\nb\n');
  hook(p.root, 'edit', 't1', { paths: [p.file('f.txt')] });
  p.write('f.txt', 'a\nb\nc\n');
  expect(sources(p, 'f.txt')).toEqual(['before', 'outside', 'outside']);
});

it('keeps lines that predate recording as before in edits-only mode', () => {
  process.env.TURNBACK_MAX_FILES = '3';
  try {
    const p = tempProject('turnback-blame-edits-only-');
    for (const name of ['a', 'b', 'c', 'd']) p.write(`${name}.txt`, `${name}\n`);
    p.write('g.txt', 'g\n');
    new Store(p.root).warm();
    editTurn(p, 't1', 'a.txt', 'a\nA\n');
    editTurn(p, 't2', 'g.txt', 'g\nG\n');
    expect(sources(p, 'g.txt')).toEqual(['before', 't2']);
  } finally {
    delete process.env.TURNBACK_MAX_FILES;
  }
});
