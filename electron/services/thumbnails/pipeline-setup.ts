/**
 * The metadata run's thumbnail setup, read AT JOB TIME (like the routing table): the saved look,
 * the app's paths, the editor's manifest builder and the renderer. Built by ipc-handlers for
 * 'generate-metadata' and 'send-held-prompt'. (It carried the Crucible doors for the frame scoring
 * until 2026-09-29; the words run on the job's own doors, pipeline.ts ThumbnailJobDoors.)
 *
 * The per-run switch: a request with `thumbnails: false` makes none, and every item's record says it
 * was switched off for this run. Anything else (absent included) is on: thumbnails are made by
 * default (Owen, 2026-09-28). The queue does not send the switch yet; phase 2 may add it to the
 * queue's options.
 *
 * A saved look that cannot be read does not stop the job: the run makes no thumbnails,
 * and every item's record says why and what to fix (the metadata is Owen's main deliverable).
 */
import * as log from 'electron-log';
import { PythonService } from '../editor/python-service';
import { DEFAULT_STYLE, readStoredStyle } from '../../shared/thumbnail-layout';
import { STYLE_STORE_KEY } from './look';
import type { ThumbnailRunChoice } from './pipeline';
import { electronThumbnailRenderer } from './pipeline-electron';

let python: PythonService | null = null;

export function thumbnailRunChoice(input: {
  /** The request's per-run switch: false turns thumbnails off for this run. */
  requested: unknown;
  store: { get(key: string): unknown };
  userDataPath: string;
  appRoot: string;
  ffmpeg: string;
  ffprobe: string;
}): ThumbnailRunChoice {
  if (input.requested === false) return { mode: 'off', reason: 'Thumbnails were switched off for this run.' };
  if (input.requested !== undefined && input.requested !== true) {
    throw new Error(`The request's thumbnails switch is ${JSON.stringify(input.requested)}; it is true, false or absent.`);
  }
  let style;
  let styleSaved: boolean;
  let styleLine: string | null = null;
  try {
    const stored = input.store.get(STYLE_STORE_KEY);
    styleSaved = stored !== undefined && stored !== null;
    if (styleSaved) {
      const read = readStoredStyle(stored);
      style = read.style;
      styleLine = read.line;
    } else {
      style = DEFAULT_STYLE;
    }
  } catch (err) {
    const reason = `The saved thumbnail look cannot be read (${err instanceof Error ? err.message : String(err)}), so no thumbnails were made. Fix the look in Thumbnail look (the Thumbnails window on the reports page, or Settings).`;
    log.warn(`[Thumbnails] ${reason}`);
    return { mode: 'off', reason };
  }
  return {
    mode: 'on',
    setup: {
      userDataPath: input.userDataPath,
      ffmpeg: input.ffmpeg,
      ffprobe: input.ffprobe,
      // The editor's own manifest builder (the same call the editor window makes), CPU only.
      manifest: (zipPath) => (python ??= new PythonService()).editorManifest(zipPath),
      openRenderer: () => electronThumbnailRenderer(input.appRoot),
      style,
      styleSaved,
      styleLine,
    },
  };
}
