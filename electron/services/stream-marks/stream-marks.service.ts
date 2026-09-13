/**
 * Stream marks — the store behind the Notepad file Owen used to keep while streaming.
 *
 * While a stream runs he notes the moment each story ENDS and a word or two naming it
 * ("fox news", "intelligent design"). The next day the stream master is opened in the
 * timeline editor and those notes are redrawn as stories by hand. This service is the
 * first half of replacing that: the marks themselves, owned by the main process so a
 * global hotkey can add one while the app is not even the front window.
 *
 * THE MAIN PROCESS IS THE SOURCE OF TRUTH, and there is no in-memory cache of the
 * sessions. Every read reads the directory and every mutation writes the file through
 * before it returns. Two windows (the Stream marks tab and the editor's import dialog)
 * plus a hotkey that fires when neither is focused would otherwise be three copies of the
 * same list, and the one a crash keeps is the one on disk.
 *
 * TIME IS KEPT TWO WAYS AND THEY MEAN DIFFERENT THINGS:
 *   - `startedAt` is WALL CLOCK (ISO). It is what lets the editor propose an offset from
 *     the master video's own file time, and it is editable because Start gets pressed late.
 *   - `at` is ELAPSED SECONDS since `startedAt`. Marks keep their elapsed value when
 *     `startedAt` moves (see updateSession) — that is the whole point of the correction:
 *     one edit shifts every story together, which is exactly the error a late Start makes.
 *
 * NO FALLBACKS (LEDGER law 1). A corrupt session file throws with its path; a session id
 * that does not exist throws with the id; a mark time that is not a finite number throws
 * with the value. Nothing here defaults quietly, because every value in it is a boundary
 * between two stories in a video that gets published.
 */

import * as fs from 'fs';
import * as path from 'path';

/** One boundary: Owen pressed the key, `at` seconds into the stream, and `label` is what just ended. */
export interface StreamMark {
  id: string;
  /** ELAPSED seconds since the session's startedAt. Never a wall-clock instant. */
  at: number;
  /** One or two words, or '' when the hotkey fired and the naming has not happened yet. */
  label: string;
}

export interface StreamMarkSession {
  /** ISO start instant, filesystem-safe (e.g. 2026-09-13T19-02-33Z). Also the file name. */
  id: string;
  /** ISO wall clock of the session start. EDITABLE — see updateSession. */
  startedAt: string;
  /** ISO wall clock of End stream, or null while the session is live. */
  endedAt: string | null;
  /** Kept sorted by `at`, ascending. Story order is this order. */
  marks: StreamMark[];
}

/** What the past-sessions list needs, without reading every mark into the renderer. */
export interface StreamMarkSessionSummary {
  id: string;
  startedAt: string;
  endedAt: string | null;
  markCount: number;
}

/**
 * Where a change came from, because the two want different things from the UI: a mark
 * added by the button in the Stream marks tab should put the caret in its label straight
 * away, and a mark added by the global hotkey should wait until that window is looked at
 * again — moving focus in a window nobody is in front of steals the next keystroke.
 */
export type StreamMarkSource = 'window' | 'hotkey';

/**
 * The push payload (`stream-marks:changed`). A TYPE, not a prose contract (LEDGER law 10):
 * the tab decides what to re-render and what to focus from these fields alone.
 */
export interface StreamMarksChange {
  sessionId: string;
  /** The session AFTER the change, or null when the change was its deletion. */
  session: StreamMarkSession | null;
  reason:
    | 'session-started'
    | 'session-ended'
    | 'session-updated'
    | 'session-deleted'
    | 'mark-added'
    | 'mark-inserted'
    | 'mark-updated'
    | 'mark-deleted';
  /** The mark this change is about, when it is about one. */
  markId: string | null;
  source: StreamMarkSource;
}

/** start() tells the caller whether it made a session or handed back the one already live. */
export interface StreamMarkStartResult {
  session: StreamMarkSession;
  alreadyLive: boolean;
  /** Non-null exactly when alreadyLive — the sentence the UI shows verbatim. */
  message: string | null;
}

/** Mark mutations hand back the session they changed AND the mark, so the UI can focus it. */
export interface StreamMarkResult {
  session: StreamMarkSession;
  mark: StreamMark;
}

