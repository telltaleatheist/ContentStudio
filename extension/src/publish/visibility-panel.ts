// The shelf's Visibility section: the open video's visibility now, its scheduled changes
// (pending and past), and add / edit / cancel. The changes run on the scheduler on Triton
// (VISIBILITY-SCHEDULER-PLAN.md), so this section works with the ContentStudio app closed
// and never touches the localhost ingest server.
//
// It owns ONE persistent element that the shelf re-attaches on every shelf render, and it
// repaints only its own contents. That is deliberate: the shelf rebuilds its whole card on
// navigation, surface flips and fill logs, and a form rebuilt from scratch on each of those
// would drop what the operator was typing. The draft lives here, and the element moving
// between shelf renders keeps its inputs as they were.
//
// The shelf renders; the content script owns the transport (VisibilityTransport), the same
// split the rest of the shelf uses. Every server message is shown verbatim; nothing is
// retried behind the operator's back, and nothing is substituted for an answer that did not
// come.

import type {
  NewSchedulerJob,
  SchedulerJob,
  SchedulerJobPatch,
  SchedulerJobWithWarnings,
  SchedulerVideo,
  Visibility,
} from '../scheduler/scheduler-client';
import {
  VISIBILITIES,
  describeJob,
  formatLocal,
  localDateOf,
  localInputsOf,
  pendingBadge,
  suggestedTarget,
  runAtFromLocal,
  scheduleClashWarning,
  splitJobs,
  visibilityLabel,
} from '../scheduler/scheduler-format';
import { PublishBridgeError } from './publish-messages';

export interface VisibilityTransport {
  video(videoId: string): Promise<SchedulerVideo>;
  jobs(videoId: string): Promise<SchedulerJob[]>;
  create(job: NewSchedulerJob): Promise<SchedulerJobWithWarnings>;
  edit(jobId: string, patch: SchedulerJobPatch): Promise<SchedulerJobWithWarnings>;
  cancel(jobId: string): Promise<SchedulerJob>;
  openOptions(): Promise<null>;
}

/** The words that differ between the shelf's section and the box in Studio's dialog. */
export interface VisibilityPanelWords {
  heading: string;
  saveLabel: string;
  formNote?: string;
}

/** Past changes shown before "show all". */
const HISTORY_SHOWN = 5;

export const VISIBILITY_CSS = `
.vis { margin-top: 10px; border-top: 1px solid #383838; padding-top: 8px; }
.vhead { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.vtitle {
  flex: 1; font-size: 10px; font-weight: 700; letter-spacing: .08em;
  text-transform: uppercase; color: #ff6b35;
}
.vnow { font-size: 11px; color: #bbb; }
.vnow b { color: #f1f1f1; }
.vsub {
  font-size: 10px; color: #8f8f8f; text-transform: uppercase; letter-spacing: .06em;
  margin: 8px 0 3px;
}
.vrow {
  padding: 5px 7px; margin-bottom: 4px; border-radius: 6px;
  background: #282828; border: 1px solid #383838;
}
.vrow.editing { border-color: #ff6b35; }
.vrow.failed { background: #2c1d1d; border-color: #5a2b2b; }
.vrow.cancelled { opacity: .6; }
.vl1 { display: flex; gap: 6px; align-items: baseline; }
.vwhat { flex: 1; font-weight: 600; }
.vrow.done .vwhat { color: #7ddc7d; }
.vrow.failed .vwhat, .vrow.failed .vdet { color: #ff8a80; }
.vrow.retrying .vdet { color: #ffcc66; }
.vwhen { color: #bbb; font-size: 11px; white-space: nowrap; }
.vnote { color: #cfcfcf; font-size: 11px; font-style: italic; word-break: break-word; }
.vdet { color: #8f8f8f; font-size: 11px; word-break: break-word; }
.vbtns { display: flex; gap: 4px; margin-top: 4px; }
button.vbtn {
  cursor: pointer; font: inherit; font-size: 10px; padding: 2px 8px; border-radius: 10px;
  background: #303030; color: #bbb; border: 1px solid #454545;
}
button.vbtn:hover:not(:disabled) { border-color: #ff6b35; color: #f1f1f1; }
button.vbtn.danger:hover:not(:disabled) { border-color: #ff8a80; color: #ff8a80; }
button.vbtn:disabled { opacity: .4; cursor: default; }
button.vadd {
  width: 100%; cursor: pointer; margin-top: 6px; padding: 6px 9px; font-size: 11px;
  color: #f1f1f1; background: #303030; border: 1px solid #454545; border-radius: 6px;
}
button.vadd:hover:not(:disabled) { border-color: #ff6b35; }
button.vadd:disabled { opacity: .4; cursor: default; }
.vform {
  display: flex; flex-direction: column; gap: 5px; margin-top: 6px; padding: 7px;
  background: #262626; border: 1px solid #454545; border-radius: 6px;
}
.vform select, .vform input {
  width: 100%; padding: 5px 7px; font: inherit; font-size: 11px; color-scheme: dark;
  color: #f1f1f1; background: #303030; border: 1px solid #454545; border-radius: 6px;
}
.vform select:focus, .vform input:focus { outline: none; border-color: #ff6b35; }
.vpair { display: flex; gap: 5px; }
.vpair input { flex: 1; min-width: 0; }
.vacts { display: flex; gap: 5px; }
button.vsave {
  flex: 1; cursor: pointer; padding: 6px; font-size: 11px; font-weight: 700; border-radius: 6px;
  color: #fff; background: #ff6b35; border: 1px solid #ff6b35;
}
button.vclose {
  cursor: pointer; padding: 6px 10px; font-size: 11px; border-radius: 6px;
  color: #bbb; background: #303030; border: 1px solid #454545;
}
button.vsave:disabled, button.vclose:disabled { opacity: .5; cursor: default; }
button.vlink {
  cursor: pointer; padding: 0; font: inherit; font-size: 11px;
  color: #ff6b35; background: transparent; border: 0; text-decoration: underline;
}
`;

