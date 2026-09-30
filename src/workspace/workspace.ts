import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync, type Stats } from 'node:fs';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { canonicalPath, dataHome, EXCLUDED_DIRS, MAX_FILE_BYTES, userConfig } from '../core/config.js';

export interface Scan {
  /** Files in snapshot scope (relative paths, `/` separator). */
  paths: string[];
  /** Files over the size limit or unreadable. */
  skipped: string[];
  bytes: number;
}

export interface FileState {
  /** Git blob ID of the file content, so it can be compared directly with shadow repo trees. */
  oid: string;
  mode: string;
}

/** The user's project folder: exclusion rules, scanning, and reading file content. */
export class Workspace {
  private readonly matcher: Ignore = ignore();

  constructor(readonly root: string) {
    try { this.matcher.add(readFileSync(path.join(root, '.turnbackignore'), 'utf8')); } catch { /* optional */ }
    this.matcher.add(userConfig().exclude ?? []);
    // A TURNBACK_HOME inside the project must never snapshot, or restore over, Turnback's own data.
    const home = this.relative(dataHome());
    if (home) this.matcher.add(`/${home.replace(/[\\[\]*?!#]/g, '\\$&')}/`);
  }

  abs(rel: string): string {
    return path.join(this.root, rel);
  }

  /**
   * Path relative to the root, or `undefined` if outside the workspace. A path that looks outside
   * is retried in canonical form, since it may reach the root through an alias.
   */
  relative(p: string): string | undefined {
    const abs = path.resolve(this.root, p);
    return this.inside(abs) ?? this.inside(canonicalPath(abs));
  }

  private inside(abs: string): string | undefined {
    const rel = path.relative(this.root, abs).split(path.sep).join('/');
    return rel && rel !== '..' && !rel.startsWith('../') && !path.isAbsolute(rel) ? rel : undefined;
  }

  excluded(rel: string): boolean {
    return rel.split('/').some(part => EXCLUDED_DIRS.has(part)) || this.matcher.ignores(rel);
  }

  /** An existing regular file or symlink, in scope and within the size limit. */
  snapshotable(rel: string): boolean {
    if (this.excluded(rel)) return false;
    const st = this.stat(rel);
    return !!st && (st.isFile() || st.isSymbolicLink()) && st.size <= MAX_FILE_BYTES;
  }

  stat(rel: string): Stats | undefined {
    try { return lstatSync(this.abs(rel)); } catch { return undefined; }
  }

  scan(): Scan {
    const result: Scan = { paths: [], skipped: [], bytes: 0 };
    const visit = (dir: string) => {
      const items = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      for (const item of items) {
        const abs = path.join(dir, item.name);
        const rel = path.relative(this.root, abs).split(path.sep).join('/');
        if (this.excluded(rel)) continue;
        try {
          const st = lstatSync(abs);
          if (st.isDirectory()) visit(abs);
          else if (!st.isFile() && !st.isSymbolicLink()) continue;
          else if (st.size > MAX_FILE_BYTES) result.skipped.push(rel);
          else {
            result.paths.push(rel);
            result.bytes += st.size;
          }
        } catch {
          result.skipped.push(rel);
        }
      }
    };
    visit(this.root);
    return result;
  }

  /** File content and mode as git would store them; `undefined` if the file does not exist. */
  fileState(rel: string, oidLength: number): FileState | undefined {
    const file = this.read(rel);
    return file && { oid: blobId(file.content, oidLength), mode: file.mode };
  }

  /** File content (a symlink's target) and git mode; `undefined` if it is gone or not a file. */
  read(rel: string): { content: Buffer; mode: string } | undefined {
    const st = this.stat(rel);
    if (!st || !(st.isFile() || st.isSymbolicLink())) return undefined;
    const abs = this.abs(rel);
    try {
      const content = st.isSymbolicLink() ? Buffer.from(readlinkSync(abs)) : readFileSync(abs);
      return { content, mode: st.isSymbolicLink() ? '120000' : st.mode & 0o111 ? '100755' : '100644' };
    } catch {
      return undefined;
    }
  }
}

/** Git blob object ID (SHA-1 or SHA-256, following the repo format). */
export function blobId(content: Buffer, oidLength = 40): string {
  return createHash(oidLength === 64 ? 'sha256' : 'sha1')
    .update(`blob ${content.length}\0`)
    .update(content)
    .digest('hex');
}
