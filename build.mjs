// Builds the server (TSX -> ESM) and the small browser script.
import { build } from 'esbuild';

const common = { bundle: true, logLevel: 'warning', jsx: 'automatic', target: 'es2022' };

await build({
  ...common,
  entryPoints: { server: 'src/server.ts', cli: 'src/cli.ts', tests: 'tests/run.ts' },
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  platform: 'node',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
});

await build({
  ...common,
  entryPoints: ['src/client/main.ts'],
  outfile: 'public/app.js',
  platform: 'browser',
  format: 'iife',
  minify: true,
});

console.log('Build complete');
