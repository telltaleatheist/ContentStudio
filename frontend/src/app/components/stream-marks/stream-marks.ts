import { Component, OnDestroy, OnInit, HostListener, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';

import { ElectronService } from '../../services/electron';
import type {
  StreamMark,
  StreamMarkSession,
  StreamMarkSessionSummary,
  StreamMarksChange,
  StreamMarksHotkeyStatus,
} from '../../services/stream-marks.types';
// Reaching into the editor's folder for these two is deliberate. They are a pure,
// Angular-free module (the editor keeps its maths there), and this page and the editor's
// import dialog MUST agree to the second about what "01:12:33" means — a second parser here
// would agree until the day one of them learned to accept "1:2:3". The dependency runs one
// way only, host → editor, which is the direction the port already permits.
import {
  formatElapsed,
  parseElapsed,
} from '../editor/model/stream-marks-import';

/**
 * Stream marks — the page that replaces the Notepad file.
 *
 * Owen streams live. While he streams he writes down the time each story ENDS and a word or
 * two naming it, and the next day he redraws those boundaries by hand in the timeline
 * editor. This tab is where the notes are made and corrected; the editor's "Stream marks…"
 * dialog is where they become stories.
 *
 * THE HOTKEY IS THE PRIMARY INPUT, not the buttons. ⌘⇧M (or whatever the operator sets) is
 * global, so the mark is made without leaving OBS, and the main process pushes
 * `stream-marks:changed` to this window whether or not anyone is looking at it. Everything
 * on this page is therefore built to be re-rendered from a push at any moment, and nothing
 * here polls.
 *
 * WRITE-THROUGH, NO SAVE BUTTON. Every edit goes to the main process as it is made; the
 * main process writes the file before it answers. A Save button on a page that is also
 * being written to by a hotkey is a button that eventually overwrites a mark made while it
 * was on screen.
 *
 * NOTHING IS COERCED. A time that does not parse as hh:mm:ss leaves the text exactly as it
 * was typed, says so under the row, and writes nothing (LEDGER law 1) — a boundary silently
 * read as a different number is a story that starts in the wrong place, and it would not be
 * noticed until the video was cut.
 */
/**
 * One row of the marks list: the mark itself, its place in the night, and the STORY it ended
 * — where that story began and how long it ran. The durations live here rather than in the
 * template because a row's length is the gap to the PREVIOUS mark, which a template cannot
 * reach once the list has been reversed for display.
 */
interface MarkRow {
  mark: StreamMark;
  number: number;
  /** Elapsed seconds at which this story began (the previous mark, or 0 for the first). */
  startedAt: number;
  /** Seconds the story ran. Negative only while a time edit has marks briefly out of order. */
  duration: number;
}

@Component({
  selector: 'app-stream-marks',
  imports: [CommonModule, MatIconModule, MatButtonModule, MatTooltipModule],
  templateUrl: './stream-marks.html',
  styleUrl: './stream-marks.scss',
})
export class StreamMarks implements OnInit, OnDestroy {
  /** Every session on disk, newest first (the Past sessions list). */
  sessions = signal<StreamMarkSessionSummary[]>([]);
  /** The live session, or null when nothing is streaming. Null is a real answer. */
  live = signal<StreamMarkSession | null>(null);
  /** The session whose marks the list is showing — the live one unless a past one was clicked. */
  viewed = signal<StreamMarkSession | null>(null);
  hotkey = signal<StreamMarksHotkeyStatus | null>(null);

  /** The last failure, verbatim from the main process. Cleared by the next successful call. */
  error = signal<string | null>(null);
  /** start() found a session already live — his own words back at him, not an error. */
  notice = signal<string | null>(null);

  /** Ticks once a second so the running clock runs. Also what re-renders elapsed times. */
  now = signal(Date.now());
  private clock: any = null;

  /** Per-row typed text that has not been committed (or would not parse). Keyed by mark id. */
  timeDrafts = signal<Record<string, string>>({});
  timeErrors = signal<Record<string, string>>({});

  /** The "started at" field, HH:MM local, while it is being typed. */
  startedAtDraft = signal<string | null>(null);
  startedAtError = signal<string | null>(null);

  /** The accelerator field, so a hotkey the OS refused can actually be changed. */
  hotkeyDraft = signal<string | null>(null);

  /** Two-click delete for a past session. Never window.confirm — it blocks the whole app. */
  pendingDeleteId = signal<string | null>(null);

  /**
   * A mark whose label should receive the caret. Set from a change event: 'window' source
   * focuses immediately (he pressed the button on this page and is typing the name next),
   * 'hotkey' source waits for the window to be looked at again — moving focus in a window
   * behind OBS would put his next keystroke somewhere he cannot see.
   */
  private focusMarkId: string | null = null;
  private focusOnNextWindowFocus: string | null = null;

  private unsubscribeChanged: (() => void) | null = null;
  private unsubscribeHotkey: (() => void) | null = null;

  /** Labels are written through as they are typed, one timer per mark id. */
  private labelTimers = new Map<string, any>();

  constructor(private electron: ElectronService) {}

  async ngOnInit(): Promise<void> {
    // The listeners go on BEFORE the first read, so a hotkey press that lands between the
    // two is not the one mark this page never hears about.
    this.unsubscribeChanged = this.electron.onStreamMarksChanged((c) => this.onChange(c));
    this.unsubscribeHotkey = this.electron.onStreamMarksHotkeyStatus((st) => this.hotkey.set(st));
    this.clock = setInterval(() => this.now.set(Date.now()), 1000);
    await this.reload();
    await this.loadHotkey();
  }

  ngOnDestroy(): void {
    if (this.clock) clearInterval(this.clock);
    if (this.unsubscribeChanged) this.unsubscribeChanged();
    if (this.unsubscribeHotkey) this.unsubscribeHotkey();
    for (const t of this.labelTimers.values()) clearTimeout(t);
  }

  /**
   * The window came back to the front — if a hotkey mark arrived while it was away, its
   * label is what the operator wants to type into now.
   */
  @HostListener('window:focus')
  onWindowFocus(): void {
    if (!this.focusOnNextWindowFocus) return;
    this.focusMarkId = this.focusOnNextWindowFocus;
    this.focusOnNextWindowFocus = null;
    this.focusPendingLabel();
  }

  // ── Reading ─────────────────────────────────────────────────────────────────

  private async reload(): Promise<void> {
    try {
      const [sessions, live] = await Promise.all([
        this.electron.streamMarksList(),
        this.electron.streamMarksLive(),
      ]);
      this.sessions.set(sessions);
      this.live.set(live);
      // A past session being edited stays on screen across a reload; otherwise the live one
      // is what the page is for.
      const viewed = this.viewed();
      if (!viewed || (live && viewed.id === live.id)) {
        this.viewed.set(live);
      } else {
        this.viewed.set(await this.electron.streamMarksGet(viewed.id));
      }
      this.error.set(null);
    } catch (err: any) {
      this.error.set(this.messageOf(err));
    }
  }

  private async loadHotkey(): Promise<void> {
    try {
      this.hotkey.set(await this.electron.streamMarksHotkeyStatus());
    } catch (err: any) {
      this.error.set(this.messageOf(err));
    }
  }

  /** A push from the main process: a hotkey mark, or this window's own last call. */
  private onChange(change: StreamMarksChange): void {
    const viewed = this.viewed();
    if (change.session && (!viewed || viewed.id === change.session.id)) {
      this.viewed.set(change.session);
    }
    if (change.session && change.session.endedAt === null) {
      this.live.set(change.session);
    } else if (change.reason === 'session-ended' || change.reason === 'session-deleted') {
      if (this.live()?.id === change.sessionId) this.live.set(null);
    }
    if (change.reason === 'session-deleted' && viewed?.id === change.sessionId) {
      this.viewed.set(this.live());
    }
    if ((change.reason === 'mark-added' || change.reason === 'mark-inserted') && change.markId) {
      if (change.source === 'hotkey' && !document.hasFocus()) {
        this.focusOnNextWindowFocus = change.markId;
      } else {
        this.focusMarkId = change.markId;
        this.focusPendingLabel();
      }
    }
    // The summaries carry mark counts, so the Past sessions list is stale after any mark.
    void this.refreshSummaries();
  }

  private async refreshSummaries(): Promise<void> {
    try {
      this.sessions.set(await this.electron.streamMarksList());
    } catch (err: any) {
      this.error.set(this.messageOf(err));
    }
  }

  // ── The live panel ──────────────────────────────────────────────────────────

  isLiveViewed = computed(() => {
    const live = this.live();
    const viewed = this.viewed();
    return !!live && !!viewed && live.id === viewed.id;
  });

  /** hh:mm:ss since the live session started, recomputed every tick. */
  elapsedLabel = computed(() => {
    const live = this.live();
    if (!live) return '00:00:00';
    return formatElapsed(Math.max(0, (this.now() - Date.parse(live.startedAt)) / 1000));
  });

  /**
   * hh:mm:ss the CURRENT story has been running: since the last mark, or since the start
   * when nothing has been marked yet. Measured against the latest mark by time, not by
   * insertion — a mark nudged or inserted behind the newest one does not restart it. It is
   * the number Owen actually wants mid-stream ("how long have I been on this?"), which the
   * stream clock only answers with arithmetic.
   */
  segmentLabel = computed(() => {
    const live = this.live();
    if (!live) return '00:00:00';
    const streamElapsed = (this.now() - Date.parse(live.startedAt)) / 1000;
    const lastMarkAt = live.marks.reduce((max, m) => Math.max(max, m.at), 0);
    return formatElapsed(Math.max(0, streamElapsed - lastMarkAt));
  });

  async start(): Promise<void> {
    try {
      const result = await this.electron.streamMarksStart();
      this.live.set(result.session);
      this.viewed.set(result.session);
      this.notice.set(result.message);
      this.error.set(null);
      await this.refreshSummaries();
    } catch (err: any) {
      this.error.set(this.messageOf(err));
    }
  }

  /**
   * The Mark button — the same call the hotkey makes on a live session. It is only rendered
   * while one is live; with none, the store refuses and the refusal is printed here.
   */
  async mark(): Promise<void> {
    try {
      const { session } = await this.electron.streamMarksAddMark({});
      this.live.set(session.endedAt === null ? session : null);
      this.viewed.set(session);
      this.error.set(null);
      this.notice.set(null);
    } catch (err: any) {
      this.error.set(this.messageOf(err));
    }
  }

  async endStream(): Promise<void> {
    const live = this.live();
    if (!live) return;
    try {
      const session = await this.electron.streamMarksEnd(live.id);
      this.live.set(null);
      this.viewed.set(session);
      this.error.set(null);
      await this.refreshSummaries();
    } catch (err: any) {
      this.error.set(this.messageOf(err));
    }
  }

  /** HH:MM local of the viewed session's start — what the editable field shows. */
  startedAtField(): string {
    const draft = this.startedAtDraft();
    if (draft !== null) return draft;
    const viewed = this.viewed();
    if (!viewed) return '';
    const d = new Date(viewed.startedAt);
    return `${this.pad2(d.getHours())}:${this.pad2(d.getMinutes())}`;
  }

  onStartedAtInput(value: string): void {
    this.startedAtDraft.set(value);
  }

  /**
   * Commit a corrected start time.
   *
   * The DATE stays the session's own — this field fixes "I hit Start twenty minutes after I
   * went live", which is a time-of-day error, and a field that could also move the day would
   * need to say which day it had chosen. The marks' elapsed times deliberately do not move:
   * see the main process's updateSession, where the reason lives.
   */
  async commitStartedAt(): Promise<void> {
    const viewed = this.viewed();
    const draft = this.startedAtDraft();
    if (!viewed || draft === null) return;
    const m = /^(\d{1,2}):([0-5]\d)$/.exec(draft.trim());
    if (!m || Number(m[1]) > 23) {
      this.startedAtError.set(`"${draft}" is not a time of day — type it as HH:MM, e.g. 19:02.`);
      return;
    }
    const next = new Date(viewed.startedAt);
    next.setHours(Number(m[1]), Number(m[2]), 0, 0);
    try {
      const session = await this.electron.streamMarksUpdateSession({
        sessionId: viewed.id,
        startedAt: next.toISOString(),
      });
      this.viewed.set(session);
      if (session.endedAt === null) this.live.set(session);
      this.startedAtDraft.set(null);
      this.startedAtError.set(null);
      this.error.set(null);
      await this.refreshSummaries();
    } catch (err: any) {
      this.startedAtError.set(this.messageOf(err));
    }
  }

  async setHotkey(): Promise<void> {
    const draft = (this.hotkeyDraft() ?? '').trim();
    if (draft === '') return;
    try {
      this.hotkey.set(await this.electron.streamMarksSetHotkey(draft));
      this.hotkeyDraft.set(null);
      this.error.set(null);
    } catch (err: any) {
      this.error.set(this.messageOf(err));
    }
  }

  hotkeyField(): string {
    const draft = this.hotkeyDraft();
    if (draft !== null) return draft;
    return this.hotkey()?.accelerator ?? '';
  }

  // ── The marks list ──────────────────────────────────────────────────────────

  /**
   * Rows, MOST RECENT FIRST, each carrying its story number in stream order (1 at the
   * bottom). The list reads the way the night went if you read it upwards, and the row that
   * just appeared is the one under the cursor — which is the row about to be named.
   */
  rows = computed(() => {
    const viewed = this.viewed();
    if (!viewed) return [] as MarkRow[];
    // Marks are stored sorted by time, so the previous one is the story's start. Story 1
    // starts at 0 — the stream's own beginning — which is the same rule the editor's import
    // uses, and the two must not disagree about how long a story was.
    return viewed.marks
      .map((mark, i) => ({
        mark,
        number: i + 1,
        startedAt: i === 0 ? 0 : viewed.marks[i - 1].at,
        duration: mark.at - (i === 0 ? 0 : viewed.marks[i - 1].at),
      }))
      .reverse();
  });

  /** Identity is the mark id: rows re-render from a push event on every keystroke elsewhere. */
  trackRow(_index: number, row: MarkRow): string {
    return row.mark.id;
  }

  /**
   * How long the story was, hh:mm:ss. A NEGATIVE duration is possible while a time is being
   * corrected — two marks briefly out of order — and it is shown as such rather than as zero,
   * because a story that ends before it starts is a typo the operator needs to see.
   */
  durationLabel(row: MarkRow): string {
    return row.duration < 0 ? `-${formatElapsed(-row.duration)}` : formatElapsed(row.duration);
  }

  startedLabel(row: MarkRow): string {
    return formatElapsed(row.startedAt);
  }

  trackSession(_index: number, summary: StreamMarkSessionSummary): string {
    return summary.id;
  }

  timeField(mark: StreamMark): string {
    const draft = this.timeDrafts()[mark.id];
    return draft === undefined ? formatElapsed(mark.at) : draft;
  }

  onTimeInput(mark: StreamMark, value: string): void {
    this.timeDrafts.update((d) => ({ ...d, [mark.id]: value }));
  }

  /** Commit a typed elapsed time. Unparseable text is kept and named, never coerced. */
  async commitTime(mark: StreamMark): Promise<void> {
    const viewed = this.viewed();
    const draft = this.timeDrafts()[mark.id];
    if (!viewed || draft === undefined) return;
    const seconds = parseElapsed(draft);
    if (seconds === null) {
      this.setTimeError(mark.id, `"${draft}" is not a time — type it as hh:mm:ss, e.g. 01:12:33.`);
      return;
    }
    await this.writeTime(viewed.id, mark, seconds);
  }

  /**
   * −1 min / −30 s / +30 s: the "I forgot, and realised half a minute later" case, which is
   * most of them. A nudge that would take a mark before the start of the stream is REFUSED
   * with the reason rather than clamped to zero — a boundary silently parked at 00:00:00 is
   * a story that swallows the one before it.
   */
  async nudge(mark: StreamMark, deltaSeconds: number): Promise<void> {
    const viewed = this.viewed();
    if (!viewed) return;
    const next = mark.at + deltaSeconds;
    if (next < 0) {
      this.setTimeError(
        mark.id,
        `${formatElapsed(mark.at)} minus ${formatElapsed(-deltaSeconds)} is before the stream started.`
      );
      return;
    }
    await this.writeTime(viewed.id, mark, next);
  }

  private async writeTime(sessionId: string, mark: StreamMark, at: number): Promise<void> {
    try {
      const { session } = await this.electron.streamMarksUpdateMark({ sessionId, markId: mark.id, at });
      this.viewed.set(session);
      if (session.endedAt === null) this.live.set(session);
      this.clearDraft(mark.id);
      this.error.set(null);
    } catch (err: any) {
      this.setTimeError(mark.id, this.messageOf(err));
    }
  }

  /**
   * Labels write through as they are typed, debounced.
   *
   * The debounce is the only timer on this page and it exists for one reason: without it
   * every keystroke is a JSON file written to disk. 350 ms is short enough that closing the
   * window on the next keystroke still saves what was typed, because the blur that closing
   * causes flushes it (see commitLabel).
   */
  onLabelInput(mark: StreamMark, value: string): void {
    const existing = this.labelTimers.get(mark.id);
    if (existing) clearTimeout(existing);
    this.labelTimers.set(mark.id, setTimeout(() => this.writeLabel(mark, value), 350));
  }

  /** Enter or blur: flush the pending label write now rather than in 350 ms. */
  commitLabel(mark: StreamMark, value: string): void {
    const existing = this.labelTimers.get(mark.id);
    if (existing) {
      clearTimeout(existing);
      this.labelTimers.delete(mark.id);
    }
    void this.writeLabel(mark, value);
  }

  private async writeLabel(mark: StreamMark, label: string): Promise<void> {
    const viewed = this.viewed();
    if (!viewed) return;
    this.labelTimers.delete(mark.id);
    try {
      const { session } = await this.electron.streamMarksUpdateMark({
        sessionId: viewed.id,
        markId: mark.id,
        label,
      });
      // The session is NOT written back into `viewed` here: the field being typed into is
      // bound to the mark, and replacing the object under the caret would move it to the end
      // of the text on every debounce tick. The push event covers the other windows.
      if (session.endedAt === null) this.live.set(session);
      this.error.set(null);
    } catch (err: any) {
      this.error.set(this.messageOf(err));
    }
  }

  /** Enter commits and moves on: to the next row down, which is the next story back. */
  onLabelEnter(event: Event, mark: StreamMark, value: string): void {
    event.preventDefault();
    this.commitLabel(mark, value);
    const rows = this.rows();
    const i = rows.findIndex((r) => r.mark.id === mark.id);
    const next = i >= 0 && i + 1 < rows.length ? rows[i + 1].mark.id : null;
    if (next) {
      this.focusMarkId = next;
      this.focusPendingLabel();
    } else {
      (event.target as HTMLInputElement).blur();
    }
  }

  onLabelEscape(event: Event): void {
    (event.target as HTMLInputElement).blur();
  }

  /**
   * Insert a boundary BEFORE this one — a story that was never marked because the key was
   * not pressed. It lands halfway into the story this mark ends, which is inside the span it
   * is splitting and therefore always a legal boundary; the time field and the nudges move
   * it from there.
   */
  async insertBefore(row: { mark: StreamMark; number: number }): Promise<void> {
    const viewed = this.viewed();
    if (!viewed) return;
    const previousAt = row.number >= 2 ? viewed.marks[row.number - 2].at : 0;
    const at = Math.round((previousAt + row.mark.at) / 2);
    if (at <= previousAt || at >= row.mark.at) {
      this.setTimeError(
        row.mark.id,
        'There is no room for another boundary before this one — the story it would split is ' +
        'less than two seconds long.'
      );
      return;
    }
    try {
      const { session } = await this.electron.streamMarksInsertMark({ sessionId: viewed.id, at, label: '' });
      this.viewed.set(session);
      if (session.endedAt === null) this.live.set(session);
      this.error.set(null);
    } catch (err: any) {
      this.error.set(this.messageOf(err));
    }
  }

  async deleteMark(mark: StreamMark): Promise<void> {
    const viewed = this.viewed();
    if (!viewed) return;
    try {
      const session = await this.electron.streamMarksDeleteMark({ sessionId: viewed.id, markId: mark.id });
      this.viewed.set(session);
      if (session.endedAt === null) this.live.set(session);
      this.clearDraft(mark.id);
      this.error.set(null);
    } catch (err: any) {
      this.error.set(this.messageOf(err));
    }
  }

  // ── Past sessions ───────────────────────────────────────────────────────────

  async openSession(summary: StreamMarkSessionSummary): Promise<void> {
    try {
      this.viewed.set(await this.electron.streamMarksGet(summary.id));
      this.timeDrafts.set({});
      this.timeErrors.set({});
      this.startedAtDraft.set(null);
      this.startedAtError.set(null);
      this.error.set(null);
    } catch (err: any) {
      this.error.set(this.messageOf(err));
    }
  }

  /** First click arms, second click deletes. Clicking anything else disarms. */
  async deleteSession(summary: StreamMarkSessionSummary): Promise<void> {
    if (this.pendingDeleteId() !== summary.id) {
      this.pendingDeleteId.set(summary.id);
      return;
    }
    try {
      await this.electron.streamMarksDeleteSession(summary.id);
      this.pendingDeleteId.set(null);
      if (this.viewed()?.id === summary.id) this.viewed.set(this.live());
      if (this.live()?.id === summary.id) this.live.set(null);
      await this.refreshSummaries();
      this.error.set(null);
    } catch (err: any) {
      this.pendingDeleteId.set(null);
      this.error.set(this.messageOf(err));
    }
  }

  cancelDelete(): void {
    this.pendingDeleteId.set(null);
  }

  // ── Formatting ──────────────────────────────────────────────────────────────

  sessionLabel(session: { startedAt: string; endedAt: string | null }): string {
    const d = new Date(session.startedAt);
    const date = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const time = `${this.pad2(d.getHours())}:${this.pad2(d.getMinutes())}`;
    return `${date}, ${time}`;
  }

  elapsedOf(mark: StreamMark): string {
    return formatElapsed(mark.at);
  }

  timeError(markId: string): string | null {
    return this.timeErrors()[markId] ?? null;
  }

  private setTimeError(markId: string, message: string): void {
    this.timeErrors.update((e) => ({ ...e, [markId]: message }));
  }

  private clearDraft(markId: string): void {
    this.timeDrafts.update((d) => {
      const next = { ...d };
      delete next[markId];
      return next;
    });
    this.timeErrors.update((e) => {
      const next = { ...e };
      delete next[markId];
      return next;
    });
  }

  /**
   * Put the caret in a label that has just appeared.
   *
   * The row does not exist in the DOM until the signal that added it has rendered, so this
   * waits a turn. It runs at most once per pending id and gives up silently ONLY when the
   * row is genuinely not there — which happens when the mark landed in a session this window
   * is not currently showing, and is not a failure.
   */
  private focusPendingLabel(): void {
    const id = this.focusMarkId;
    if (!id) return;
    this.focusMarkId = null;
    setTimeout(() => {
      const el = document.getElementById(`sm-label-${id}`) as HTMLInputElement | null;
      if (el) {
        el.focus();
        el.select();
      }
    });
  }

  private pad2(n: number): string {
    return n < 10 ? `0${n}` : String(n);
  }

  /** Electron wraps a handler's rejection; the sentence the main process wrote is the UI. */
  private messageOf(err: any): string {
    const raw = err instanceof Error ? err.message : String(err);
    const inner = raw.match(/Error invoking remote method '[^']*':\s*([\s\S]*)$/);
    return (inner ? inner[1] : raw).replace(/^Error:\s*/, '').trim() || raw;
  }
}
