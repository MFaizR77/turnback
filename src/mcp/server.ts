import { CLIENT_CAPABILITIES_META_KEY, inputRequired, inputResponse, McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import path from 'node:path';
import * as z from 'zod/v4';
import { VERSION } from '../core/config.js';
import { formatBlame, formatSteps, formatTurns } from '../core/format.js';
import { blameFile } from '../core/blame.js';
import { compareTurns } from '../core/compare.js';
import { sessionReport } from '../core/report.js';
import { applyRestore, findRecoverable, planRestore, redoTarget, resolveRef } from '../core/restore.js';
import { Store } from '../core/store.js';

const MAX_DIFF_CHARS = 40_000;
const SUMMARY_CHARS = 4_000;

const result = (value: object, summary: string) => ({
  content: [{ type: 'text' as const, text: summary }],
  structuredContent: value as Record<string, unknown>,
});
const failure = (e: unknown) => ({
  content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }],
  isError: true,
});
/** Explicit workspace, then TURNBACK_WORKSPACE (set by the Claude Code plugin), then the server's cwd. */
function storeFor(workspace?: string) {
  const fromEnv = process.env.TURNBACK_WORKSPACE;
  // An unexpanded `${...}` means the client did not substitute the variable.
  const envRoot = fromEnv && !fromEnv.includes('${') ? fromEnv : undefined;
  return new Store(workspace || envRoot || process.cwd());
}

const workspaceParam = z.string().optional().describe('Workspace folder; defaults to the server working directory');

