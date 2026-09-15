import {
  Component, EventEmitter, Inject, Input, OnDestroy, OnInit, Output, ChangeDetectorRef
} from '@angular/core';

import {
  EDITOR_HOST,
  EditorHost,
  MasterFileTimes,
  StreamMarkSession,
  StreamMarkSessionSummary,
} from '../editor-host';
import { EditorSegment } from '../host-data/editor-manifest';
import {
  buildImportRows,
  formatElapsed,
  formatSignedOffset,
  ImportRow,
  ImportRowState,
  masterToTimeline,
  orderSegmentsBySource,
  parseSignedOffset,
  streamStartForMarkAtMaster,
  TimelineSegment,
  timelineToMaster,
} from '../model/stream-marks-import';

/**
 * "Stream marks…" — a night's marks become this session's stories.
 *
 * THE PROBLEM THIS SOLVES is THREE clocks, not two. The marks are elapsed seconds since Owen
 * pressed Start. The master video is seconds since the recording began. The timeline is the
 * master with its dead air dropped — 1954 pieces of it, 32 minutes shorter (measured
 * 2026-09-14) — which makes it a NON-LINEAR remap of the recording, not an offset of it:
 *
 *   master seconds   = mark's elapsed seconds + streamStartInMaster      (a constant)
 *   timeline seconds = masterToTimeline(the timeline's segments, that)   (the segment table)
 *
 * The constant is the ONE number this dialog owns, and it means where the stream's clock zero
 * sits in the master FILE. An earlier version added a single offset straight onto the timeline
 * and could only ever be right at one point on it: Owen tuned it until his last story landed
 * and every earlier one was up to twenty minutes out. The measurement is in the mapping's own
 * comment (model/stream-marks-import.ts) — read it before touching any of this arithmetic.
 *
 * The constant is PROPOSED from the master video's own file date and its own ffprobed length
 * (the stream's start minus the recording's) and is then editable, because file dates can be
 * wrong in ways nothing here can detect — a copied file carries the copy's creation time, and
 * a filesystem that keeps no creation time has only a modification time to offer. Which of the
 * two was used is printed, never assumed: see `masterTimeSource`.
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

/** One span of the live preview the editor's canvas draws. Timeline (ORIGINAL) seconds. */
export interface StreamMarksPreviewSpan {
  title: string;
  /** Clamped to the timeline, i.e. exactly the story Apply would create. */
  start: number;
  end: number;
  checked: boolean;
  state: ImportRowState;
}

/**
 * What the dialog publishes for the editor to DRAW, recomputed on every change that moves a
 * boundary or changes what a band says.
 *
 * This is a view, not a second copy of the import: the dialog stays the only thing that owns the
 * constant, a tick or a title, and the editor holds this object only until the next one arrives.
 * `boundaries` is here rather than derived from `spans` because a span is what will be CREATED
 * (clamped, and gone entirely when it lands in removed material) while a boundary is what the
 * hand takes hold of — a drag that did its arithmetic on the created spans would lose the line
 * it was dragging the moment that story slid off an end.
 */
export interface StreamMarksPreview {
  /** Where the stream's clock zero sits in the MASTER FILE, in master seconds. */
  streamStartInMaster: number;
  /**
   * True while the dialog is the bar at the foot of the window. The editor needs it to reserve
   * the bar's height, and it rides in the preview rather than being read off the child component
   * so the parent's class binding cannot depend on a value that changed mid-change-detection.
   */
  collapsed: boolean;
  spans: StreamMarksPreviewSpan[];
  /** Every dividing line the set has, ascending by where it currently sits. See the type. */
  boundaries: StreamMarksBoundary[];
}

/**
 * One dividing line, in both frames at once — which is what a drag needs and why this replaced
 * the old list of plain timeline seconds.
 *
 * `elapsed` is the line's identity: the second of the STREAM it marks, fixed for the night.
 * `timeline` is where that second currently lands, and it moves — non-linearly — every time the
 * constant changes. A drag grabs the line nearest the pointer (by `timeline`, in pixels) and
 * then asks for a constant that puts THAT line's `elapsed` under the pointer; every other line
 * re-maps to wherever its own content is, which is the truth a rigid set could not tell.
 */
