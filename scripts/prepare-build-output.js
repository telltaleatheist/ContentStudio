#!/usr/bin/env node

/**
 * Ensure the electron-builder output dir (`dist-build`) is a real directory
 * inside the project.
 *
 * It used to be a symlink to an APFS scratch dir under $HOME: the project volume
 * was exFAT, which stores extended attributes in AppleDouble `._*` files and so
 * corrupts ASAR integrity and macOS code signing. The volume is APFS as of
 * Aug 2026, so builds stay in the project — and a leftover off-project symlink
 * is replaced here (the link only, never the artifacts it pointed at).
 */

const fs = require('fs');
const path = require('path');

if (process.platform !== 'darwin') process.exit(0);

const projectRoot = path.resolve(__dirname, '..');
const projectOutput = path.join(projectRoot, 'dist-build');

let current;
try {
  current = fs.lstatSync(projectOutput);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

if (current?.isSymbolicLink()) {
  const target = fs.readlinkSync(projectOutput);
  fs.unlinkSync(projectOutput);
  console.log(`[build-output] Removed legacy dist-build symlink -> ${target} (artifacts there were left in place)`);
  current = undefined;
}

if (current && !current.isDirectory()) {
  throw new Error(`${projectOutput} exists and is not a directory — remove it and re-run.`);
}

fs.mkdirSync(projectOutput, { recursive: true });
console.log(`[build-output] Using in-project build output: ${projectOutput}`);
