import * as crypto from 'crypto';
import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { InstallProgress } from './component-types';

const execFileAsync = promisify(execFile);

export function downloadFile(
  url: string,
  destination: string,
  id: string,
  onProgress: (progress: InstallProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let request: import('http').ClientRequest | undefined;
    let stream: fs.WriteStream | undefined;
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (error) fs.rm(destination, { force: true }, () => reject(error));
      else resolve();
    };
    const abort = () => {
      request?.destroy();
      stream?.destroy();
      finish(new Error('Download cancelled'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) return abort();

    const fetch = (currentUrl: string, redirects: number) => {
      if (redirects > 10) return finish(new Error('Too many download redirects'));
      const parsed = new URL(currentUrl);
      if (parsed.protocol !== 'https:') return finish(new Error(`Refusing insecure download URL: ${currentUrl}`));
      request = https.get(parsed, (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          fetch(new URL(response.headers.location, currentUrl).toString(), redirects + 1);
          return;
        }
        if (status !== 200) {
          response.resume();
          finish(new Error(`HTTP ${status} downloading ${currentUrl}`));
          return;
        }

        const totalBytes = Number(response.headers['content-length'] ?? 0);
        let receivedBytes = 0;
        let idle: NodeJS.Timeout;
        const armIdle = () => {
          clearTimeout(idle);
          idle = setTimeout(() => request?.destroy(new Error('Download stalled for 60 seconds')), 60_000);
        };
        stream = fs.createWriteStream(destination, { flags: 'wx' });
        response.on('data', (chunk: Buffer) => {
          receivedBytes += chunk.length;
          armIdle();
          onProgress({
            id,
            phase: 'download',
            pct: totalBytes ? Math.round(receivedBytes * 100 / totalBytes) : 0,
            receivedBytes,
            totalBytes: totalBytes || undefined,
          });
        });
        response.on('error', (error) => finish(error));
        stream.on('error', (error) => finish(error));
        stream.on('finish', () => stream?.close((error) => {
          clearTimeout(idle);
          if (error) return finish(error);
          if (totalBytes && receivedBytes !== totalBytes) {
            return finish(new Error(`Incomplete download: ${receivedBytes} of ${totalBytes} bytes`));
          }
          finish();
        }));
        armIdle();
        response.pipe(stream);
      });
      request.on('error', (error) => finish(error));
    };
    fetch(url, 0);
  });
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export async function verifySha256(filePath: string, expected?: string): Promise<string> {
  const actual = await sha256File(filePath);
  if (expected && actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`Checksum mismatch: expected ${expected}, got ${actual}`);
  }
  return actual;
}

function validateArchiveEntries(entries: string): void {
  for (const entry of entries.split(/\r?\n/).filter(Boolean)) {
    const normalized = entry.replace(/\\/g, '/');
    if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
      throw new Error(`Unsafe archive entry: ${entry}`);
    }
  }
}

export async function extractArchive(archive: string, destination: string): Promise<void> {
  fs.mkdirSync(destination, { recursive: true });
  const tar = os.platform() === 'win32' ? `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\tar.exe` : 'tar';
  const listing = await execFileAsync(tar, ['-tf', archive], { maxBuffer: 20 * 1024 * 1024 });
  validateArchiveEntries(listing.stdout);
  await execFileAsync(tar, ['-xf', archive, '-C', destination], { maxBuffer: 20 * 1024 * 1024 });
}

export function findFile(root: string, basename: string): string | null {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = `${root}/${entry.name}`;
    if (entry.isDirectory()) {
      const nested = findFile(fullPath, basename);
      if (nested) return nested;
    } else if (entry.name.toLowerCase() === basename.toLowerCase()) return fullPath;
  }
  return null;
}
