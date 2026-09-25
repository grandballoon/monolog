/* The end-to-end suite runs inside a real VS Code, against a throwaway copy of
 * the fixture workspace so the tests can edit, rename and delete files without
 * touching the repository. Demo mode is on in that workspace: nothing here
 * spends a token. */
import { defineConfig } from '@vscode/test-cli';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workspace = mkdtempSync(join(tmpdir(), 'monolog-e2e-'));
cpSync('test/fixture', workspace, { recursive: true });

export default defineConfig({
  files: 'dist-test/**/*.test.js',
  workspaceFolder: workspace,
  launchArgs: ['--disable-extensions'],
  mocha: { ui: 'tdd', timeout: 20_000 },
});