interface Draft {
  target: Visibility | '';
  date: string;
  time: string;
  note: string;
}

type FormMode = { mode: 'add' } | { mode: 'edit'; job: SchedulerJob };

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const kindOf = (error: unknown) => (error instanceof PublishBridgeError ? error.kind : null);

export class VisibilityPanel {
  /** Re-attached by the shelf on each of its renders; never rebuilt. */
  readonly el: HTMLElement;

  private videoId: string | null = null;
  /** Load sequence: a reply for a video the operator has since left is dropped. */
  private seq = 0;
  private loading = false;
  /** The video has changed (or a refresh was asked) since it was last read. See shown(). */
  private stale = false;

  private noKey: string | null = null;
  private video: SchedulerVideo | null = null;
  /** The server's 404 message: no connected channel owns this video. */
  private notOwned: string | null = null;
  private videoError: string | null = null;
  private jobs: SchedulerJob[] | null = null;
  private jobsError: string | null = null;

  private form: FormMode | null = null;
  private draft: Draft = { target: '', date: '', time: '', note: '' };
  private formError: string | null = null;
  private busy = false;
  private actionError: string | null = null;
  /** What the server said about the last saved change, shown until the next action. */
  private warnings: string[] = [];
  private confirmCancel: string | null = null;
  private showAllHistory = false;

  constructor(
    private transport: VisibilityTransport,
    private words: VisibilityPanelWords = { heading: 'Visibility', saveLabel: 'Schedule' },
  ) {
    this.el = document.createElement('div');
    this.el.className = 'vis';
    // Typing a note must not reach Studio's own keyboard shortcuts on the page underneath.
    this.el.addEventListener('keydown', (e) => e.stopPropagation());
  }

  /** The Studio page now shows `videoId` (or none). A new video starts from nothing. */
  setVideo(videoId: string | null): void {
    if (videoId === this.videoId) return;
    this.videoId = videoId;
    this.seq += 1;
    this.loading = false;
    this.noKey = null;
    this.video = null;
    this.notOwned = null;
    this.videoError = null;
    this.jobs = null;
    this.jobsError = null;
    this.form = null;
    this.formError = null;
    this.actionError = null;
    this.warnings = [];
    this.confirmCancel = null;
    this.showAllHistory = false;
    this.stale = videoId !== null;
    this.render();
  }

  /**
   * The shelf has just drawn this section. Reads the video if it has not been read yet.
   *
   * Lazy on purpose: every read of the video is a YouTube API call on the scheduler's
   * shared quota (one per connected channel tried), and the operator walks the channel
   * video by video with the shelf collapsed or on Reports. Only a section on screen asks.
   */
  shown(): void {
    if (!this.stale || !this.videoId) return;
    this.stale = false;
    void this.load();
  }

  /** Re-read the video and its changes (the shelf's refresh button). The form stays open. */
  reload(): void {
    if (!this.videoId) return;
    if (this.el.isConnected) void this.load();
    else this.stale = true;
  }

