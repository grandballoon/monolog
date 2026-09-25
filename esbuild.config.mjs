/* Three builds from one config.
 *
 *  - `production` / default: the extension bundle, `dist/extension.js`.
 *  - `test`: the headless suite, so `node --test` can run it. Nothing is
 *    external here, `vscode` included, so a pure module that reaches for
 *    `vscode` fails to build instead of quietly becoming untestable.
 *  - `e2e`: the suite that runs inside a real VS Code, `dist-test/`.
 */
import esbuild from 'esbuild';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/* Found rather than listed: a test file that is never built is a test file
   that silently never runs. */
function findTests(dir, suffix) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return findTests(path, suffix);
    return entry.name.endsWith(suffix) ? [path] : [];
  });
}

const mode = process.argv[2];

if (mode === 'test') {
  await esbuild.build({
    entryPoints: findTests('src', '.test.ts'),
    outdir: 'build-test',
    format: 'esm',
    platform: 'node',
    target: 'node20',
    bundle: true,
    outExtension: { '.js': '.mjs' },
    logLevel: 'warning',
  });
} else if (mode === 'e2e') {
  await esbuild.build({
    entryPoints: findTests('test/e2e', '.test.ts'),
    outdir: 'dist-test',
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    bundle: true,
    external: ['vscode', 'mocha'],
    sourcemap: 'inline',
    logLevel: 'warning',
  });
} else {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    external: ['vscode'],
    sourcemap: mode === 'production' ? false : 'inline',
    minify: mode === 'production',
    logLevel: 'info',
  });
  if (mode === 'production') {
    await ctx.rebuild();
    await ctx.dispose();
  } else {
    await ctx.watch();
  }
}
