/**
 * The metadata run's thumbnail setup, read AT JOB TIME (like the routing table): the saved look,
 * Owen's photo notes, the app's paths, the editor's manifest builder, the Crucible doors, and the
 * renderer. Built by ipc-handlers for 'generate-metadata' and 'send-held-prompt'.
 *
 * The per-run switch: a request with `thumbnails: false` makes none, and every item's record says it
 * was switched off for this run. Anything else (absent included) is on: thumbnails are made by
 * default (Owen, 2026-09-28). The queue does not send the switch yet; phase 2 may add it to the
 * queue's options.
 *
 * A saved look or photo notes that cannot be read do not stop the job: the run makes no thumbnails,
 * and every item's record says why and what to fix (the metadata is Owen's main deliverable).
 */
import * as log from 'electron-log';
import type { CrucibleContext } from '../../crucible/context';
import { PythonService } from '../editor/python-service';
import { DEFAULT_STYLE, validateStyle } from './layout';
import { PHOTO_NOTES_STORE_KEY, STYLE_STORE_KEY } from './lab-service';
import type { ThumbnailRunChoice } from './pipeline';
import { electronThumbnailRenderer } from './pipeline-electron';

let python: PythonService | null = null;

function notesOf(stored: unknown): Record<string, string> {
  if (stored === undefined || stored === null) return {};
  if (typeof stored !== 'object' || Array.isArray(stored) || Object.values(stored).some((v) => typeof v !== 'string')) {
    throw new Error(`the saved reaction photo notes are not a list of name: note (${JSON.stringify(stored).slice(0, 120)})`);
  }
  return stored as Record<string, string>;
}

export function thumbnailRunChoice(input: {
  /** The request's per-run switch: false turns thumbnails off for this run. */
  requested: unknown;
  store: { get(key: string): unknown };
  crucible: Pick<CrucibleContext, 'lanes' | 'transport' | 'factory'>;
  userDataPath: string;
  appRoot: string;
  ffmpeg: string;
  ffprobe: string;
  newSeed: () => number;
}): ThumbnailRunChoice {
  if (input.requested === false) return { mode: 'off', reason: 'Thumbnails were switched off for this run.' };
  if (input.requested !== undefined && input.requested !== true) {
    throw new Error(`The request's thumbnails switch is ${JSON.stringify(input.requested)}; it is true, false or absent.`);
  }
  let style;
  let styleSaved: boolean;
  let photoNotes: Record<string, string>;
  try {
    const stored = input.store.get(STYLE_STORE_KEY);
    styleSaved = stored !== undefined && stored !== null;
    style = styleSaved ? validateStyle(stored) : DEFAULT_STYLE;
    photoNotes = notesOf(input.store.get(PHOTO_NOTES_STORE_KEY));
  } catch (err) {
    const reason = `The Thumbnails tab's saved settings cannot be read (${err instanceof Error ? err.message : String(err)}), so no thumbnails were made. Fix the look or the photo notes on the Thumbnails tab.`;
    log.warn(`[Thumbnails] ${reason}`);
    return { mode: 'off', reason };
  }
  const { crucible } = input;
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
      photoNotes,
      newSeed: input.newSeed,
      doors: { lanes: crucible.lanes, transport: crucible.transport, clientFor: (server) => crucible.factory.clientFor(server) },
    },
  };
}