  private async load(): Promise<void> {
    const videoId = this.videoId;
    if (!videoId) return;
    const seq = (this.seq += 1);
    this.loading = true;
    this.render();

    const [video, jobs] = await Promise.allSettled([this.transport.video(videoId), this.transport.jobs(videoId)]);
    if (seq !== this.seq) return;
    this.loading = false;
    this.noKey = null;
    this.video = null;
    this.notOwned = null;
    this.videoError = null;
    this.jobs = null;
    this.jobsError = null;

    if (video.status === 'fulfilled') this.video = video.value;
    else if (kindOf(video.reason) === 'no-key') this.noKey = messageOf(video.reason);
    else if (kindOf(video.reason) === 'not-found') this.notOwned = messageOf(video.reason);
    else this.videoError = messageOf(video.reason);

    if (jobs.status === 'fulfilled') this.jobs = jobs.value;
    else if (kindOf(jobs.reason) === 'no-key') this.noKey = messageOf(jobs.reason);
    else this.jobsError = messageOf(jobs.reason);

    this.render();
  }

  /** After a save or cancel: the list is re-read rather than patched, so it is the server's. */
  private async reloadJobs(): Promise<void> {
    const videoId = this.videoId;
    if (!videoId) return;
    const seq = this.seq;
    try {
      const jobs = await this.transport.jobs(videoId);
      if (seq !== this.seq) return;
      this.jobs = jobs;
      this.jobsError = null;
    } catch (error) {
      if (seq !== this.seq) return;
      this.jobs = null;
      this.jobsError = `The scheduler took that, but the list could not be re-read: ${messageOf(error)}`;
    }
  }

  // -------------------------------------------------------------------- render

  private render(): void {
    // Keep focus across a repaint of this section (a select change re-renders the form).
    const focusedName = (this.el.getRootNode() as ShadowRoot | Document).activeElement?.getAttribute?.('data-v') ?? null;
    this.el.textContent = '';
    this.el.appendChild(this.buildHead());
    this.buildBody();
    if (focusedName) (this.el.querySelector(`[data-v="${focusedName}"]`) as HTMLElement | null)?.focus();
  }

  private buildHead(): HTMLElement {
    const head = document.createElement('div');
    head.className = 'vhead';
    const title = document.createElement('span');
    title.className = 'vtitle';
    title.textContent = this.words.heading;
    head.appendChild(title);
    const badge = this.jobs ? pendingBadge(this.jobs) : null;
    if (badge) head.appendChild(this.span('chip', badge));
    if (this.loading) head.appendChild(this.span('muted', 'loading…'));
    return head;
  }

  private buildBody(): void {
    const add = (node: Node) => this.el.appendChild(node);

    if (this.noKey) {
      const line = this.div('muted', 'No scheduler key is set, so scheduled visibility changes cannot be shown or made. ');
      const link = document.createElement('button');
      link.className = 'vlink';
      link.textContent = 'Open Options';
      link.addEventListener('click', () => {
        this.transport.openOptions().catch((error: unknown) => {
          this.actionError = `Could not open Options: ${messageOf(error)}`;
          this.render();
        });
      });
      line.appendChild(link);
      add(line);
      if (this.actionError) add(this.div('err', this.actionError));
      return;
    }

    const nothingYet = !this.video && !this.notOwned && !this.videoError && !this.jobs && !this.jobsError;
    if (nothingYet) {
      if (!this.loading) add(this.div('muted', 'Not loaded.'));
      return;
    }

    if (this.notOwned) {
      add(this.div('note differ', 'No channel connected to the scheduler owns this video, so its visibility cannot be scheduled here.'));
      add(this.div('sub', `Scheduler: ${this.notOwned}`));
    }
    if (this.videoError) add(this.div('err', `Could not read this video's visibility: ${this.videoError}`));

    if (this.video) {
      const now = this.div('vnow', 'Now: ');
      const b = document.createElement('b');
      b.textContent = visibilityLabel(this.video.privacyStatus);
      now.appendChild(b);
      add(now);
      if (this.video.publishAt) add(this.div('vnow', `YouTube will publish at ${formatLocal(this.video.publishAt)}`));
    }

    if (this.jobsError) add(this.div('err', `Could not read the scheduled changes: ${this.jobsError}`));
    if (this.jobs) this.buildLists(this.jobs);

    if (this.actionError) add(this.div('err', this.actionError));
    for (const w of this.warnings) add(this.div('note differ', w));

    // Adding needs the video read (its visibility and YouTube's own schedule are what the
    // form warns from); editing an existing change only needs the change.
    if (this.form) add(this.buildForm(this.form));
    else if (this.video) {
      const btn = document.createElement('button');
      btn.className = 'vadd';
      btn.textContent = '+ Schedule a change';
      btn.disabled = this.busy;
      btn.addEventListener('click', () => this.openForm({ mode: 'add' }));
      add(btn);
    }
  }