export interface StreamMarksBoundary {
  /** Stream elapsed seconds. */
  elapsed: number;
  /** Where it sits now, in ORIGINAL timeline seconds. */
  timeline: number;
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
export class StreamMarksImportModalComponent implements OnInit, OnDestroy {
  /** The loaded session's compounds zip — how the host finds the master video beside it. */
  @Input() zipPath: string | null = null;
  /** The timeline's length in ORIGINAL seconds, which is the frame story regions live in. */
  @Input() timelineDuration = 0;
  /** The playhead in ORIGINAL seconds — the anchor for "Selected mark = playhead". */
  @Input() playheadOriginal = 0;
  /**
   * The timeline's segment table: every piece of the MASTER file the timeline is made of, as
   * the manifest's video track holds them. This is the map (see the class comment) and without
   * it there is no import — a dialog that fell back to adding an offset would be the bug this
   * input exists to kill, so an unusable table is an error on screen, never a second code path.
   */
  @Input() masterSegments: readonly EditorSegment[] = [];

  @Output() closed = new EventEmitter<void>();
  @Output() applied = new EventEmitter<StreamMarkImportSpan[]>();
  /**
   * The rows, for the editor's canvas to draw over the footage. Null once this dialog is gone.
   *
   * Owen's whole complaint about the constant was that it is a number standing in for a picture:
   * you type minus four minutes and then read six rows of timecode to work out whether that was
   * right. This output is the picture — and it is an output rather than shared state because the
   * ANSWER still lives here. The editor draws it and can push a new constant back through
   * setStreamStartFromDrag; it never owns a boundary.
   */
  @Output() previewChange = new EventEmitter<StreamMarksPreview | null>();

  sessions: StreamMarkSessionSummary[] = [];
  selectedId: string | null = null;
  session: StreamMarkSession | null = null;
  master: MasterFileTimes | null = null;

  /**
   * What the master's file time MEANS — the moment the recording started, or the moment it
   * finished.
   *
   * This is the whole difference between a constant that works and one that puts the entire
   * night before the recording began, and it cannot be read off the file. A recorder that opens its file
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

  /**
   * WHERE THE STREAM CLOCK'S ZERO SITS IN THE MASTER FILE, in master seconds — the one constant
   * between the stream and the recording. Positive means the recording was already rolling when
   * the stream started (the usual case); negative means the stream started first.
   *
   * NOT a timeline offset. Adding it to a timeline second is the arithmetic this whole change
   * removed: everything between the master and the timeline is the segment table.
   */
  streamStartInMaster = 0;
  streamStartDraft: string | null = null;
  streamStartError: string | null = null;

  /**
   * The segment table, ordered by sourceStart once so every mapping can binary-search it.
   *
   * Built in ngOnInit from `masterSegments` and never rebuilt: 1954 segments × 20 marks × every
   * mouse move of a drag is the load this ordering pays for once.
   */
  private segments: TimelineSegment[] = [];

  rows: ImportRowView[] = [];
  /** The row "Selected mark = playhead" anchors on. Null until a row is clicked. */
  anchorMarkId: string | null = null;

  /**
   * Collapsed to a bar at the foot of the window, so the timeline underneath can be reached.
   *
   * A dialog that covers the thing you are aiming at cannot be used to aim. The list is the right
   * shape for checking WHAT will be created and the timeline is the only place to see WHERE, so
   * the two swap places on one button rather than trying to coexist: collapsed, this component
   * renders nothing but the bar — no backdrop, no panel, nothing over the canvas to intercept the
   * press that starts a drag.
   */
  collapsed = false;

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
      // The map before anything that uses it. A table that is not of this master, or not
      // mappable at all, stops the dialog here with the reason — see buildSegmentTable.
      this.segments = this.buildSegmentTable(master);
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

  /**
   * The timeline's segment table, checked against the master this dialog is dating.
   *
   * THE TWO MUST BE THE SAME FILE. The constant is measured against the file ffprobe measured
   * and the marks are mapped through segments cut FROM a file; if those are different files the
   * result is a plausible-looking set of stories in the wrong places, which is worse than no
   * import at all. Compared by BASENAME on purpose: a project opened through a symlinked folder
   * (the sandbox this was developed against) reports the link's path for the master while the
   * manifest names the real one, and the two are the same video.
   */
  private buildSegmentTable(master: MasterFileTimes): TimelineSegment[] {
    if (this.masterSegments.length === 0) {
      throw new Error(
        'This timeline has no video segments, so there is no map between the recording and the ' +
        'timeline and no way to place the marks.'
      );
    }
    const files = Array.from(new Set(this.masterSegments.map((seg) => seg.file)));
    if (files.length > 1) {
      throw new Error(
        `This timeline's video is cut from ${files.length} different files (${files.join(', ')}). ` +
        'Stream marks can only be placed on a timeline cut from the one master recording.'
      );
    }
    const base = (p: string) => p.split('/').pop() || p;
    if (base(files[0]) !== base(master.masterPath)) {
      throw new Error(
        `The timeline is cut from ${files[0]}, but the master video beside the session is ` +
        `${master.masterPath}. Those are different recordings, so the marks cannot be placed ` +
        'from this master\'s file time.'
      );
    }
    return orderSegmentsBySource(this.masterSegments);
  }

