/**
 * The Thumbnails window's IPC (the reports page, phase 2, 2026-09-28) and the Thumbnail look's.
 * Thin: every handler calls ReportThumbnails (report-thumbnails.ts) or ThumbnailLook (look.ts) and
 * answers `{ ok: true, value }` or `{ ok: false, error }` with the service's own sentence, so the
 * page shows the refusal as written instead of Electron's "Error invoking remote method" prefix.
 *
 * Replaces the retired Thumbnails test tab's `thumbs:*` channels. Progress goes to the window that
 * asked, on `thumbnails:progress`.
 *
 * The card editor's live preview (2026-09-29) is drawn in the window; what only the main process can
 * make for it (a frame at full size and its faces, a photo trimmed, the logo at its drawn size, the
 * border) comes from `previewPieces` below, with the render's own readers.
 */
import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as log from 'electron-log';
import type Store from 'electron-store';
import type { CrucibleContext } from '../../crucible/context';
import { getRuntimePaths } from '../../lib/bridges/runtime-paths';
import { AIManagerService } from '../metadata/ai-manager.service';
import { readBorder } from './border';
import { ThumbnailCanvas, canvasPagePath, dataUrlOf } from './canvas-page';
import { logoAt, readLogo } from './logo';
import { ThumbnailLook } from './look';
import { thumbnailRunChoice } from './pipeline-setup';
import { trimmedPhoto } from './reaction-photos';
import { OUTPUT_WIDTH } from './renderer';
import { IMAGE_EXTENSIONS, ReportThumbnails, type PreviewPieces } from './report-thumbnails';

/** The tallest a photo's preview picture is sent (it is drawn at most about this tall on a 1280x720 card). */
const PHOTO_PREVIEW_HEIGHT = 900;

/**
 * The live preview's pieces, made with the render's own readers: the frame file the render draws
 * (at the output's width for the window), Apple Vision's faces on that same file (a hidden canvas
 * page, made on first use and closed with the window), the photo trimmed as the render trims it,
 * the logo downscaled exactly as the render downscales it, the border checked as the render checks it.
 */
function previewPieces(appRoot: string): PreviewPieces {
  let canvas: ThumbnailCanvas | null = null;
  return {
    framePicture(file) {
      const image = nativeImage.createFromPath(file);
      if (image.isEmpty()) throw new Error(`The frame ${file} could not be read.`);
      const { width, height } = image.getSize();
      const shown = width > OUTPUT_WIDTH ? image.resize({ width: OUTPUT_WIDTH, quality: 'best' }) : image;
      return { picture: `data:image/jpeg;base64,${shown.toJPEG(92).toString('base64')}`, width, height };
    },
    async faces(file) {
      canvas ??= new ThumbnailCanvas(canvasPagePath(appRoot));
      return canvas.detectFaces(dataUrlOf(file));
    },
    photo(name, file) {
      const t = trimmedPhoto({ name, file });
      const image = nativeImage.createFromBuffer(t.png);
      const shown = t.height > PHOTO_PREVIEW_HEIGHT ? image.resize({ height: PHOTO_PREVIEW_HEIGHT, quality: 'best' }) : image;
      return { image: shown.toDataURL(), width: t.width, height: t.height };
    },
    logo(file) {
      const logo = readLogo(file);
      return { width: logo.width, height: logo.height, at: (w, h) => `data:image/png;base64,${logoAt(logo, w, h).toString('base64')}` };
    },
    border(file) {
      return `data:image/png;base64,${readBorder(file).png.toString('base64')}`;
    },
    close() {
      canvas?.close();
      canvas = null;
    },
  };
}

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
      userDataPath,
      appRoot: app.getAppPath(),
      ffmpeg: paths.ffmpeg,
      ffprobe: paths.ffprobe,
    }),
    holdJob: (what) => crucible.transport.job(what),
    aiManager: () => new AIManagerService({ promptSetsDir: path.join(app.getPath('userData'), 'prompt_sets') }),
    picture,
    photoList: () => look.photos().photos.map((p) => ({ name: p.name, preview: p.preview })),
    pieces: previewPieces(app.getAppPath()),
    progress: (event) => {
      if (progressTo !== null && !progressTo.isDestroyed()) progressTo.send('thumbnails:progress', event);
    },
    gpuVenue: () => crucible.lanes.gpuVenue(),
  });
  app.on('before-quit', () => {
    void report.quit();
  });

  // ── the window ──────────────────────────────────────────────────────────────
  ipcMain.handle('thumbnails:summary', (_e, jobId: string, itemId: string) => answer('reading the thumbnails', () => report.summary(jobId, itemId)));
  ipcMain.handle('thumbnails:item', (_e, jobId: string, itemId: string) => answer('reading the thumbnails', () => report.view(jobId, itemId)));
  ipcMain.handle('thumbnails:frame-detail', (_e, jobId: string, itemId: string, frameId: string) => answer('reading a frame', () => report.frameDetail(jobId, itemId, frameId)));
  ipcMain.handle('thumbnails:photo-detail', (_e, name: string) => answer('reading a reaction photo', () => report.photoDetail(name)));
  ipcMain.handle('thumbnails:save-cards', (event, jobId: string, itemId: string, cards: unknown) => {
    progressTo = event.sender;
    return answer('saving the thumbnails', () => report.saveCards(jobId, itemId, cards));
  });
  ipcMain.handle('thumbnails:pair-title', (event, jobId: string, itemId: string, pair: number, title: string, kind) => {
    progressTo = event.sender;
    return answer('rewriting the words', () => report.pairTitle(jobId, itemId, pair, title, kind));
  });
  ipcMain.handle('thumbnails:words', (event, jobId: string, itemId: string, pair: number, mode: 'new' | 'more') => {
    progressTo = event.sender;
    return answer('writing the words', () => report.writeWords(jobId, itemId, pair, mode));
  });
  ipcMain.handle('thumbnails:running', (_e, jobId: string, itemId: string) => answer('reading what is running', () => report.running(jobId, itemId)));
  ipcMain.handle('thumbnails:add-frames', (event, jobId: string, itemId: string, files: unknown) => {
    progressTo = event.sender;
    return answer('adding your images', () => report.addFrames(jobId, itemId, files));
  });
  ipcMain.handle('thumbnails:finish', (event, jobId: string, itemId: string) => {
    progressTo = event.sender;
    return answer('preparing the frames and text', () => report.finish(jobId, itemId));
  });
  ipcMain.handle('thumbnails:choose-frames', (event) => answer('choosing images', () => chooseFiles(event, true)));
  ipcMain.handle('thumbnails:closed', () => answer('closing the Thumbnails window', () => report.closed()));
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
  ipcMain.handle('thumbnails:border', () => answer('reading the border', () => look.border()));
  ipcMain.handle('thumbnails:choose-border', (event) =>
    answer('choosing the border file', async () => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const options = { properties: ['openFile' as const], filters: [{ name: 'PNG with a transparent middle', extensions: ['png'] }] };
      const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      if (picked.canceled || picked.filePaths.length === 0) return null;
      return look.setBorder(picked.filePaths[0]);
    }),
  );
}
