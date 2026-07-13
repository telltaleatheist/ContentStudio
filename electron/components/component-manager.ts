import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { getCatalog, getComponent } from './catalog';
import { downloadFile, extractArchive, findFile, verifySha256 } from './downloader';
import type { ComponentStatus, InstalledManifest, InstalledRecord, InstallProgress, InstallResult } from './component-types';

const activeInstalls = new Map<string, AbortController>();

function componentsDir(): string { return path.join(app.getPath('userData'), 'components'); }
function manifestPath(): string { return path.join(componentsDir(), 'installed.json'); }
function installDir(id: string): string { return path.join(componentsDir(), id); }

function readManifest(): InstalledManifest {
  if (!fs.existsSync(manifestPath())) return { components: {} };
  const parsed = JSON.parse(fs.readFileSync(manifestPath(), 'utf8')) as InstalledManifest;
  if (!parsed.components || typeof parsed.components !== 'object') {
    throw new Error(`Invalid component manifest at ${manifestPath()}`);
  }
  return parsed;
}

function writeManifest(manifest: InstalledManifest): void {
  fs.mkdirSync(componentsDir(), { recursive: true });
  const temporary = `${manifestPath()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2));
  fs.renameSync(temporary, manifestPath());
}

export function resolveEntry(id: string): string | null {
  const record = readManifest().components[id];
  return record && fs.existsSync(record.entryPath) ? record.entryPath : null;
}

export function expectedEntry(id: string): string {
  const component = getComponent(id);
  if (!component) throw new Error(`Unknown component: ${id}`);
  return path.join(installDir(id), component.entryPath);
}

export function listStatus(): ComponentStatus[] {
  const installed = readManifest();
  return getCatalog().map((component) => {
    const record = installed.components[component.id];
    const artifact = component.artifacts.find((item) => item.platform === process.platform && item.arch === process.arch);
    if (record && fs.existsSync(record.entryPath)) return { component, state: 'installed', installed: record };
    if (!artifact) return { component, state: 'incompatible', reason: 'No download is published for this platform and architecture.' };
    return { component, state: 'available' };
  });
}

export async function install(id: string, onProgress: (progress: InstallProgress) => void): Promise<InstallResult> {
  const component = getComponent(id);
  if (!component) return { id, ok: false, error: `Unknown component: ${id}` };
  if (activeInstalls.has(id)) return { id, ok: false, error: `${component.name} is already downloading` };
  const artifact = component.artifacts.find((item) => item.platform === process.platform && item.arch === process.arch);
  if (!artifact) return { id, ok: false, error: 'No download is published for this system' };

  const controller = new AbortController();
  activeInstalls.set(id, controller);
  const liveDir = installDir(id);
  fs.mkdirSync(componentsDir(), { recursive: true });
  const temporaryDir = fs.mkdtempSync(path.join(componentsDir(), `.install-${id}-`));
  const downloadPath = path.join(temporaryDir, artifact.kind === 'archive' ? 'download.archive' : (artifact.fileName || component.entryPath));
  try {
    onProgress({ id, phase: 'resolve', pct: 0, message: 'Preparing download…' });
    await downloadFile(artifact.url, downloadPath, id, onProgress, controller.signal);
    onProgress({ id, phase: 'verify', pct: 0, message: 'Verifying download…' });
    const sha256 = await verifySha256(downloadPath, artifact.sha256);

    const stagedDir = path.join(temporaryDir, 'installed');
    fs.mkdirSync(stagedDir);
    let stagedEntry: string;
    if (artifact.kind === 'archive') {
      onProgress({ id, phase: 'extract', pct: 0, message: 'Extracting…' });
      await extractArchive(downloadPath, stagedDir);
      const entryName = artifact.entry || component.entryPath;
      stagedEntry = findFile(stagedDir, path.basename(entryName)) || path.join(stagedDir, entryName);
    } else {
      stagedEntry = path.join(stagedDir, artifact.fileName || component.entryPath);
      fs.renameSync(downloadPath, stagedEntry);
    }
    if (!fs.existsSync(stagedEntry)) throw new Error(`Installed entry not found: ${component.entryPath}`);
    if (process.platform !== 'win32' && component.category === 'tool') fs.chmodSync(stagedEntry, 0o755);

    if (fs.existsSync(liveDir)) throw new Error(`${component.name} already has an install directory; remove it before reinstalling`);
    fs.renameSync(stagedDir, liveDir);
    const entryPath = path.join(liveDir, path.relative(stagedDir, stagedEntry));
    const record: InstalledRecord = { id, version: component.version, path: liveDir, entryPath, sha256, bytes: artifact.bytes, installedAt: new Date().toISOString() };
    const manifest = readManifest();
    manifest.components[id] = record;
    writeManifest(manifest);
    onProgress({ id, phase: 'done', pct: 100, message: 'Installed' });
    return { id, ok: true, record };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onProgress({ id, phase: 'error', pct: 0, message });
    return { id, ok: false, error: message };
  } finally {
    activeInstalls.delete(id);
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
}

export function cancel(id: string): void { activeInstalls.get(id)?.abort(); }

export function uninstall(id: string): void {
  if (!getComponent(id)) throw new Error(`Unknown component: ${id}`);
  const manifest = readManifest();
  delete manifest.components[id];
  writeManifest(manifest);
  fs.rmSync(installDir(id), { recursive: true, force: true });
}