  // ── The master's date ───────────────────────────────────────────────────────

  /**
   * Which file time is dating the master, in words for the dialog.
   *
   * A filesystem that keeps no creation time reports the epoch for birthtime, and the host
   * turns that into null rather than handing over a 1970 date that would put the stream's
   * zero fifty-six years into the recording. The modification time is then what there is — and the dialog SAYS
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

  // ── Session and the stream's zero ───────────────────────────────────────────

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
      this.streamStartInMaster = this.proposeStreamStart(this.session, this.masterAnchor);
      this.streamStartDraft = null;
      this.streamStartError = null;
      this.rebuildRows(true);
      this.error = null;
    } catch (err: any) {
      this.error = this.messageOf(err);
    }
  }

  /**
   * The proposal: the stream's zero, in the recording's own seconds.
   *
   * Positive means the stream started after the recording did (the usual case — the camera
   * rolls first); negative means the recording started later, which happens when a stream is
   * recovered from a part-way restart. Both are legitimate, so the sign is carried, not
   * swallowed.
   *
   * When the file time marks the END of the recording, the recording's own start is that time
   * minus THE MASTER'S OWN LENGTH — the ffprobed `durationSeconds`, never the timeline's. The
   * timeline is the master with its dead air dropped and on Owen's session was 32 minutes
   * shorter; subtracting that instead put the recording's start half an hour late and every
   * story with it.
   */
  private proposeStreamStart(session: StreamMarkSession, anchor: 'start' | 'end'): number {
    const masterIso = this.masterTimeIso;
    if (!masterIso) {
      throw new Error(
        'The master video\'s file times were never loaded, so the stream\'s start in the ' +
        'recording cannot be proposed.'
      );
    }
    return Math.round((Date.parse(session.startedAt) - this.recordingStartMs(masterIso, anchor)) / 1000);
  }

  /** The moment the recording itself began, under `anchor`. One place, so the hint cannot drift. */
  private recordingStartMs(masterIso: string, anchor: 'start' | 'end'): number {
    const fileMs = Date.parse(masterIso);
    if (anchor === 'start') return fileMs;
    if (!this.master) {
      throw new Error('The master video\'s file times were never loaded, so its length is unknown.');
    }
    return fileMs - this.master.durationSeconds * 1000;
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
      const rows = buildImportRows(
        session.marks,
        this.proposeStreamStart(session, anchor),
        this.segments,
        this.timelineDuration
      );
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
        `stream's zero by parking the playhead where a story ends.`
      : `Both readings land the same stories; showing the recording's start.`;
    return 'start';
  }

  /**
   * Put the night where the hand has dragged it to. Called by the editor, once per mouse move,
   * with the ABSOLUTE constant the drag has reached (see streamStartInMaster).
   *
   * THE PROPOSAL IS AN ESTIMATE AND WILL BE MINUTES OUT. Under the "ended" reading the
   * recording's start is the file time minus the recording's length, and the file time carries
   * error: a file is stamped when the write FINISHED, and a render, a download or a copy lands
   * after the recording stopped. Six nudge buttons used to stand here for that correction and
   * were the wrong instrument for it ("shift buttons arent useful"): they ask you to guess the
   * size of an error you can SEE, in units nobody measured it in.
   *
   * ABSOLUTE, not a delta, and that is the contract. The editor computes it afresh on every
   * mouse move from where the pointer is and which boundary the hand took hold of, so a hundred
   * mousemoves cannot drift and Escape only has to put one number back.
   *
   * WHAT THE OTHER BOUNDARIES DO IS NOT "MOVE BY THE SAME AMOUNT". They re-map through the
   * segment table, so a set dragged across twenty minutes of removed material stretches and
   * squeezes — that is where their content actually is, and the rigid set this replaced was the
   * bug, not the feature.
   *
   * NOT rounded to whole seconds, unlike every other way this constant is set. The drag snaps
   * the grabbed boundary onto cuts and onto the playhead, and neither of those lands on a second
   * — rounding would slide it straight back off the thing it was aimed at. The field above still
   * READS ±hh:mm:ss (formatSignedOffset rounds for display), which is the resolution a human
   * types in and no less exact than what he typed.
   */
  setStreamStartFromDrag(streamStartInMaster: number): void {
    if (!this.session) {
      throw new Error(
        'setStreamStartFromDrag was called with no stream selected, so there is nothing to ' +
        'place. The editor only starts a set drag while a preview is on screen, and a preview ' +
        'only exists once a session is picked.'
      );
    }
    if (!Number.isFinite(streamStartInMaster)) {
      throw new Error(
        `setStreamStartFromDrag needs a finite number of master seconds, got ` +
        `${JSON.stringify(streamStartInMaster)}.`
      );
    }
    this.streamStartInMaster = streamStartInMaster;
    this.streamStartDraft = null;
    this.streamStartError = null;
    this.anchorReason = 'Set by dragging a boundary onto the timeline.';
    this.rebuildRows(false);
    // The editor drives this from a window mousemove, outside Angular's ordinary flow for a
    // template-bound event, so the bar's live readout and the row timecodes need telling.
    this.cdr.detectChanges();
  }

