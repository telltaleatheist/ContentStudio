import { Component, EventEmitter, Inject, Input, OnInit, Output, ChangeDetectorRef } from '@angular/core';

import {
  EDITOR_HOST,
  EditorHost,
  MasterFileTimes,
  StreamMarkSession,
  StreamMarkSessionSummary,
} from '../editor-host';
import {
  buildImportRows,
  formatElapsed,
  formatSignedOffset,
  ImportRow,
  offsetForMarkAtPlayhead,
  parseSignedOffset,
} from '../model/stream-marks-import';

/**
 * "Stream marks…" — a night's marks become this session's stories.
 *
 * THE PROBLEM THIS SOLVES is two clocks. The marks are elapsed seconds since Owen pressed
 * Start; the timeline is seconds since the recording began. One number reconciles them, and
 * this dialog's whole job is getting that number right and showing what it does before
 * anything is created:
 *
 *   timeline seconds = mark's elapsed seconds + offset
 *
 * The offset is PROPOSED from the master video's own file date (the stream's start minus the
 * recording's) and is then editable, because file dates can be wrong in ways nothing here
 * can detect — a copied file carries the copy's creation time, and a filesystem that keeps
 * no creation time has only a modification time to offer. Which of the two was used is
 * printed, never assumed: see `masterTimeSource`.
 *
 * MARKS ARE BOUNDARIES. Owen presses the key when a story ENDS, so story i runs from the
 * previous mark to mark i and takes mark i's label; the material after the last mark is not
 * a story, because nothing ended it. That rule and the arithmetic around it live in
 * model/stream-marks-import.ts with a spec — this component is the screen, not the maths.
 *
 * NOTHING IS CREATED UNTIL APPLY, and every row says in advance what it would create,
 * including the ones that would land off the ends of the timeline: partly-off rows are
 * flagged and trimmed, wholly-off rows are disabled with the reason (LEDGER law 1 — no
 * silent clamping of a boundary that decides where a published video starts).
 */

/** One row as the template sees it: the pure row plus the two things the operator owns. */
export interface ImportRowView extends ImportRow {
  /** Included in the apply. Off for rows that cannot be created. */
  checked: boolean;
  /** The title as edited here, seeded from the mark's label. */
  editedTitle: string;
}

/** What Apply hands back: timeline seconds, already clamped, in stream order. */
export interface StreamMarkImportSpan {
  title: string;
  /**
   * True when a human named this story — the label typed during the stream, or a title
   * edited in the dialog. False when `title` is the "Story N" placeholder, which the editor's
   * auto-titling is then free to replace, exactly as it may for a ⌘S story never renamed.
   */
  titled: boolean;
  start: number;
  end: number;
}

@Component({
  selector: 'app-stream-marks-import-modal',
  templateUrl: './stream-marks-import-modal.component.html',
  styleUrls: ['./stream-marks-import-modal.component.scss'],
  standalone: false
})
export class StreamMarksImportModalComponent implements OnInit {
  /** The loaded session's compounds zip — how the host finds the master video beside it. */
  @Input() zipPath: string | null = null;
  /** The timeline's length in ORIGINAL seconds, which is the frame story regions live in. */
  @Input() timelineDuration = 0;
  /** The playhead in ORIGINAL seconds — the anchor for "Selected mark = playhead". */
  @Input() playheadOriginal = 0;

  @Output() closed = new EventEmitter<void>();
  @Output() applied = new EventEmitter<StreamMarkImportSpan[]>();

  sessions: StreamMarkSessionSummary[] = [];
  selectedId: string | null = null;
  session: StreamMarkSession | null = null;
  master: MasterFileTimes | null = null;

  /**
   * What the master's file time MEANS — the moment the recording started, or the moment it
   * finished.
   *
   * This is the whole difference between an offset that works and one that puts the entire
   * night before 00:00:00, and it cannot be read off the file. A recorder that opens its file
   * and writes into it leaves a creation time at the START; a file that was rendered,
   * downloaded, copied or moved carries a time at (or after) the END, and macOS gives a copy
   * the copy's own creation time. Measured on Owen's first real import: a 3h16m master whose
   * creation time was 23:13 for a stream that began at 19:57 — file time = end, exactly.
   *
   * So both readings are offered, the one that actually lands the stories is preselected, and
   * which was picked is SAID (`anchorReason`). Deriving it silently is what produced a dialog
   * with six disabled rows and no explanation.
   */
  masterAnchor: 'start' | 'end' = 'start';

