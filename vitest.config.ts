import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests drive real git processes; Windows runners need more than the 5 s default under load.
    testTimeout: 30_000,
    setupFiles: ['test/setup.ts'],
    // Run git like a fresh machine or CI runner: no global/system config, so no user identity.
    env: {
      GIT_CONFIG_GLOBAL: path.join(tmpdir(), 'turnback-no-gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      // Never read the developer's own Claude Code settings (an installed Turnback plugin changes install()).
      CLAUDE_CONFIG_DIR: path.join(tmpdir(), 'turnback-no-claude-config'),
      // Plugin detection and user installs must never read or change the developer's Codex config.
      CODEX_HOME: path.join(tmpdir(), 'turnback-no-codex-config'),
    },
  },
});