  /** Get out of the timeline's way. The whole dialog becomes the bar at the foot of the window. */
  collapse(): void {
    this.collapsed = true;
    this.emitPreview();     // the editor reserves the bar's height off this
  }

  /** Back to the list, to check WHAT is about to be created rather than where it sits. */
  expand(): void {
    this.collapsed = false;
    this.emitPreview();
  }

  /** The toggle. Re-proposes the stream's zero under the other reading; titles and ticks survive. */
  setMasterAnchor(anchor: 'start' | 'end'): void {
    const session = this.session;
    if (!session || this.masterAnchor === anchor) return;
    this.masterAnchor = anchor;
    this.anchorReason = anchor === 'end'
      ? 'Reading the master\'s file time as the moment the recording ended.'
      : 'Reading the master\'s file time as the moment the recording started.';
    this.streamStartInMaster = this.proposeStreamStart(session, anchor);
    this.streamStartDraft = null;
    this.streamStartError = null;
    this.rebuildRows(false);
  }

  /** The recording's start under the current reading, for the hint line. */
  recordingStartLabel(): string {
    const masterIso = this.masterTimeIso;
    if (!masterIso) return '';
    return new Date(this.recordingStartMs(masterIso, this.masterAnchor)).toLocaleString();
  }

  /** The master's own length, for the hint that says which number was subtracted. */
  masterDurationLabel(): string {
    return this.master ? formatElapsed(this.master.durationSeconds) : '';
  }

  streamStartField(): string {
    return this.streamStartDraft === null
      ? formatSignedOffset(this.streamStartInMaster)
      : this.streamStartDraft;
  }

  onStreamStartInput(value: string): void {
    this.streamStartDraft = value;
  }

  /** Commit a typed constant. Unparseable text keeps its text and changes nothing. */
  commitStreamStart(): void {
    if (this.streamStartDraft === null) return;
    const seconds = parseSignedOffset(this.streamStartDraft);
    if (seconds === null) {
      this.streamStartError =
        `"${this.streamStartDraft}" is not a time into the recording — type it as ±hh:mm:ss, ` +
        'e.g. +00:04:30.';
      return;
    }
    this.streamStartInMaster = seconds;
    this.streamStartDraft = null;
    this.streamStartError = null;
    this.rebuildRows(false);
  }

