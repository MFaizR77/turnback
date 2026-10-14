# Contributing to Turnback

Thanks for helping. Issues labeled [`good first issue`](https://github.com/MFaizR77/turnback/labels/good%20first%20issue) are small and say which files and tests they touch. Support for a new agent is tracked under [`agent-adapter`](https://github.com/MFaizR77/turnback/labels/agent-adapter); see [adding an agent](guide/ADAPTERS.md).

Questions about using or changing Turnback are welcome in [Discussions](https://github.com/MFaizR77/turnback/discussions).

## Setup

Node.js 22+ and Git 2.25+.

```bash
git clone https://github.com/MFaizR77/turnback
cd turnback
npm ci
npm run check        # type check, bundle to dist/, and run the tests
```

On a slow or busy machine, run the tests with fewer workers: `npx vitest run --maxWorkers=3`. A single file: `npx vitest run test/restore.test.ts`.

To try your build in a real agent, point the hooks at your clone: `node dist/cli.js install claude --project` in a scratch project, and set `TURNBACK_HOME` to a scratch folder so your own history stays separate. Run `npm run build` after every change; hooks call `dist/cli.js` directly.

How the pieces fit: [architecture](guide/ARCHITECTURE.md).

## Rules the code keeps

These come from what Turnback promises its users. A change that breaks one needs a good reason in the PR.

- **Hooks never block the agent.** A hook always exits 0 with the agent's neutral response, even when recording fails; the failure goes to `~/.turnback/logs` and shows up in `turnback status`.
- **The user's git repository is not touched.** Snapshots live in a shadow repo under `~/.turnback`. Only `turnback export --commit`, run by the user, writes to their repository.
- **Nothing is restored without a plan first.** The CLI needs `--yes`; MCP needs the token from the preview.
- **Every child process gets `windowsHide: true`.** `test/spawn.test.ts` fails otherwise.
- **`dist/` has no runtime dependencies.** It is bundled with esbuild so hooks work without `node_modules`. Add packages as `devDependencies`.
- **Hooks stay fast:** under 500 ms in a 10k-file repo. `npm run bench` measures it.

## Code and comments

- **Small, named functions over commented blocks.** If a block inside a function needs a comment to be understood, move it into a function whose name says what it does, and put the reason in that function's doc comment.
- **No multi-line comments inside function bodies.** A one-line note is fine next to a line that relies on outside behavior the code cannot show, such as "git exits 1 when nothing is ignored".
- **Doc comments say what and why, in one or two lines (four at most).** State what the function returns and when it returns `undefined` or `false`, plus any reason a reader could not get from the code. Do not narrate the steps.
- **Comments explain why, not what.** History, benchmarks, and "used to be" notes belong in the commit message or the PR.
- **Constants and types at the top of the file**, not between functions.
- **Repeated expressions become a helper** once they appear three times.
- **No nested ternaries.** Use `if` with early returns.

## Pull requests

- One change per PR, with a test that fails without it.
- Code, comments, docs, and commit messages are in English.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`.
- CI runs on Windows, macOS, and Linux with Node 22 and 24. Path handling and line endings differ between them; the tests in `test/` show how existing code copes.

## Reporting a bug

Use the bug template and include the output of `turnback status --json` and the agent you were using. Hook errors are logged in `~/.turnback/logs/<date>.log`.

Security issues: see [SECURITY.md](SECURITY.md).

## Code of conduct

Be kind and assume good faith. This project follows the [Contributor Covenant 2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/); report problems to the maintainer through a [private security advisory](https://github.com/MFaizR77/turnback/security/advisories/new) or by email listed on the maintainer's GitHub profile.