export function createServer(): McpServer {
  const server = new McpServer({ name: 'turnback', version: VERSION });

  server.registerTool('list_turns', {
    description: 'List recorded agent turns, newest first',
    inputSchema: z.object({ workspace: workspaceParam, limit: z.number().int().min(1).max(100).default(20) }),
    annotations: { readOnlyHint: true },
  }, async ({ workspace, limit }) => {
    try {
      const store = storeFor(workspace);
      const turns = store.turns().slice(0, limit).map(t => store.summarize(t));
      return result({ turns }, formatTurns(turns));
    } catch (e) { return failure(e); }
  });

  server.registerTool('diff_turn', {
    description: 'Show changes made during a turn',
    inputSchema: z.object({ turn: z.string(), workspace: workspaceParam, patch: z.boolean().default(false) }),
    annotations: { readOnlyHint: true },
  }, async ({ turn, workspace, patch }) => {
    try {
      const { turn: id, diff } = storeFor(workspace).turnDiff(turn, patch);
      return result({ turn: id, diff: diff.slice(0, MAX_DIFF_CHARS), truncated: diff.length > MAX_DIFF_CHARS }, diff.slice(0, SUMMARY_CHARS));
    } catch (e) { return failure(e); }
  });

  server.registerTool('turn_steps', {
    description: 'List the edit and shell steps of a turn. Pass a step ref as restore target to return to just before that step.',
    inputSchema: z.object({ turn: z.string(), workspace: workspaceParam }),
    annotations: { readOnlyHint: true },
  }, async ({ turn, workspace }) => {
    try {
      const steps = storeFor(workspace).steps(turn);
      return result({ turn, steps }, formatSteps(steps));
    } catch (e) { return failure(e); }
  });

  server.registerTool('file_history', {
    description: 'List the turns that changed a file or folder, newest first',
    inputSchema: z.object({ path: z.string().describe('File or folder, relative to the workspace or absolute'), workspace: workspaceParam }),
    annotations: { readOnlyHint: true },
  }, async ({ path: target, workspace }) => {
    try {
      const store = storeFor(workspace);
      const turns = store.fileHistory(path.resolve(store.root, target));
      return result({ turns }, formatTurns(turns));
    } catch (e) { return failure(e); }
  });

  server.registerTool('blame_file', {
    description: 'For each line of a text file: the turn that last wrote it (agent, time, prompt), "before" Turnback started recording, or "outside" a turn (changed between turns)',
    inputSchema: z.object({
      path: z.string().describe('File, relative to the workspace or absolute'),
      start: z.number().int().min(1).optional().describe('First line to include'),
      end: z.number().int().min(1).optional().describe('Last line to include'),
      workspace: workspaceParam,
    }),
    annotations: { readOnlyHint: true },
  }, async ({ path: target, start, end, workspace }) => {
    try {
      const store = storeFor(workspace);
      const blamed = blameFile(store, path.resolve(store.root, target)).filter(l => l.line >= (start ?? 1) && l.line <= (end ?? Infinity));
      const lines = blamed.map(({ turn, ...l }) => ({ ...l, ...turn && { turn: { id: turn.id, agent: turn.agent, time: turn.time, prompt: turn.prompt } } }));
      const text = formatBlame(blamed, new Map(store.turns().map((t, i) => [t.id, i + 1])));
      return result({ lines }, text.slice(0, SUMMARY_CHARS));
    } catch (e) { return failure(e); }
  });

  server.registerTool('recover_file', {
    description: 'Find the newest snapshot holding a version of one file that differs from the file on disk (for a deleted file, the last one that had it). Nothing is written: pass the returned target and paths to restore to bring it back.',
    inputSchema: z.object({ path: z.string().describe('File, relative to the workspace or absolute'), workspace: workspaceParam }),
    annotations: { readOnlyHint: true },
  }, async ({ path: target, workspace }) => {
    try {
      const store = storeFor(workspace);
      const abs = path.resolve(store.root, target);
      const found = findRecoverable(store, abs);
      const rel = store.workspace.relative(abs)!;
      if (!found) throw new Error(`No snapshot has a version of ${rel} that differs from the file on disk`);
      const turn = found.turn && store.summarize(found.turn, []);
      return result(
        { target: found.ref, paths: [rel], time: found.entry.time, turn: turn && { id: turn.id, agent: turn.agent, time: turn.time, prompt: turn.prompt } },
        `Found a version of ${rel} from ${turn ? `${found.entry.kind === 'baseline' ? 'just before ' : ''}turn "${turn.prompt ?? turn.id}" (${turn.agent})` : `the snapshot of ${found.entry.time}`}. Call restore with target ${found.ref} and paths ["${rel}"] to preview bringing it back.`,
      );
    } catch (e) { return failure(e); }
  });

  server.registerTool('search_turns', {
    description: 'Find turns whose prompt, shell commands, or edited paths contain the text',
    inputSchema: z.object({ query: z.string(), workspace: workspaceParam, limit: z.number().int().min(1).max(100).default(20) }),
    annotations: { readOnlyHint: true },
  }, async ({ query, workspace, limit }) => {
    try {
      const turns = storeFor(workspace).searchTurns(query).slice(0, limit);
      return result({ turns }, formatTurns(turns));
    } catch (e) { return failure(e); }
  });

  server.registerTool('diff_range', {
    description: 'Show what changed from a turn start, mark, or snapshot ref to another point or to the current files (default). Use it to review your own work before saying a task is done.',
    inputSchema: z.object({
      from: z.string().describe('Turn ID (its start), mark label, or snapshot ref'),
      to: z.string().optional().describe('Same forms as from; defaults to the current files'),
      patch: z.boolean().default(false),
      workspace: workspaceParam,
    }),
    annotations: { readOnlyHint: true },
  }, async ({ from, to, patch, workspace }) => {
    try {
      const store = storeFor(workspace);
      const a = resolveRef(store, from);
      // A probe snapshot only writes to Turnback's own shadow repo, never to project files.
      const b = to ? resolveRef(store, to) : store.probe();
      const diff = patch ? store.repo.diffPatch(a, b) : store.repo.diffStat(a, b);
      return result({ from: a, to: b, diff: diff.slice(0, MAX_DIFF_CHARS), truncated: diff.length > MAX_DIFF_CHARS }, diff.slice(0, SUMMARY_CHARS) || 'No changes.');
    } catch (e) { return failure(e); }
  });

  server.registerTool('compare_turns', {
    description: 'Compare the results of two turns: files changed only by one, by both with different or identical results, and the diff from A to B',
    inputSchema: z.object({ a: z.string(), b: z.string(), workspace: workspaceParam }),
    annotations: { readOnlyHint: true },
  }, async ({ a, b, workspace }) => {
    try {
      const c = compareTurns(storeFor(workspace), a, b);
      const patch = c.patch.slice(0, MAX_DIFF_CHARS);
      return result({ ...c, patch, truncated: c.patch.length > MAX_DIFF_CHARS }, `only A: ${c.onlyA.length}, only B: ${c.onlyB.length}, different: ${c.both.length}, same: ${c.same.length}`);
    } catch (e) { return failure(e); }
  });

  server.registerTool('session_report', {
    description: "Markdown report of one agent session: each turn's prompt, commands, and changed files. Defaults to the latest session.",
    inputSchema: z.object({ session: z.string().optional(), workspace: workspaceParam }),
    annotations: { readOnlyHint: true },
  }, async ({ session, workspace }) => {
    try {
      const report = sessionReport(storeFor(workspace), session);
      return result({ report }, report);
    } catch (e) { return failure(e); }
  });

  server.registerTool('status', {
    description: 'Show Turnback storage and protection status',
    inputSchema: z.object({ workspace: workspaceParam }),
    annotations: { readOnlyHint: true },
  }, async ({ workspace }) => {
    try {
      const status = storeFor(workspace).status();
      const corrupt = status.corrupt.length ? `; ${status.corrupt.length} corrupt shadow repo(s) moved aside` : '';
      return result(status, `${status.turns} turns; mode ${status.mode}; ${status.failures.length} recent skipped or failed snapshots${corrupt}`);
    } catch (e) { return failure(e); }
  });

  registerRestoreTool(server, 'restore', 'Preview or restore workspace files to a turn baseline or a snapshot ref (for example a step ref from turn_steps). Call once for a plan, then again with confirm_token as token.');
  registerRestoreTool(server, 'redo', 'Preview or undo the last restore. Call once for a plan, then again with confirm_token as token.');
  return server;
}