  /**
   * Park the set so the chosen boundary sits exactly on the playhead.
   *
   * This is the answer to every case the file dates cannot settle. Find the frame where a story
   * visibly ends, click the row that ended it, press this.
   *
   * THE PLAYHEAD IS A TIMELINE POSITION AND THE ANSWER IS A MASTER ONE, so it goes back through
   * the segment table first: the demand is "this mark was recorded at the master second that
   * plays here", and the constant is what that works out to. Every other story then re-maps to
   * where its own content is — which is not the same distance, and pretending it was is the bug
   * this replaced.
   */
  anchorToPlayhead(): void {
    const session = this.session;
    if (!session || !this.anchorMarkId) return;
    const mark = session.marks.find((m) => m.id === this.anchorMarkId);
    if (!mark) {
      this.error = `The anchored mark ${this.anchorMarkId} is no longer in this stream.`;
      return;
    }
    const masterAtPlayhead = timelineToMaster(this.segments, this.playheadOriginal);
    this.streamStartInMaster = streamStartForMarkAtMaster(mark.at, masterAtPlayhead);
    this.streamStartDraft = null;
    this.streamStartError = null;
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
   * to the operator, and moving the set must not throw away a title he has just corrected.
   */
  private rebuildRows(reseed: boolean): void {
    const session = this.session;
    if (!session) {
      this.rows = [];
      this.emitPreview();
      return;
    }
    const previous = new Map(this.rows.map((r) => [r.markId, r]));
    const built = buildImportRows(
      session.marks, this.streamStartInMaster, this.segments, this.timelineDuration
    );
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
    this.emitPreview();
  }

  /**
   * Publish what the editor should draw.
   *
   * Every path that can move a boundary or change what a band says comes through here, which is
   * why it hangs off rebuildRows (session, constant, anchor, drag) plus the two edits that change a
   * row without moving it (a tick, a title). One emitter means the overlay cannot fall behind the
   * list — and a drawing that disagreed with the list about which stories are being created is
   * exactly the confusion this preview exists to end.
   *
   * A band shows the title apply() would actually give the story — the typed one, or the row's
   * own "Story N" placeholder once the field has been emptied — because the operator reads these
   * bands to decide whether the night has landed on the right content, and a band labelled with a
   * name no story is going to get is the one thing that could mislead him about it.
   */
  private emitPreview(): void {
    if (!this.session) {
      this.previewChange.emit(null);
      return;
    }
    const collapsed = this.collapsed;
    const spans: StreamMarksPreviewSpan[] = this.rows.map((row) => {
      const edited = row.editedTitle.trim();
      return {
        title: edited === '' ? row.title : edited,
        start: row.start,
        end: row.end,
        checked: row.checked,
        state: row.state,
      };
    });
    // Ascending by where they SIT and deduped by the stream second they ARE: two marks a second
    // apart are the same pixel at a three-hour zoom, and two boundaries that mapped into the same
    // gap sit on the same timeline second while still being different moments of the night. The
    // drag walks this list on mousedown to find the line under the hand.
    const boundaries: StreamMarksBoundary[] = [];
    for (const row of this.rows) {
      boundaries.push({ elapsed: row.startAt, timeline: row.start });
      boundaries.push({ elapsed: row.endAt, timeline: row.end });
    }
    boundaries.sort((a, b) => a.timeline - b.timeline || a.elapsed - b.elapsed);
    const deduped: StreamMarksBoundary[] = [];
    for (const b of boundaries) {
      const last = deduped[deduped.length - 1];
      if (!last || Math.abs(b.elapsed - last.elapsed) > 1e-6) deduped.push(b);
    }
    this.previewChange.emit({
      streamStartInMaster: this.streamStartInMaster,
      collapsed,
      spans,
      boundaries: deduped,
    });
  }

  onTitleInput(row: ImportRowView, value: string): void {
    row.editedTitle = value;
    this.emitPreview();
  }

  toggle(row: ImportRowView): void {
    if (!this.canCreate(row)) return;
    row.checked = !row.checked;
    this.emitPreview();
  }

  canCreate(row: ImportRowView): boolean {
    return row.state === 'inside' || row.state === 'clamped';
  }

  get checkedCount(): number {
    return this.rows.filter((r) => r.checked).length;
  }

  /**
   * How many of the night's stories currently LAND on this timeline — the one number that moves
   * while the set is being dragged, and the reason the collapsed bar has room for it. The tick
   * count answers "what did I choose"; this answers "did I aim it right", which is the question
   * the drag is asking.
   */
  get onTimelineCount(): number {
    return this.rows.filter((r) => this.canCreate(r)).length;
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

  /**
   * The overlay dies with the dialog, and this is the ONE place that says so.
   *
   * There are five ways out of here — ✕, Cancel, the backdrop, Cancel on the collapsed bar, and
   * Apply — and every one of them ends with the editor tearing this component down. Clearing the
   * preview from each exit would be five chances to add a sixth and forget; clearing it from
   * destruction is a fact about the component rather than a list of cases. (Angular runs
   * ngOnDestroy before it unsubscribes the template's output bindings, so this emission is
   * delivered.)
   */
  ngOnDestroy(): void {
    this.previewChange.emit(null);
  }

  private messageOf(err: any): string {
    const raw = err instanceof Error ? err.message : String(err);
    const inner = raw.match(/Error invoking remote method '[^']*':\s*([\s\S]*)$/);
    return (inner ? inner[1] : raw).replace(/^Error:\s*/, '').trim() || raw;
  }
}
