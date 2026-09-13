// The stream-marks shapes, renderer side.
//
// A MIRROR of electron/services/stream-marks/stream-marks.service.ts, the way
// features/publish/publish.types.ts mirrors the publish store: the main process owns the
// data and these are the shapes that come over the bridge. Changing one without the other
// is the seam this project keeps getting bitten at (LEDGER law 10), so the two files name
// each other.

/** One boundary: the key was pressed `at` seconds into the stream, `label` names what ended. */
export interface StreamMark {
  id: string;
  /** ELAPSED seconds since the session's startedAt — never a wall-clock instant. */
  at: number;
  label: string;
}

export interface StreamMarkSession {
  /** ISO start instant, filesystem-safe. Also the name of the file it lives in. */
  id: string;
  /** ISO wall clock. Editable — a late Start is corrected here and the marks do not move. */
  startedAt: string;
  /** ISO wall clock of End stream, or null while live. */
  endedAt: string | null;
  /** Sorted by `at`. Story order is this order. */
  marks: StreamMark[];
}

export interface StreamMarkSessionSummary {
  id: string;
  startedAt: string;
  endedAt: string | null;
  markCount: number;
}

/** Which surface caused a change — the tab focuses a new row differently for each. */
export type StreamMarkSource = 'window' | 'hotkey';

/** The `stream-marks:changed` push payload. */
export interface StreamMarksChange {
  sessionId: string;
  /** The session after the change, or null when the change was its deletion. */
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
  markId: string | null;
  source: StreamMarkSource;
}

export interface StreamMarkStartResult {
  session: StreamMarkSession;
  alreadyLive: boolean;
  /** Non-null exactly when alreadyLive. Shown verbatim. */
  message: string | null;
}

export interface StreamMarkResult {
  session: StreamMarkSession;
  mark: StreamMark;
}

/** The global hotkey's registration state. `error` is the OS's refusal, shown in red. */
export interface StreamMarksHotkeyStatus {
  accelerator: string;
  registered: boolean;
  error: string | null;
}

/**
 * The loaded editor session's master video and the two file times that can date it.
 * `birthtimeIso` is null when the filesystem keeps no creation time; the dialog then says
 * it is dating the master by its modification time, rather than quietly using one for the
 * other.
 */
export interface MasterFileTimes {
  masterPath: string;
  birthtimeIso: string | null;
  mtimeIso: string;
}