  private buildLists(jobs: SchedulerJob[]): void {
    const { pending, history } = splitJobs(jobs);

    this.el.appendChild(this.div('vsub', 'Scheduled'));
    if (!pending.length) this.el.appendChild(this.div('muted', 'No pending changes.'));
    for (const job of pending) this.el.appendChild(this.buildRow(job, true));

    if (!history.length) return;
    this.el.appendChild(this.div('vsub', 'History'));
    const shown = this.showAllHistory ? history : history.slice(0, HISTORY_SHOWN);
    for (const job of shown) this.el.appendChild(this.buildRow(job, false));
    if (history.length > HISTORY_SHOWN) {
      const more = document.createElement('button');
      more.className = 'more';
      more.textContent = this.showAllHistory ? 'Show fewer' : `${history.length - HISTORY_SHOWN} older…`;
      more.addEventListener('click', () => {
        this.showAllHistory = !this.showAllHistory;
        this.render();
      });
      this.el.appendChild(more);
    }
  }

  private buildRow(job: SchedulerJob, actionable: boolean): HTMLElement {
    const d = describeJob(job, (iso) => formatLocal(iso));
    const editing = this.form?.mode === 'edit' && this.form.job.id === job.id;
    const row = document.createElement('div');
    row.className = `vrow ${d.tone}${editing ? ' editing' : ''}`;

    const l1 = this.div('vl1', '');
    l1.append(this.span('vwhat', d.headline), this.span('vwhen', formatLocal(job.runAt)));
    row.appendChild(l1);
    if (job.note) row.appendChild(this.div('vnote', job.note));
    for (const line of d.details) row.appendChild(this.div('vdet', line));
    row.title = `Change ${job.id}, made by ${job.createdBy} ${formatLocal(job.createdAt)}`;

    if (!actionable) return row;
    const btns = this.div('vbtns', '');
    if (this.confirmCancel === job.id) {
      btns.append(
        this.button('vbtn danger', 'Yes, cancel it', () => void this.cancel(job)),
        this.button('vbtn', 'Keep', () => {
          this.confirmCancel = null;
          this.render();
        }),
      );
    } else {
      btns.append(
        this.button('vbtn', 'Edit', () => this.openForm({ mode: 'edit', job })),
        this.button('vbtn danger', 'Cancel', () => {
          this.confirmCancel = job.id;
          this.render();
        }),
      );
    }
    row.appendChild(btns);
    return row;
  }

  private openForm(mode: FormMode): void {
    this.form = mode;
    this.formError = null;
    this.actionError = null;
    this.confirmCancel = null;
    if (mode.mode === 'edit') {
      const at = localInputsOf(mode.job.runAt);
      this.draft = { target: mode.job.target, date: at.date, time: at.time, note: mode.job.note };
    } else {
      // Today's date and the likely flip as a starting point; the time is left for the
      // operator to choose, so nothing is scheduled at a time nobody typed.
      this.draft = { target: this.video ? suggestedTarget(this.video.privacyStatus) : '', date: localDateOf(new Date()), time: '', note: '' };
    }
    this.render();
  }

  private buildForm(mode: FormMode): HTMLElement {
    const form = document.createElement('div');
    form.className = 'vform';

    form.appendChild(this.div('vdet', mode.mode === 'add' ? 'New change' : `Editing the change to ${visibilityLabel(mode.job.target)}`));

    const select = document.createElement('select');
    select.setAttribute('data-v', 'target');
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Change to…';
    placeholder.disabled = true;
    select.appendChild(placeholder);
    for (const v of VISIBILITIES) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = this.video?.privacyStatus === v ? `${visibilityLabel(v)} (now)` : visibilityLabel(v);
      select.appendChild(opt);
    }
    select.value = this.draft.target;
    select.addEventListener('change', () => {
      this.draft.target = select.value as Visibility;
      this.render(); // the YouTube-schedule warning depends on the target
    });
    form.appendChild(select);

    const pair = this.div('vpair', '');
    const date = this.input('date', 'date', this.draft.date, (v) => (this.draft.date = v));
    const time = this.input('time', 'time', this.draft.time, (v) => (this.draft.time = v));
    pair.append(date, time);
    form.appendChild(pair);

