#!/usr/bin/env node

/**
 * Keep Electron's ASAR/app/signing staging tree on a native macOS filesystem.
 * The source project may live on exFAT, but exFAT stores extended attributes in
 * AppleDouble `._*` files which corrupt ASAR integrity and macOS code signing.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

if (process.platform !== 'darwin') process.exit(0);

const projectRoot = path.resolve(__dirname, '..');
const projectOutput = path.join(projectRoot, 'dist-build');
const nativeOutput = path.resolve(
  process.env.CONTENTSTUDIO_BUILD_DIR ||
  path.join(os.homedir(), 'Projects', 'ContentStudio-builds', 'dist-build')
);

fs.mkdirSync(nativeOutput, { recursive: true });

let current;
try {
  current = fs.lstatSync(projectOutput);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

if (current?.isSymbolicLink()) {
  const resolved = fs.realpathSync(projectOutput);
  if (resolved !== fs.realpathSync(nativeOutput)) {
    throw new Error(
      `dist-build points to ${resolved}; expected ${nativeOutput}. ` +
      'Set CONTENTSTUDIO_BUILD_DIR if the existing target is intentional.'
    );
  }
  console.log(`[build-output] Using native build output: ${nativeOutput}`);
  process.exit(0);
}

if (current) {
  throw new Error(
    `${projectOutput} is a real directory. Migrate it once, then replace it with ` +
    `a symlink to ${nativeOutput}. Existing artifacts were left untouched.`
  );
}

fs.symlinkSync(nativeOutput, projectOutput, 'dir');
console.log(`[build-output] Linked ${projectOutput} -> ${nativeOutput}`);
