/**
 * The Thumbnails tab's IPC (2026-09-28). Thin: every handler calls ThumbnailLab (lab-service.ts)
 * and answers `{ ok: true, value }` or `{ ok: false, error }` with the service's own sentence, so
 * the tab shows the refusal as written instead of Electron's "Error invoking remote method" prefix.
 *
 * Progress goes to the window that asked, on `thumbs:progress`.
 */
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { randomInt } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as log from 'electron-log';
import type Store from 'electron-store';
import type { CrucibleContext } from '../../crucible/context';
import { getRuntimePaths } from '../../lib/bridges/runtime-paths';
import { AIManagerService } from '../metadata/ai-manager.service';
import { PythonService } from '../editor/python-service';
import type { PublishStoreService } from '../publish/publish-store.service';
import { ThumbnailCanvas, canvasPagePath } from './canvas-page';
import { ThumbnailLab } from './lab-service';

type Answer<T> = { ok: true; value: T } | { ok: false; error: string };

async function answer<T>(what: string, fn: () => Promise<T> | T): Promise<Answer<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`[ThumbnailLab] ${what} failed: ${message}`);
    return { ok: false, error: message };
  }
}

export function setupThumbnailLabIpc(store: Store<any>, crucible: CrucibleContext, userDataPath: string, publishStore: PublishStoreService): void {
  let canvas: ThumbnailCanvas | null = null;
  let python: PythonService | null = null;
  let progressTo: Electron.WebContents | null = null;
  const paths = getRuntimePaths();
  const lab = new ThumbnailLab({
    store: { get: (key) => store.get(key), set: (key, value) => store.set(key, value) },
    userDataPath,
    ffmpeg: paths.ffmpeg,
    ffprobe: paths.ffprobe,
    canvas: () => (canvas ??= new ThumbnailCanvas(canvasPagePath(app.getAppPath()))),
    scorer: () => ({ lanes: crucible.lanes, transport: crucible.transport, clientFor: (server) => crucible.factory.clientFor(server) }),
    aiManager: () => new AIManagerService({ promptSetsDir: path.join(app.getPath('userData'), 'prompt_sets') }),
    publishStore,
    // The editor's own manifest builder (the same call the editor window makes), CPU only.
    manifest: (zipPath) => (python ??= new PythonService()).editorManifest(zipPath),
    progress: (event) => {
      if (progressTo !== null && !progressTo.isDestroyed()) progressTo.send('thumbs:progress', event);
    },
    // A photo draw's seed when the tab gives none; shown with the render so it can be repeated.
    newSeed: () => randomInt(1, 0x7fffffff),
  });
  app.on('before-quit', () => {
    canvas?.close();
    void lab.releaseTextHold('the app is quitting');
  });

  ipcMain.handle('thumbs:list-items', () => answer('listing items', () => lab.listItems()));
  ipcMain.handle('thumbs:find-frames', (event, req) => {
    progressTo = event.sender;
    return answer('finding frames', () => lab.findFrames(req));
  });
  ipcMain.handle('thumbs:frame-picture', (_e, runId: string, id: string) => answer('reading a frame', () => lab.framePicture(runId, id)));
  ipcMain.handle('thumbs:score', (event, runId: string) => {
    progressTo = event.sender;
    return answer('scoring frames', () => lab.score(runId));
  });
  ipcMain.handle('thumbs:stop', (_e, runId: string) => answer('stopping', () => lab.stop(runId)));
  ipcMain.handle('thumbs:words', (_e, runId: string, title: string) => answer('writing words', () => lab.words(runId, title)));
  ipcMain.handle('thumbs:get-style', () => answer('reading the look', () => lab.getStyle()));
  ipcMain.handle('thumbs:set-style', (_e, style: unknown) => answer('saving the look', () => lab.setStyle(style)));
  ipcMain.handle('thumbs:photos', () => answer('reading the reaction photos', () => lab.photos()));
  ipcMain.handle('thumbs:set-photo-note', (_e, name: string, note: string) => answer('saving a photo note', () => lab.setPhotoNote(name, note)));
  ipcMain.handle('thumbs:suggest', (_e, runId: string, variants) => answer('suggesting photos', () => lab.suggest(runId, variants)));
  ipcMain.handle('thumbs:combine', (_e, fav, how, rank) => answer('combining', () => lab.combine(fav, how, rank)));
  // "Add photos…": PNG files and/or folders (a folder adds its PNGs), copied into the app's library.
  // Returns the chosen paths with the outcome, so a refusal for names already there can be
  // confirmed and sent again with replace (thumbs:add-photos).
  ipcMain.handle('thumbs:choose-photos', (event) =>
    answer('adding reaction photos', async () => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const options = {
        properties: ['openFile' as const, 'openDirectory' as const, 'multiSelections' as const],
        filters: [{ name: 'PNG cut-outs', extensions: ['png'] }],
      };
      const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      if (picked.canceled || picked.filePaths.length === 0) return null;
      return { chosen: picked.filePaths, ...lab.addPhotos(picked.filePaths, false) };
    }),
  );
  ipcMain.handle('thumbs:add-photos', (_e, chosen: string[], replace: boolean) =>
    answer('adding reaction photos', () => ({ chosen, ...lab.addPhotos(chosen, replace) })));
  ipcMain.handle('thumbs:remove-photo', (_e, name: string) => answer('removing a reaction photo', () => lab.removePhoto(name)));
  ipcMain.handle('thumbs:copy-old-photos', () => answer('copying the reaction photos into the app', () => lab.copyOldPhotos()));
  ipcMain.handle('thumbs:copy-old-logo', () => answer('copying the logo into the app', () => lab.copyOldLogo()));
  ipcMain.handle('thumbs:release-model', () => answer('releasing the text model', () => lab.releaseTextHold('the Thumbnails tab was left')));
  ipcMain.handle('thumbs:render', (event, runId: string, variants, options) => {
    progressTo = event.sender;
    return answer('rendering', () => lab.render(runId, variants, options));
  });
  ipcMain.handle('thumbs:logo', () => answer('reading the logo', () => lab.logo()));
  ipcMain.handle('thumbs:choose-logo', (event) =>
    answer('choosing the logo file', async () => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const options = { properties: ['openFile' as const], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }] };
      const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      if (picked.canceled || picked.filePaths.length === 0) return null;
      return lab.setLogo(picked.filePaths[0]);
    }),
  );
  ipcMain.handle('thumbs:story-state', (_e, jobId: string, itemId: string) => answer('reading the story link', () => lab.storyState(jobId, itemId)));
  ipcMain.handle('thumbs:link-story', (_e, jobId: string, itemId: string, projectFolder: string, storyNumber: number, storySlug: string) =>
    answer('linking the story', () => lab.linkStory(jobId, itemId, projectFolder, storyNumber, storySlug)));
  ipcMain.handle('thumbs:choose-project', (event) =>
    answer('choosing an editor project folder', async () => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const options = { properties: ['openDirectory' as const] };
      const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      return picked.canceled || picked.filePaths.length === 0 ? null : lab.storiesIn(picked.filePaths[0]);
    }),
  );
  ipcMain.handle('thumbs:show-folder', (_e, folder: string) =>
    answer('opening the folder', async () => {
      if (!fs.existsSync(folder)) throw new Error(`The folder is not there: ${folder}`);
      const error = await shell.openPath(folder);
      if (error) throw new Error(error);
    }),
  );
}