  /** Why `masterAnchor` is what it is, in words, shown under the toggle. */
  anchorReason = '';

  /** The offset in seconds, and the text being typed into the field (null = show the number). */
  offset = 0;
  offsetDraft: string | null = null;
  offsetError: string | null = null;

  rows: ImportRowView[] = [];
  /** The row "Selected mark = playhead" anchors on. Null until a row is clicked. */
  anchorMarkId: string | null = null;

  loading = true;
  /** Any failure, verbatim. The dialog stays open on one — it is the only place to fix it. */
  error: string | null = null;
  /** Said out loud when no recorded stream shares the master's date. Not an error. */
  notice: string | null = null;

  constructor(@Inject(EDITOR_HOST) private host: EditorHost, private cdr: ChangeDetectorRef) {}

  async ngOnInit(): Promise<void> {
    // The Stories tab only shows the button when the host implements the group, so arriving
    // here without it means the port contract was broken — named, not worked around.
    if (!this.host.listStreamMarkSessions || !this.host.getStreamMarkSession || !this.host.masterFileTimes) {
      this.error = 'This host does not provide stream marks (EditorHost.listStreamMarkSessions is missing).';
      this.loading = false;
      return;
    }
    if (!this.zipPath) {
      this.error = 'No session is open, so there is no master video to line the marks up against.';
      this.loading = false;
      return;
    }
    if (!(this.timelineDuration > 0)) {
      this.error = 'The timeline has no duration yet — wait for the session to finish loading.';
      this.loading = false;
      return;
    }
    try {
      const [sessions, master] = await Promise.all([
        this.host.listStreamMarkSessions(),
        this.host.masterFileTimes({ zipPath: this.zipPath }),
      ]);
      this.sessions = sessions;
      this.master = master;
      const preselected = this.sessionMatchingMasterDate(sessions, master);
      if (preselected) {
        await this.selectSession(preselected.id);
      } else if (sessions.length > 0) {
        this.notice =
          `No recorded stream started on ${this.masterDateLabel()} — pick the one this session came from.`;
      }
    } catch (err: any) {
      this.error = this.messageOf(err);
    } finally {
      this.loading = false;
      this.cdr.detectChanges();
    }
  }

  // ── The master's date ───────────────────────────────────────────────────────

  /**
   * Which file time is dating the master, in words for the dialog.
   *
   * A filesystem that keeps no creation time reports the epoch for birthtime, and the host
   * turns that into null rather than handing over a 1970 date that would propose an offset
   * of fifty-six years. The modification time is then what there is — and the dialog SAYS
   * so, because a modification time is when the file was last written, which for a recording
   * is when it finished rather than when it started.
   */
  get masterTimeIso(): string | null {
    if (!this.master) return null;
    return this.master.birthtimeIso !== null ? this.master.birthtimeIso : this.master.mtimeIso;
  }

  get masterTimeSource(): 'created' | 'modified' | null {
    if (!this.master) return null;
    return this.master.birthtimeIso !== null ? 'created' : 'modified';
  }

  masterDateLabel(): string {
    const iso = this.masterTimeIso;
    if (!iso) return 'the master video\'s date';
    return new Date(iso).toLocaleString();
  }

  private sessionMatchingMasterDate(
    sessions: StreamMarkSessionSummary[],
    master: MasterFileTimes
  ): StreamMarkSessionSummary | null {
    const iso = master.birthtimeIso !== null ? master.birthtimeIso : master.mtimeIso;
    const masterDay = this.localDayOf(iso);
    // Newest first already, so the first match is the latest stream of that day — the one a
    // master recorded that day belongs to when a day held two.
    return sessions.find((s) => this.localDayOf(s.startedAt) === masterDay) ?? null;
  }

