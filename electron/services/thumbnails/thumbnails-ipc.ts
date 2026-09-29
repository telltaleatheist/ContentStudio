/**
 * The Thumbnails window's IPC (the reports page, phase 2, 2026-09-28) and the Thumbnail look's.
 * Thin: every handler calls ReportThumbnails (report-thumbnails.ts) or ThumbnailLook (look.ts) and
 * answers `{ ok: true, value }` or `{ ok: false, error }` with the service's own sentence, so the
 * page shows the refusal as written instead of Electron's "Error invoking remote method" prefix.
 *
 * Replaces the retired Thumbnails test tab's `thumbs:*` channels. Progress goes to the window that
 * asked, on `thumbnails:progress`.
 */
import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from 'electron';
import { randomInt } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as log from 'electron-log';
import type Store from 'electron-store';
import type { CrucibleContext } from '../../crucible/context';
import { getRuntimePaths } from '../../lib/bridges/runtime-paths';
import { AIManagerService } from '../metadata/ai-manager.service';
import { ThumbnailLook } from './look';
import { thumbnailRunChoice } from './pipeline-setup';
import { IMAGE_EXTENSIONS, ReportThumbnails } from './report-thumbnails';

type Answer<T> = { ok: true; value: T } | { ok: false; error: string };

async function answer<T>(what: string, fn: () => Promise<T> | T): Promise<Answer<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`[Thumbnails] ${what} failed: ${message}`);
    return { ok: false, error: message };
  }
}

/** A file as a data URL at most `width` wide (the window's pictures; never the full render). */
function picture(file: string, width: number): string {
  const image = nativeImage.createFromPath(file);
  if (image.isEmpty()) throw new Error(`The picture ${file} could not be read.`);
  const size = image.getSize();
  return (size.width > width ? image.resize({ width, quality: 'good' }) : image).toDataURL();
}

async function chooseFiles(event: Electron.IpcMainInvokeEvent, multi: boolean): Promise<string[] | null> {
  const win = BrowserWindow.fromWebContents(event.sender);
  const options = {
    properties: multi ? ['openFile' as const, 'multiSelections' as const] : ['openFile' as const],
    filters: [{ name: 'Images (PNG or JPEG)', extensions: IMAGE_EXTENSIONS.map((e) => e.slice(1)) }],
  };
  const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  return picked.canceled || picked.filePaths.length === 0 ? null : picked.filePaths;
}

