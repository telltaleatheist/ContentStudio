/**
 * Stream marks IPC — the channels, the push event, and the global hotkey.
 *
 * Registered in one call the way setupSpreakerIpc is, and namespaced `stream-marks:*`.
 *
 * THE PUSH EVENT IS THE POINT. The hotkey fires while ContentStudio is behind OBS and a
 * browser; by the time the Stream marks tab is looked at again it must already show the
 * mark. So every mutation — including the ones a renderer asked for — broadcasts
 * `stream-marks:changed` to EVERY window, carrying the whole session after the change.
 * The tab never polls and never re-reads on a timer.
 *
 * THE HOTKEY IS GLOBAL because the alternative is the thing this feature replaces: alt-tab
 * to the app, find the window, click the button, alt-tab back — during a live stream. It
 * is `globalShortcut`, so it works with no window focused, and its registration status is
 * a first-class value (`stream-marks:hotkey-status`) rather than a log line: a shortcut
 * another app has already taken fails SILENTLY at the OS level, and a silent failure here
 * means a night of stories with no boundaries. The tab shows it in red.
 */

import { app, BrowserWindow, Notification, globalShortcut, ipcMain } from 'electron';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as log from 'electron-log';
import * as path from 'path';
import Store from 'electron-store';

import {
  StreamMarksChange,
  StreamMarkSource,
  StreamMarksService,
} from './stream-marks.service';
import { MASTER_EXTENSIONS, MASTER_PATTERN } from '../editor/editor-ipc';
import { getRuntimePaths } from '../../lib/bridges/runtime-paths';

/**
 * The shipped hotkey. An unset `streamMarksHotkey` is not a missing value — it is this
 * accelerator, until the operator changes it — so reading it with this as the unset case is
 * a declared default and not a fallback for a failed read. A hotkey stored and REFUSED by
 * the OS is a different thing entirely, and that one is reported, never re-defaulted.
 */
export const DEFAULT_STREAM_MARKS_HOTKEY = 'CommandOrControl+Shift+M';
const HOTKEY_SETTING_KEY = 'streamMarksHotkey';

/** What the tab prints beside the hotkey: green when ready, the OS's own reason when not. */
export interface StreamMarksHotkeyStatus {
  accelerator: string;
  registered: boolean;
  /** Non-null exactly when registered is false. Shown verbatim. */
  error: string | null;
}

/**
 * The master video of a loaded session, and the two file times that can date it.
 *
 * BOTH TIMES COME BACK, and the choice between them is made in the dialog where it can be
 * SAID. `birthtime` is the creation time and the one that dates a recording; filesystems
 * that do not keep one report the epoch, and a 1970 date silently proposing an offset of
 * fifty-six years is exactly the kind of quiet default this codebase does not ship. Null
 * here means "this filesystem has no creation time for this file", and the dialog then
 * says it is dating the master by its modification time.
 */
export interface MasterFileTimes {
  masterPath: string;
  birthtimeIso: string | null;
  mtimeIso: string;
  /**
   * The master's own length in seconds, from ffprobe.
   *
   * THE RECORDING'S LENGTH, NOT THE TIMELINE'S, and the difference is the whole point: the
   * processing step drops dead air, so the editor's timeline is minutes SHORTER than the file
   * it was cut from (measured 2026-09-14: 11785 s of master, 9869 s of timeline, 1916 s
   * dropped). Reading the file time as the moment the recording ENDED means subtracting the
   * recording's length to find its start, and subtracting the timeline's length instead puts
   * that start half an hour wrong — which is exactly what the import used to do.
   */
  durationSeconds: number;
}

/** Every window, because the tab and the editor's import dialog are two of them. */
function broadcast(change: StreamMarksChange): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send('stream-marks:changed', change);
  }
}

/**
 * The master's duration, straight from ffprobe. Rejects rather than guessing.
 *
 * The binary comes from lib/bridges/runtime-paths (the one place that knows where ffmpeg's
 * tools live, packaged or not). `-v error` is deliberate: it leaves stderr empty on success and
 * carrying the reason on failure, and the reason is what goes into the throw — a duration that
 * quietly came back 0 would propose a stream start half a night out with nothing on screen to
 * say why (LEDGER law 1).
 */