  private localDayOf(iso: string): string {
    const d = new Date(iso);
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  // ── Session and offset ──────────────────────────────────────────────────────

  async onSessionChange(id: string): Promise<void> {
    await this.selectSession(id);
    this.cdr.detectChanges();
  }

  private async selectSession(id: string): Promise<void> {
    if (!this.host.getStreamMarkSession) return;
    try {
      this.session = await this.host.getStreamMarkSession(id);
      this.selectedId = id;
      this.anchorMarkId = null;
      this.notice = null;
      this.masterAnchor = this.chooseAnchor(this.session);
      this.offset = this.proposeOffset(this.session, this.masterAnchor);
      this.offsetDraft = null;
      this.offsetError = null;
      this.rebuildRows(true);
      this.error = null;
    } catch (err: any) {
      this.error = this.messageOf(err);
    }
  }

  /**
   * The proposal: the stream's start, in the recording's own coordinates.
   *
   * Positive means the stream started after the recording did (the usual case — the camera
   * rolls first); negative means the recording started later, which happens when a stream is
   * recovered from a part-way restart. Both are legitimate, so the sign is carried, not
   * swallowed.
   *
   * When the file time marks the END of the recording, the recording's own start is that time
   * minus the timeline's length — which is why the dialog needs the duration to propose
   * anything at all under that reading.
   */
  private proposeOffset(session: StreamMarkSession, anchor: 'start' | 'end'): number {
    const masterIso = this.masterTimeIso;
    if (!masterIso) {
      throw new Error('The master video\'s file times were never loaded, so no offset can be proposed.');
    }
    const fileMs = Date.parse(masterIso);
    const recordingStartMs = anchor === 'start' ? fileMs : fileMs - this.timelineDuration * 1000;
    return Math.round((Date.parse(session.startedAt) - recordingStartMs) / 1000);
  }

  /**
   * Which reading of the file time to open with: the one that puts more stories ON the
   * timeline. Ties go to 'start', the simpler claim, and the choice is stated either way.
   *
   * This is a proposal being ranked, not a failure being papered over — both candidates are
   * offered in the UI and the operator can take the other in one click.
   */
  private chooseAnchor(session: StreamMarkSession): 'start' | 'end' {
    const fit = (anchor: 'start' | 'end') => {
      const rows = buildImportRows(session.marks, this.proposeOffset(session, anchor), this.timelineDuration);
      return rows.filter((r) => r.state === 'inside' || r.state === 'clamped').length;
    };
    const atStart = fit('start');
    const atEnd = fit('end');
    const total = session.marks.length;
    if (atEnd > atStart) {
      this.anchorReason =
        `Reading it as the moment the recording ENDED, because reading it as the start leaves ` +
        `${total - atStart} of ${total} stories off this timeline.`;
      return 'end';
    }
    if (atStart > atEnd) {
      this.anchorReason =
        `Reading it as the moment the recording STARTED — that lands ${atStart} of ${total} ` +
        `stories on this timeline.`;
      return 'start';
    }
    this.anchorReason = atStart === 0
      ? `Neither reading lands these stories on this timeline — check the stream, or set the ` +
        `offset by parking the playhead where a story ends.`
      : `Both readings land the same stories; showing the recording's start.`;
    return 'start';
  }

  /** The toggle. Re-proposes the offset under the other reading; titles and ticks survive. */
  setMasterAnchor(anchor: 'start' | 'end'): void {
    const session = this.session;
    if (!session || this.masterAnchor === anchor) return;
    this.masterAnchor = anchor;
    this.anchorReason = anchor === 'end'
      ? 'Reading the master\'s file time as the moment the recording ended.'
      : 'Reading the master\'s file time as the moment the recording started.';
    this.offset = this.proposeOffset(session, anchor);
    this.offsetDraft = null;
    this.offsetError = null;
    this.rebuildRows(false);
  }

  /** The recording's start under the current reading, for the hint line. */
  recordingStartLabel(): string {
    const masterIso = this.masterTimeIso;
    if (!masterIso) return '';
    const ms = this.masterAnchor === 'start'
      ? Date.parse(masterIso)
      : Date.parse(masterIso) - this.timelineDuration * 1000;
    return new Date(ms).toLocaleString();
  }

  offsetField(): string {
    return this.offsetDraft === null ? formatSignedOffset(this.offset) : this.offsetDraft;
  }

  onOffsetInput(value: string): void {
    this.offsetDraft = value;
  }

  /** Commit a typed offset. Unparseable text keeps its text and changes nothing. */
  commitOffset(): void {
    if (this.offsetDraft === null) return;
    const seconds = parseSignedOffset(this.offsetDraft);
    if (seconds === null) {
      this.offsetError = `"${this.offsetDraft}" is not an offset — type it as ±hh:mm:ss, e.g. -00:04:30.`;
      return;
    }
    this.offset = seconds;
    this.offsetDraft = null;
    this.offsetError = null;
    this.rebuildRows(false);
  }

  /**
   * Park the whole set so the chosen boundary sits exactly on the playhead.
   *
   * This is the answer to every case the file dates cannot settle. Find the frame where a
   * story visibly ends, click the row that ended it, press this — one correction moves every
   * other story with it, because they all share the one offset.
   */
  anchorToPlayhead(): void {
    const session = this.session;
    if (!session || !this.anchorMarkId) return;
    const mark = session.marks.find((m) => m.id === this.anchorMarkId);
    if (!mark) {
      this.error = `The anchored mark ${this.anchorMarkId} is no longer in this stream.`;
      return;
    }
    this.offset = Math.round(offsetForMarkAtPlayhead(mark.at, this.playheadOriginal));
    this.offsetDraft = null;
    this.offsetError = null;
    this.rebuildRows(false);
  }

  setAnchor(markId: string): void {
    this.anchorMarkId = markId;
  }

  // ── Rows ────────────────────────────────────────────────────────────────────

  /**
   * Recompute what would be created.
   *
   * `reseed` is true only when the session changed: the checkbox and the typed title belong
   * to the operator, and an offset edit must not throw away a title he has just corrected.
   */
  private rebuildRows(reseed: boolean): void {
    const session = this.session;
    if (!session) {
      this.rows = [];
      return;
    }
    const previous = new Map(this.rows.map((r) => [r.markId, r]));
    const built = buildImportRows(session.marks, this.offset, this.timelineDuration);
    this.rows = built.map((row) => {
      const prior = reseed ? undefined : previous.get(row.markId);
      const creatable = row.state === 'inside' || row.state === 'clamped';
      return {
        ...row,
        // Default on — the common case is "import the lot". A row that cannot be created is
        // off and stays off; its checkbox is disabled and says why.
        checked: creatable && (prior ? prior.checked : true),
        editedTitle: prior ? prior.editedTitle : row.title,
      };
    });
  }

  onTitleInput(row: ImportRowView, value: string): void {
    row.editedTitle = value;
  }

  toggle(row: ImportRowView): void {
    if (!this.canCreate(row)) return;
    row.checked = !row.checked;
  }

  canCreate(row: ImportRowView): boolean {
    return row.state === 'inside' || row.state === 'clamped';
  }

  get checkedCount(): number {
    return this.rows.filter((r) => r.checked).length;
  }

  timecode(seconds: number): string {
    // Negative values are real here (a row before the timeline starts) and hh:mm:ss cannot
    // carry a sign, so the signed formatter is what prints them.
    return seconds < 0 ? formatSignedOffset(seconds) : formatElapsed(seconds);
  }

  markElapsed(markId: string): string {
    const mark = this.session?.marks.find((m) => m.id === markId);
    return mark ? formatElapsed(mark.at) : '';
  }

  sessionLabel(s: { startedAt: string; endedAt: string | null; markCount?: number }): string {
    const d = new Date(s.startedAt);
    const when = d.toLocaleString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
    const count = s.markCount === undefined ? '' : ` — ${s.markCount} mark${s.markCount === 1 ? '' : 's'}`;
    return `${when}${count}${s.endedAt === null ? ' (live)' : ''}`;
  }

  // ── Applying ────────────────────────────────────────────────────────────────

  apply(): void {
    const spans = this.rows
      .filter((r) => r.checked && this.canCreate(r))
      // Stream order, so the numbers the editor assigns follow the night.
      .sort((a, b) => a.number - b.number)
      .map((r) => {
        const edited = r.editedTitle.trim();
        return {
          title: edited === '' ? r.title : edited,
          titled: r.labelled || (edited !== '' && edited !== r.title),
          start: r.start,
          end: r.end,
        };
      });
    if (spans.length === 0) return;
    this.applied.emit(spans);
  }

  onClose(): void {
    this.closed.emit();
  }

  onBackdropClick(): void {
    this.closed.emit();
  }

  private messageOf(err: any): string {
    const raw = err instanceof Error ? err.message : String(err);
    const inner = raw.match(/Error invoking remote method '[^']*':\s*([\s\S]*)$/);
    return (inner ? inner[1] : raw).replace(/^Error:\s*/, '').trim() || raw;
  }
}
