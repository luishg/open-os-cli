import * as esbuild from 'esbuild';
import { cpSync, mkdirSync } from 'fs';

mkdirSync('dist/frontend', { recursive: true });

// Main process (Node.js context)
await esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron', 'node-pty'],
  outfile: 'dist/main.js',
});

// Preload script (Node.js context, runs in renderer)
await esbuild.build({
  entryPoints: ['src/preload.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  outfile: 'dist/preload.js',
});

// Renderer (browser context — bundles xterm.js into the output)
await esbuild.build({
  entryPoints: ['src/frontend/renderer.ts'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  outfile: 'dist/frontend/renderer.js',
});

// Copy static files
cpSync('src/frontend/index.html', 'dist/frontend/index.html');
cpSync('src/frontend/styles.css', 'dist/frontend/styles.css');
cpSync('node_modules/@xterm/xterm/css/xterm.css', 'dist/frontend/xterm.css');

console.log('Build complete.');