/**
 * Mark ids are unique within a process run and readable in a log. Date.now() alone
 * collides when the hotkey is hit twice inside a millisecond (it can be — key repeat),
 * so the counter is what actually guarantees it.
 */
let markSeq = 0;
function mintMarkId(): string {
  markSeq += 1;
  return `mark-${Date.now().toString(36)}-${markSeq}`;
}

/** ISO instant with the characters a filesystem dislikes removed, seconds resolution. */
function sessionIdFor(instant: Date): string {
  return instant.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
}

export class StreamMarksService {
  private readonly dir: string;

  constructor(baseDir: string) {
    if (typeof baseDir !== 'string' || baseDir.trim() === '') {
      throw new Error('StreamMarksService requires a base directory path.');
    }
    this.dir = baseDir;
    // Created up front rather than on first write: `list()` is the first call the tab makes
    // and an ENOENT there would be indistinguishable from "no sessions yet", which is a real
    // and legitimate answer. With the directory guaranteed, an empty read means empty.
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /** The file one session lives in. */
  private fileFor(id: string): string {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new Error('A stream-mark session id must be a non-empty string.');
    }
    // The id becomes a path segment, so it may not contain one. An id from anywhere but
    // this service's own minting is a bug or an attack; either way it is named, not cleaned.
    if (id.includes('/') || id.includes('\\') || id.includes('..')) {
      throw new Error(`Refusing a stream-mark session id that is not a plain file name: ${JSON.stringify(id)}`);
    }
    return path.join(this.dir, `${id}.json`);
  }