    const note = this.input('text', 'note', this.draft.note, (v) => (this.draft.note = v));
    note.placeholder = 'Note (optional), e.g. Sponsor: X review';
    note.maxLength = 200;
    form.appendChild(note);

    form.appendChild(this.div('vdet', `Times are in this computer's time zone (${Intl.DateTimeFormat().resolvedOptions().timeZone}).`));

    if (this.words.formNote) form.appendChild(this.div('vdet', this.words.formNote));

    const clash = scheduleClashWarning(this.video?.publishAt ?? null, this.draft.target || null, (iso) => formatLocal(iso));
    if (clash) form.appendChild(this.div('note differ', clash));
    if (this.formError) form.appendChild(this.div('err', this.formError));

    const acts = this.div('vacts', '');
    const save = this.button('vsave', this.busy ? 'Saving…' : mode.mode === 'add' ? this.words.saveLabel : 'Save changes', () => void this.save(mode));
    const close = this.button('vclose', 'Close', () => {
      this.form = null;
      this.formError = null;
      this.render();
    });
    acts.append(save, close);
    form.appendChild(acts);
    return form;
  }

  private async save(mode: FormMode): Promise<void> {
    if (this.busy || !this.videoId) return;
    const target = this.draft.target;
    if (!target) {
      this.formError = 'Pick a visibility.';
      return this.render();
    }
    const runAt = runAtFromLocal(this.draft.date, this.draft.time);
    if (!runAt.ok) {
      this.formError = runAt.error;
      return this.render();
    }
    const note = this.draft.note.trim();

    let patch: SchedulerJobPatch | null = null;
    if (mode.mode === 'edit') {
      // Only what changed is sent: re-sending an unchanged runAt would re-check it against
      // "at least a minute ahead" and refuse a note edit on a change due in 30 seconds.
      const job = mode.job;
      patch = {};
      if (target !== job.target) patch.target = target;
      if (Date.parse(runAt.iso) !== Date.parse(job.runAt)) patch.runAt = runAt.iso;
      if (note !== job.note) patch.note = note;
      if (!Object.keys(patch).length) {
        this.formError = 'Nothing has changed.';
        return this.render();
      }
    }

    const seq = this.seq;
    this.busy = true;
    this.formError = null;
    this.actionError = null;
    this.warnings = [];
    this.render();
    try {
      const out =
        mode.mode === 'add'
          ? await this.transport.create({ videoId: this.videoId, target, runAt: runAt.iso, note })
          : await this.transport.edit(mode.job.id, patch!);
      if (seq !== this.seq) return;
      this.warnings = out.warnings;
      this.form = null;
      await this.reloadJobs();
    } catch (error) {
      if (seq !== this.seq) return;
      // The server's reason, verbatim, beside the form that caused it.
      this.formError = messageOf(error);
    } finally {
      this.busy = false;
      if (seq === this.seq) this.render();
    }
  }

  private async cancel(job: SchedulerJob): Promise<void> {
    if (this.busy) return;
    const seq = this.seq;
    this.busy = true;
    this.actionError = null;
    this.warnings = [];
    this.render();
    try {
      await this.transport.cancel(job.id);
      if (seq !== this.seq) return;
      this.confirmCancel = null;
      if (this.form?.mode === 'edit' && this.form.job.id === job.id) this.form = null;
      await this.reloadJobs();
    } catch (error) {
      if (seq !== this.seq) return;
      this.actionError = `Could not cancel the change to ${visibilityLabel(job.target)}: ${messageOf(error)}`;
    } finally {
      this.busy = false;
      if (seq === this.seq) this.render();
    }
  }

  // ------------------------------------------------------------------- bits

  private div(className: string, text: string): HTMLDivElement {
    const d = document.createElement('div');
    d.className = className;
    if (text) d.textContent = text;
    return d;
  }

  private span(className: string, text: string): HTMLSpanElement {
    const s = document.createElement('span');
    s.className = className;
    s.textContent = text;
    return s;
  }

  private button(className: string, text: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = className;
    b.textContent = text;
    b.disabled = this.busy;
    b.addEventListener('click', onClick);
    return b;
  }

  private input(type: string, name: string, value: string, onInput: (v: string) => void): HTMLInputElement {
    const i = document.createElement('input');
    i.type = type;
    i.value = value;
    i.setAttribute('data-v', name);
    i.disabled = this.busy;
    i.addEventListener('input', () => onInput(i.value));
    return i;
  }
}
