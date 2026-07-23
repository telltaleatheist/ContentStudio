// Build script: bundles src/*.ts with esbuild and copies static assets
// (manifest.json, HTML, CSS) into dist/ so that dist/ is the complete,
// loadable extension root.
//
// Usage:
//   node scripts/build.mjs           one-shot build
//   node scripts/build.mjs --watch   rebuild on TS changes (statics are
//                                    re-copied after every TS rebuild; a
//                                    change to ONLY a static file needs a
//                                    manual re-run)

import * as esbuild from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(extensionRoot, 'dist');

const staticFiles = [
  ['manifest.json', 'manifest.json'],
  ['public/popup.html', 'popup.html'],
  ['public/options.html', 'options.html'],
  ['public/companion.css', 'companion.css'],
];

function copyStatics() {
  mkdirSync(dist, { recursive: true });
  for (const [from, to] of staticFiles) {
    cpSync(path.join(extensionRoot, from), path.join(dist, to));
  }
}

const copyStaticsPlugin = {
  name: 'copy-statics',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length === 0) {
        copyStatics();
        console.log(`[build] copied ${staticFiles.length} static files -> dist/`);
      }
    });
  },
};

/** @type {esbuild.BuildOptions} */
const options = {
  entryPoints: [
    path.join(extensionRoot, 'src/background.ts'),
    path.join(extensionRoot, 'src/popup.ts'),
    path.join(extensionRoot, 'src/options.ts'),
  ],
  outdir: dist,
  bundle: true,
  format: 'esm',
  target: ['chrome120'],
  sourcemap: false,
  logLevel: 'info',
  plugins: [copyStaticsPlugin],
};

if (process.argv.includes('--watch')) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('[watch] watching src/ for changes…');
} else {
  await esbuild.build(options);
}