/**
 * Restore over MCP is always two-step: a call without a token only returns the plan.
 * Files that may have been edited manually are overwritten only if the user approves via elicitation.
 */
function registerRestoreTool(server: McpServer, name: 'restore' | 'redo', description: string): void {
  server.registerTool(name, {
    description,
    inputSchema: z.object({
      target: z.string().optional().describe('Turn id or snapshot ref (restore only)'),
      paths: z.array(z.string()).optional(),
      token: z.string().optional(),
      workspace: workspaceParam,
    }),
    annotations: { destructiveHint: true },
  }, async ({ target, paths, token, workspace }, ctx) => {
    try {
      const store = storeFor(workspace);
      if (name === 'redo') target = redoTarget(store);
      if (!target) throw new Error(name === 'redo' ? 'No restore to redo' : 'target is required');

      const plan = planRestore(store, target, paths);
      if (!token) {
        return result({ ...plan, confirm_token: plan.token }, `${plan.actions.length} file changes. Call ${name} again with confirm_token as token.`);
      }
      if (token !== plan.token) throw new Error('Stale or invalid confirmation token');

      const uncertain = plan.actions.filter(a => a.uncertain);
      // Not answered yet → ask once. Decline/cancel is honored as an answer, not asked again.
      const answer = inputResponse(ctx.mcpReq.inputResponses, 'approve');
      const capabilities = (ctx.mcpReq.envelope as Record<string, { elicitation?: unknown }> | undefined)?.[CLIENT_CAPABILITIES_META_KEY];
      if (uncertain.length && capabilities?.elicitation && answer.kind === 'missing') {
        return inputRequired({
          inputRequests: {
            approve: inputRequired.elicit({
              message: `Turnback will overwrite ${uncertain.length} file(s) that may contain manual edits: ${uncertain.map(a => a.path).join(', ')}. Accept to overwrite, Decline to skip them.`,
              // The Accept button alone means approval; the field is optional so the form can be submitted as is.
              requestedSchema: { type: 'object', properties: { approve: { type: 'boolean', title: 'Overwrite these files', default: true } } },
            }),
          },
        });
      }
      const approved = answer.kind === 'elicit' && answer.action === 'accept' && answer.content?.approve !== false;

      const restored = applyRestore(store, target, { paths, token, skipUncertain: !approved, operation: name });
      const note = restored.skipped.length ? ' Suggest `turnback restore` from the CLI for skipped files.' : '';
      return result(restored, `${restored.applied.length} restored; ${restored.skipped.length} manual edits skipped; ${restored.failed.length} failed. Safety snapshot: ${restored.safety}.${note}`);
    } catch (e) { return failure(e); }
  });
}

export function serveMcp(): void {
  serveStdio(() => createServer(), { onerror: e => process.stderr.write(String(e) + '\n') });
}