function probeDurationSeconds(file: string): Promise<number> {
  const ffprobe = getRuntimePaths().ffprobe;
  return new Promise<number>((resolve, reject) => {
    const proc = spawn(ffprobe, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      file,
    ]);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => {
      reject(new Error(
        `Could not run ffprobe at ${ffprobe} to measure ${file}: ${err.message}`
      ));
    });
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(
          `ffprobe exited with code ${code} measuring ${file}: ${stderr.trim() || '(no stderr)'}`
        ));
        return;
      }
      const seconds = Number(stdout.trim());
      if (!Number.isFinite(seconds) || seconds <= 0) {
        reject(new Error(
          `ffprobe reported no usable duration for ${file} (read "${stdout.trim()}"): ` +
          (stderr.trim() || 'no error text')
        ));
        return;
      }
      resolve(seconds);
    });
  });
}

/** hh:mm:ss for the desktop notification — the same shape the tab's rows are edited in. */
function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

export function setupStreamMarksIpc(store: Store<any>, service: StreamMarksService): void {
  if (!store || typeof (store as any).get !== 'function') {
    throw new Error('setupStreamMarksIpc requires the electron-store instance — the hotkey lives in it.');
  }
  if (!service || typeof service.listSessions !== 'function') {
    throw new Error('setupStreamMarksIpc requires a StreamMarksService.');
  }

  // ── Sessions and marks ──────────────────────────────────────────────────────
  //
  // No Result envelope on any of these: a failure here is a sentence naming a file or an id
  // and the renderer prints the rejection. Wrapping it would make every caller unwrap a
  // success that cannot be partial.

  ipcMain.handle('stream-marks:list', async () => service.listSessions());

  ipcMain.handle('stream-marks:get', async (_e, id: string) => service.getSession(id));

  ipcMain.handle('stream-marks:live', async () => service.getLiveSession());

  ipcMain.handle('stream-marks:start', async () => {
    const result = service.startSession();
    // A Start that found one already live changed NOTHING on disk, so it broadcasts nothing.
    // A change event for a non-change is how two windows end up fighting over focus.
    if (!result.alreadyLive) {
      broadcast({
        sessionId: result.session.id,
        session: result.session,
        reason: 'session-started',
        markId: null,
        source: 'window',
      });
    }
    return result;
  });

  ipcMain.handle('stream-marks:end', async (_e, id: string) => {
    const session = service.endSession(id);
    broadcast({ sessionId: session.id, session, reason: 'session-ended', markId: null, source: 'window' });
    return session;
  });

  ipcMain.handle(
    'stream-marks:add-mark',
    async (_e, payload: { sessionId?: string | null; at?: number; label?: string }) => {
      const input = payload || {};
      const sessionId = input.sessionId === undefined ? null : input.sessionId;
      return addMark(sessionId, { at: input.at, label: input.label }, 'window');
    }
  );

  ipcMain.handle(
    'stream-marks:insert-mark',
    async (_e, payload: { sessionId: string; at: number; label: string }) => {
      const { session, mark } = service.insertMark(payload.sessionId, { at: payload.at, label: payload.label });
      broadcast({ sessionId: session.id, session, reason: 'mark-inserted', markId: mark.id, source: 'window' });
      return { session, mark };
    }
  );

  ipcMain.handle(
    'stream-marks:update-mark',
    async (_e, payload: { sessionId: string; markId: string; at?: number; label?: string }) => {
      const patch: { at?: number; label?: string } = {};
      if (payload.at !== undefined) patch.at = payload.at;
      if (payload.label !== undefined) patch.label = payload.label;
      const { session, mark } = service.updateMark(payload.sessionId, payload.markId, patch);
      broadcast({ sessionId: session.id, session, reason: 'mark-updated', markId: mark.id, source: 'window' });
      return { session, mark };
    }
  );

  ipcMain.handle('stream-marks:delete-mark', async (_e, payload: { sessionId: string; markId: string }) => {
    const session = service.deleteMark(payload.sessionId, payload.markId);
    broadcast({ sessionId: session.id, session, reason: 'mark-deleted', markId: payload.markId, source: 'window' });
    return session;
  });

  ipcMain.handle('stream-marks:update-session', async (_e, payload: { sessionId: string; startedAt?: string }) => {
    const patch: { startedAt?: string } = {};
    if (payload.startedAt !== undefined) patch.startedAt = payload.startedAt;
    const session = service.updateSession(payload.sessionId, patch);
    broadcast({ sessionId: session.id, session, reason: 'session-updated', markId: null, source: 'window' });
    return session;
  });

  ipcMain.handle('stream-marks:delete-session', async (_e, id: string) => {
    service.deleteSession(id);
    broadcast({ sessionId: id, session: null, reason: 'session-deleted', markId: null, source: 'window' });
    return { deleted: id };
  });

  // ── The master video's file times (the editor's offset proposal) ────────────

  /**
   * Lives HERE rather than with the editor's own channels because it exists for exactly one
   * caller — the stream-marks import dialog — and because the whole feature is then one
   * directory to lift out. It reads the master the same way the project scan does, through
   * the pattern that scan exports, so the two cannot disagree about which file is the master.
   */
  ipcMain.handle('stream-marks:master-file-times', async (_e, payload: { zipPath: string }): Promise<MasterFileTimes> => {
    const zipPath = payload?.zipPath;
    if (typeof zipPath !== 'string' || zipPath.trim() === '') {
      throw new Error('stream-marks:master-file-times needs the loaded session\'s compounds zip path.');
    }
    const folder = path.dirname(zipPath);
    if (!fs.existsSync(folder)) {
      throw new Error(`The project folder ${folder} is not there — is its volume mounted?`);
    }
    const masters = fs.readdirSync(folder).filter((name) => {
      const ext = path.extname(name).toLowerCase();
      if (!MASTER_EXTENSIONS.includes(ext)) return false;
      return MASTER_PATTERN.test(path.basename(name, path.extname(name)));
    });
    if (masters.length === 0) {
      throw new Error(
        `No master video in ${folder} — looked for a file named "<session> master" with extension ` +
        MASTER_EXTENSIONS.join('/') + '. Without it there is no file date to offset the marks against.'
      );
    }
    if (masters.length > 1) {
      throw new Error(
        `${masters.length} master videos in ${folder} — exactly one is required, found: ${masters.join(', ')}`
      );
    }
    const masterPath = path.join(folder, masters[0]);
    const stat = fs.statSync(masterPath);
    // Awaited here rather than in the renderer so one call answers the dialog's whole question:
    // which file, when it was written, and how long it runs.
    const durationSeconds = await probeDurationSeconds(masterPath);
    // Epoch zero is how a filesystem without a creation time answers birthtime. Treated as
    // "no answer" and reported as null — see MasterFileTimes.
    const birthMs = stat.birthtime.getTime();
    return {
      masterPath,
      birthtimeIso: Number.isFinite(birthMs) && birthMs > 0 ? stat.birthtime.toISOString() : null,
      mtimeIso: stat.mtime.toISOString(),
      durationSeconds,
    };
  });

  // ── The global hotkey ───────────────────────────────────────────────────────

  let status: StreamMarksHotkeyStatus = { accelerator: readStoredHotkey(), registered: false, error: null };

  function readStoredHotkey(): string {
    const stored = (store as any).get(HOTKEY_SETTING_KEY);
    if (stored === undefined || stored === null) return DEFAULT_STREAM_MARKS_HOTKEY;
    if (typeof stored !== 'string' || stored.trim() === '') {
      throw new Error(
        `The stored ${HOTKEY_SETTING_KEY} setting is not an accelerator string: ${JSON.stringify(stored)}`
      );
    }
    return stored;
  }

  /** One place adds marks, so the notification and the broadcast cannot diverge by path. */
  function addMark(
    sessionId: string | null,
    input: { at?: number; label?: string },
    source: StreamMarkSource
  ) {
    const { session, mark } = service.addMark(sessionId, input);
    broadcast({ sessionId: session.id, session, reason: 'mark-added', markId: mark.id, source });
    return { session, mark };
  }

  /**
   * The notification IS the feedback. Owen is looking at OBS; without it the only way to
   * know the key landed is to switch windows, which is the switch this hotkey removes.
   */
  function notify(title: string, body: string): void {
    if (Notification.isSupported()) {
      new Notification({ title, body, silent: false }).show();
    } else {
      // Declared, not swallowed (law 8): the press was still recorded, and this says why
      // nothing appeared on screen.
      log.warn(`[StreamMarks] "${title}" recorded but the desktop Notification API is unavailable on this system`);
    }
  }

  /**
   * THE FIRST PRESS OF THE NIGHT IS THE START, and only the start. With nothing live the
   * key starts a session and drops no mark: a mark at 00:00:00 would be a boundary nobody
   * pressed, shown as row 1 on the tab and as an empty story in the import. Every later
   * press is a mark at the elapsed time.
   */
  function onHotkey(): void {
    try {
      if (!service.getLiveSession()) {
        const { session } = service.startSession();
        broadcast({ sessionId: session.id, session, reason: 'session-started', markId: null, source: 'hotkey' });
        notify('Stream started', `Press ${status.accelerator} again when the first story ends.`);
        log.info(`[StreamMarks] hotkey started session ${session.id}`);
        return;
      }
      const { session, mark } = addMark(null, {}, 'hotkey');
      const number = session.marks.findIndex((m) => m.id === mark.id) + 1;
      notify(`Mark ${number} at ${formatElapsed(mark.at)}`, `${session.marks.length} mark${session.marks.length === 1 ? '' : 's'} this stream.`);
      log.info(`[StreamMarks] hotkey mark ${number} at ${formatElapsed(mark.at)} in session ${session.id}`);
    } catch (err: any) {
      // A throw inside a globalShortcut callback has nowhere to go — there is no renderer
      // waiting on it. Logged loudly AND pushed to the windows as a hotkey error, so the tab
      // stops claiming the hotkey is fine while it is dropping presses.
      const message = err?.message || String(err);
      log.error('[StreamMarks] hotkey press failed:', message);
      status = { accelerator: status.accelerator, registered: status.registered, error: message };
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('stream-marks:hotkey-status', status);
      }
    }
  }

  /**
   * Register `accelerator`, replacing whatever is registered now.
   *
   * `globalShortcut.register` returns FALSE when another application owns the combination —
   * it does not throw — and an invalid accelerator string throws. Both end up in `status`
   * with a sentence, and neither one substitutes a different key: a hotkey silently moved to
   * something else is a hotkey the operator presses all night with nothing happening.
   */
  function applyHotkey(accelerator: string): StreamMarksHotkeyStatus {
    if (status.registered && globalShortcut.isRegistered(status.accelerator)) {
      globalShortcut.unregister(status.accelerator);
    }
    try {
      const ok = globalShortcut.register(accelerator, onHotkey);
      status = ok
        ? { accelerator, registered: true, error: null }
        : {
            accelerator,
            registered: false,
            error: `The system refused the shortcut ${accelerator} — another application already owns it. ` +
              'Pick a different one; marks can still be added with the Mark button.',
          };
    } catch (err: any) {
      status = {
        accelerator,
        registered: false,
        error: `The shortcut ${accelerator} could not be registered: ${err?.message || String(err)}`,
      };
    }
    if (status.registered) {
      log.info(`[StreamMarks] global hotkey registered: ${accelerator}`);
    } else {
      log.error(`[StreamMarks] global hotkey NOT registered: ${status.error}`);
    }
    return status;
  }

  ipcMain.handle('stream-marks:hotkey-status', async () => status);

  ipcMain.handle('stream-marks:set-hotkey', async (_e, accelerator: string) => {
    if (typeof accelerator !== 'string' || accelerator.trim() === '') {
      throw new Error(`A stream-marks hotkey must be a non-empty accelerator string, got ${JSON.stringify(accelerator)}.`);
    }
    const next = applyHotkey(accelerator.trim());
    // Stored even when the OS refused it: the operator typed it, and losing what they typed
    // on every restart would hide the refusal behind a working default.
    (store as any).set(HOTKEY_SETTING_KEY, next.accelerator);
    return next;
  });

  applyHotkey(status.accelerator);

  // Unregister OURS, not unregisterAll(): this is the only globalShortcut in the app today
  // and a blanket unregister would quietly take any future one with it.
  app.on('will-quit', () => {
    if (globalShortcut.isRegistered(status.accelerator)) {
      globalShortcut.unregister(status.accelerator);
      log.info(`[StreamMarks] global hotkey released: ${status.accelerator}`);
    }
  });
}