  /** Parse and validate one session file. Throws with the path on anything unexpected. */
  private readFile(file: string): StreamMarkSession {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err: any) {
      throw new Error(`Cannot read the stream-mark session file ${file}: ${err?.message || String(err)}`);
    }
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch (err: any) {
      throw new Error(`The stream-mark session file ${file} is not valid JSON: ${err?.message || String(err)}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`The stream-mark session file ${file} does not hold an object.`);
    }
    if (typeof parsed.id !== 'string' || parsed.id.trim() === '') {
      throw new Error(`The stream-mark session file ${file} has no id.`);
    }
    if (typeof parsed.startedAt !== 'string' || Number.isNaN(Date.parse(parsed.startedAt))) {
      throw new Error(`The stream-mark session file ${file} has an unreadable startedAt: ${JSON.stringify(parsed.startedAt)}`);
    }
    if (parsed.endedAt !== null && (typeof parsed.endedAt !== 'string' || Number.isNaN(Date.parse(parsed.endedAt)))) {
      throw new Error(`The stream-mark session file ${file} has an unreadable endedAt: ${JSON.stringify(parsed.endedAt)}`);
    }
    if (!Array.isArray(parsed.marks)) {
      throw new Error(`The stream-mark session file ${file} has no marks array.`);
    }
    parsed.marks.forEach((m: any, i: number) => {
      if (!m || typeof m !== 'object') {
        throw new Error(`Mark ${i} in ${file} is not an object.`);
      }
      if (typeof m.id !== 'string' || m.id.trim() === '') {
        throw new Error(`Mark ${i} in ${file} has no id.`);
      }
      if (typeof m.at !== 'number' || !Number.isFinite(m.at)) {
        throw new Error(`Mark ${m.id} in ${file} has a non-numeric time: ${JSON.stringify(m.at)}`);
      }
      if (typeof m.label !== 'string') {
        throw new Error(`Mark ${m.id} in ${file} has a non-string label: ${JSON.stringify(m.label)}`);
      }
    });
    const session: StreamMarkSession = {
      id: parsed.id,
      startedAt: parsed.startedAt,
      endedAt: parsed.endedAt,
      marks: parsed.marks.slice(),
    };
    // Sorted on the way out as well as on the way in: a file hand-edited out of order would
    // otherwise renumber the stories silently the first time it was written back.
    session.marks.sort((a, b) => a.at - b.at);
    return session;
  }

  private writeFile(session: StreamMarkSession): void {
    session.marks.sort((a, b) => a.at - b.at);
    const file = this.fileFor(session.id);
    fs.writeFileSync(file, JSON.stringify(session, null, 2), 'utf8');
  }

  /** Every session on disk, newest first. Reads every file — a corrupt one throws by name. */
  listSessions(): StreamMarkSessionSummary[] {
    const names = fs.readdirSync(this.dir).filter((n) => n.endsWith('.json'));
    const sessions = names.map((n) => this.readFile(path.join(this.dir, n)));
    sessions.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    return sessions.map((s) => ({
      id: s.id,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      markCount: s.marks.length,
    }));
  }

  /** One session in full. Throws when the id names no file — never returns null. */
  getSession(id: string): StreamMarkSession {
    const file = this.fileFor(id);
    if (!fs.existsSync(file)) {
      throw new Error(`There is no stream-mark session with id ${id} (looked for ${file}).`);
    }
    return this.readFile(file);
  }

  /**
   * The one session with no endedAt, or null.
   *
   * TWO live sessions is an invariant violation, not a preference: `start()` refuses to make
   * a second one, so the only way to get there is an edited file or a crash mid-write. Both
   * files are named rather than one being picked, because picking would silently send the
   * next hotkey press into whichever file sorted first.
   */
  getLiveSession(): StreamMarkSession | null {
    const names = fs.readdirSync(this.dir).filter((n) => n.endsWith('.json'));
    const live = names
      .map((n) => this.readFile(path.join(this.dir, n)))
      .filter((s) => s.endedAt === null);
    if (live.length > 1) {
      throw new Error(
        `${live.length} stream-mark sessions are live at once, which cannot happen through the app: ` +
        live.map((s) => this.fileFor(s.id)).join(', ') +
        ' — end or delete all but one before adding marks.'
      );
    }
    return live.length === 1 ? live[0] : null;
  }

  /**
   * Begin a session. A second Start while one is live is NOT an error the operator needs to
   * fix — it is him pressing the button he already pressed — so it hands back the live one
   * with the sentence saying so, and nothing on disk moves.
   */
  startSession(now: Date = new Date()): StreamMarkStartResult {
    const live = this.getLiveSession();
    if (live) {
      return {
        session: live,
        alreadyLive: true,
        message: `A stream started at ${live.startedAt} is already live with ${live.marks.length} mark(s); ` +
          'end it before starting another.',
      };
    }
    const id = sessionIdFor(now);
    const file = this.fileFor(id);
    if (fs.existsSync(file)) {
      throw new Error(`A stream-mark session file for this second already exists: ${file}`);
    }
    const session: StreamMarkSession = { id, startedAt: now.toISOString(), endedAt: null, marks: [] };
    this.writeFile(session);
    return { session, alreadyLive: false, message: null };
  }

  /** End a live session. Ending one that already ended throws — it names a stale window. */
  endSession(id: string, now: Date = new Date()): StreamMarkSession {
    const session = this.getSession(id);
    if (session.endedAt !== null) {
      throw new Error(`The stream-mark session ${id} already ended at ${session.endedAt}.`);
    }
    session.endedAt = now.toISOString();
    this.writeFile(session);
    return session;
  }

  /**
   * Add a mark.
   *
   * `sessionId` null means "the live session", and when there is none this THROWS. It does
   * not start one: a session that begins with a mark at 00:00:00 is a session whose first
   * row is a boundary nobody pressed, which then shows up in the import as an empty story.
   * Starting is startSession()'s job; the hotkey handler calls it when nothing is live, so
   * the first press of the night is the start and the SECOND press is the first mark.
   *
   * `at` omitted means now − startedAt. It is rounded to whole seconds because a story
   * boundary is not a sub-second quantity and the row edits it as hh:mm:ss.
   */
  addMark(
    sessionId: string | null,
    input: { at?: number; label?: string },
    now: Date = new Date()
  ): StreamMarkResult {
    let session: StreamMarkSession;
    if (sessionId === null) {
      const live = this.getLiveSession();
      if (!live) {
        throw new Error('No stream is live, so there is nothing to mark — press Start (or the hotkey once) first.');
      }
      session = live;
    } else {
      session = this.getSession(sessionId);
    }

    let at: number;
    if (input.at === undefined) {
      at = Math.round((now.getTime() - Date.parse(session.startedAt)) / 1000);
      // A mark before the session started is arithmetic nobody asked for: it happens only if
      // startedAt was corrected FORWARD past the present. Clamped at zero and named, because
      // the alternative is a negative elapsed time flowing into the import as a story that
      // starts before the stream did.
      if (at < 0) at = 0;
    } else {
      at = this.requireTime(input.at, 'at');
    }
    const label = this.requireLabel(input.label === undefined ? '' : input.label);

    const mark: StreamMark = { id: mintMarkId(), at, label };
    session.marks.push(mark);
    this.writeFile(session);
    return { session, mark };
  }

  /**
   * Insert a mark at an explicit time in an explicit session — the "insert before" row
   * affordance, for a boundary that was missed entirely. Distinct from addMark because the
   * time is REQUIRED here: an insert with no time would silently become "now", which in a
   * session that ended yesterday is a mark past the end of the stream.
   */
  insertMark(sessionId: string, input: { at: number; label: string }): StreamMarkResult {
    const session = this.getSession(sessionId);
    const mark: StreamMark = {
      id: mintMarkId(),
      at: this.requireTime(input.at, 'at'),
      label: this.requireLabel(input.label),
    };
    session.marks.push(mark);
    this.writeFile(session);
    return { session, mark };
  }

  /** Edit a mark's time and/or label. Re-sorts, because the time IS the story order. */
  updateMark(
    sessionId: string,
    markId: string,
    patch: { at?: number; label?: string }
  ): StreamMarkResult {
    const session = this.getSession(sessionId);
    const mark = session.marks.find((m) => m.id === markId);
    if (!mark) {
      throw new Error(`The stream-mark session ${sessionId} has no mark with id ${markId}.`);
    }
    if (patch.at !== undefined) mark.at = this.requireTime(patch.at, 'at');
    if (patch.label !== undefined) mark.label = this.requireLabel(patch.label);
    this.writeFile(session);
    return { session, mark };
  }

  deleteMark(sessionId: string, markId: string): StreamMarkSession {
    const session = this.getSession(sessionId);
    const before = session.marks.length;
    session.marks = session.marks.filter((m) => m.id !== markId);
    if (session.marks.length === before) {
      throw new Error(`The stream-mark session ${sessionId} has no mark with id ${markId} to delete.`);
    }
    this.writeFile(session);
    return session;
  }

  /**
   * Correct the session's wall-clock start.
   *
   * THE MARKS' `at` VALUES DO NOT MOVE, and that is the feature rather than an omission.
   * `at` is elapsed time since the start; the error being corrected is "I hit Start five
   * minutes after I went live", and the fix for that is for the whole set of marks to slide
   * five minutes earlier against the master video. Since the editor's offset is computed
   * from `startedAt`, moving `startedAt` alone slides every derived story together, which
   * is exactly one correction for one mistake. Rewriting the `at` values instead would hold
   * the stories still and change nothing on screen.
   */
  updateSession(id: string, patch: { startedAt?: string }): StreamMarkSession {
    const session = this.getSession(id);
    if (patch.startedAt !== undefined) {
      if (typeof patch.startedAt !== 'string' || Number.isNaN(Date.parse(patch.startedAt))) {
        throw new Error(
          `Cannot set the start of stream-mark session ${id} to ${JSON.stringify(patch.startedAt)} — ` +
          'it is not a date this runtime can read.'
        );
      }
      session.startedAt = new Date(patch.startedAt).toISOString();
    }
    this.writeFile(session);
    return session;
  }

  deleteSession(id: string): void {
    const file = this.fileFor(id);
    if (!fs.existsSync(file)) {
      throw new Error(`There is no stream-mark session with id ${id} to delete (looked for ${file}).`);
    }
    fs.unlinkSync(file);
  }

  private requireTime(value: number, field: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`A stream mark's ${field} must be a finite number of seconds, got ${JSON.stringify(value)}.`);
    }
    if (value < 0) {
      throw new Error(`A stream mark's ${field} is elapsed time and cannot be negative, got ${value}.`);
    }
    return value;
  }

  private requireLabel(value: string): string {
    if (typeof value !== 'string') {
      throw new Error(`A stream mark's label must be a string, got ${JSON.stringify(value)}.`);
    }
    return value;
  }
}
