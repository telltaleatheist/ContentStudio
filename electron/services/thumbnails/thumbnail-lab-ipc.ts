/**
 * The Thumbnails tab's IPC (2026-09-28). Thin: every handler calls ThumbnailLab (lab-service.ts)
 * and answers `{ ok: true, value }` or `{ ok: false, error }` with the service's own sentence, so
 * the tab shows the refusal as written instead of Electron's "Error invoking remote method" prefix.
 *
 * Progress goes to the window that asked, on `thumbs:progress`.
 */
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
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
  });
  app.on('before-quit', () => canvas?.close());

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
  ipcMain.handle('thumbs:choose-photo-folder', (event) =>
    answer('choosing the reaction photos folder', async () => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const options = { properties: ['openDirectory' as const] };
      const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      if (picked.canceled || picked.filePaths.length === 0) return null;
      return lab.setPhotoFolder(picked.filePaths[0]);
    }),
  );
  ipcMain.handle('thumbs:render', (_e, runId: string, variants) => answer('rendering', () => lab.render(runId, variants)));
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