export function setupThumbnailsIpc(store: Store<any>, crucible: CrucibleContext, userDataPath: string): void {
  const paths = getRuntimePaths();
  const newSeed = () => randomInt(1, 0x7fffffff);
  const look = new ThumbnailLook({ store: { get: (key) => store.get(key), set: (key, value) => store.set(key, value) }, userDataPath });
  let progressTo: Electron.WebContents | null = null;
  const report = new ReportThumbnails({
    store: { get: (key) => store.get(key) },
    userDataPath,
    ffprobe: paths.ffprobe,
    look,
    runChoice: () => thumbnailRunChoice({
      requested: true,
      store: { get: (key) => store.get(key) },
      crucible,
      userDataPath,
      appRoot: app.getAppPath(),
      ffmpeg: paths.ffmpeg,
      ffprobe: paths.ffprobe,
      newSeed,
    }),
    holdJob: (what) => crucible.transport.job(what),
    aiManager: () => new AIManagerService({ promptSetsDir: path.join(app.getPath('userData'), 'prompt_sets') }),
    picture,
    photoList: () => look.photos().photos.map((p) => ({ name: p.name, preview: p.preview, note: p.note })),
    newSeed,
    progress: (event) => {
      if (progressTo !== null && !progressTo.isDestroyed()) progressTo.send('thumbnails:progress', event);
    },
    gpuVenue: () => crucible.lanes.gpuVenue(),
  });
  app.on('before-quit', () => {
    void report.releaseHold('the app is quitting');
  });

  // ── the window ──────────────────────────────────────────────────────────────
  ipcMain.handle('thumbnails:summary', (_e, jobId: string, itemId: string) => answer('reading the thumbnails', () => report.summary(jobId, itemId)));
  ipcMain.handle('thumbnails:item', (_e, jobId: string, itemId: string) => answer('reading the thumbnails', () => report.view(jobId, itemId)));
  ipcMain.handle('thumbnails:frames', (_e, jobId: string, itemId: string, ids: string[]) => answer('reading frames', () => report.framePictures(jobId, itemId, ids)));
  ipcMain.handle('thumbnails:render-pair', (event, jobId: string, itemId: string, change) => {
    progressTo = event.sender;
    return answer('drawing a thumbnail', () => report.renderPair(jobId, itemId, change));
  });
  ipcMain.handle('thumbnails:pair-title', (event, jobId: string, itemId: string, pair: number, title: string) => {
    progressTo = event.sender;
    return answer('rewriting the words', () => report.pairTitle(jobId, itemId, pair, title));
  });
  ipcMain.handle('thumbnails:finish', (event, jobId: string, itemId: string) => {
    progressTo = event.sender;
    return answer('finishing the thumbnails', () => report.finish(jobId, itemId));
  });
  ipcMain.handle('thumbnails:remake', (event, jobId: string, itemId: string) => {
    progressTo = event.sender;
    return answer('making the thumbnails again', () => report.remake(jobId, itemId));
  });
  ipcMain.handle('thumbnails:save-picks', (_e, jobId: string, itemId: string, picks) => answer('saving the picks', () => report.savePicks(jobId, itemId, picks)));
  ipcMain.handle('thumbnails:screenshots', (event, jobId: string, itemId: string, files: string[], titles: string[]) => {
    progressTo = event.sender;
    return answer('making thumbnails from screenshots', () => report.useScreenshots(jobId, itemId, files, titles));
  });
  ipcMain.handle('thumbnails:choose-own', (event) => answer('choosing your image', async () => (await chooseFiles(event, false))?.[0] ?? null));
  ipcMain.handle('thumbnails:choose-screenshots', (event) => answer('choosing screenshots', () => chooseFiles(event, true)));
  ipcMain.handle('thumbnails:release-model', () => answer('releasing the text model', () => report.releaseHold('the Thumbnails window was closed')));
  ipcMain.handle('thumbnails:show-folder', (_e, folder: string) =>
    answer('opening the folder', async () => {
      if (typeof folder !== 'string' || !fs.existsSync(folder)) throw new Error(`The folder is not there: ${folder}`);
      const error = await shell.openPath(folder);
      if (error) throw new Error(error);
    }),
  );

  // ── the one look (Thumbnail look dialog) ────────────────────────────────────
  ipcMain.handle('thumbnails:get-style', () => answer('reading the look', () => look.getStyle()));
  ipcMain.handle('thumbnails:set-style', (_e, style: unknown) => answer('saving the look', () => look.setStyle(style)));
  ipcMain.handle('thumbnails:photos', () => answer('reading the reaction photos', () => look.photos()));
  ipcMain.handle('thumbnails:set-photo-note', (_e, name: string, note: string) => answer('saving a photo note', () => look.setPhotoNote(name, note)));
  // "Add photos…": PNG files and/or folders (a folder adds its PNGs), copied into the app's library.
  // Returns the chosen paths with the outcome, so a refusal for names already there can be
  // confirmed and sent again with replace (thumbnails:add-photos).
  ipcMain.handle('thumbnails:choose-photos', (event) =>
    answer('adding reaction photos', async () => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const options = {
        properties: ['openFile' as const, 'openDirectory' as const, 'multiSelections' as const],
        filters: [{ name: 'PNG cut-outs', extensions: ['png'] }],
      };
      const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      if (picked.canceled || picked.filePaths.length === 0) return null;
      return { chosen: picked.filePaths, ...look.addPhotos(picked.filePaths, false) };
    }),
  );
  ipcMain.handle('thumbnails:add-photos', (_e, chosen: string[], replace: boolean) =>
    answer('adding reaction photos', () => ({ chosen, ...look.addPhotos(chosen, replace) })));
  ipcMain.handle('thumbnails:remove-photo', (_e, name: string) => answer('removing a reaction photo', () => look.removePhoto(name)));
  ipcMain.handle('thumbnails:copy-old-photos', () => answer('copying the reaction photos into the app', () => look.copyOldPhotos()));
  ipcMain.handle('thumbnails:logo', () => answer('reading the logo', () => look.logo()));
  ipcMain.handle('thumbnails:choose-logo', (event) =>
    answer('choosing the logo file', async () => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const options = { properties: ['openFile' as const], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }] };
      const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      if (picked.canceled || picked.filePaths.length === 0) return null;
      return look.setLogo(picked.filePaths[0]);
    }),
  );
  ipcMain.handle('thumbnails:copy-old-logo', () => answer('copying the logo into the app', () => look.copyOldLogo()));
}
