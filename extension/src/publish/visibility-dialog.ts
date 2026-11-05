// A "Schedule change" box inside Studio's own visibility dialog, under its "Save or publish" and
// "Schedule" boxes. Each line says what the video WILL be and when, and + adds another line, so
// a chain is just several changes (Owen, 2026-11-05: "we just need to know what it WILL be set to
// and when"). The video's status now is never read: it is set in Studio, and a change runs
// whatever it is by then. The changes run on the scheduler on Triton.
//
// The dialog is one element at the end of <body>, reused for every video, and it does not say
// which video it is for. So the click that opens it is what names the video: its row on the
// Content list, or the URL on a video's Details page. Read live 2026-11-05, on both pages.

import type { SchedulerJob, Visibility } from '../scheduler/scheduler-client';
import {
  VISIBILITIES,
  describeJob,
  formatLocal,
  localDateOf,
  localInputsOf,
  runAtFromLocal,
  splitJobs,
  visibilityLabel,
} from '../scheduler/scheduler-format';
import { visible, waitFor } from './dom';
import { videoIdFromUrl } from './page';
import { PublishBridgeError } from './publish-messages';
import type { VisibilityTransport } from './visibility-panel';

const DIALOG_SELECT = 'ytcp-video-visibility-edit-popup tp-yt-paper-dialog ytcp-video-visibility-select';
const LIST_CELL = 'ytcp-video-row .tablecell-visibility';
const DETAILS_FIELD = 'ytcp-video-metadata-visibility';
/** Failed changes stay in view until there are this many newer ones. */
const FAILED_SHOWN = 3;

const CSS = `
:host { display: block; margin-top: 16px; font-size: 13px; color: #f1f1f1; }
.box {
  max-height: 45vh; overflow-y: auto; padding: 4px 20px 16px;
  border: 1px solid #f1f1f1; border-radius: 16px;
}
.title { margin: 12px 0 10px; font-size: 16px; font-weight: 500; }
.line { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.saved { padding: 6px 8px; background: #303030; border-radius: 8px; }
.saved.failed { background: #2c1d1d; color: #ff8a80; }
.what { flex: 1; min-width: 0; }
.detail { flex-basis: 100%; font-size: 11px; color: #aaa; word-break: break-word; }
.saved.failed .detail { color: #ff8a80; }
.lead { white-space: nowrap; }
select, input {
  padding: 6px 8px; font: inherit; color: #f1f1f1; color-scheme: dark;
  background: #282828; border: 1px solid #909090; border-radius: 4px;
}
select:focus, input:focus { outline: none; border-color: #3ea6ff; }
button {
  cursor: pointer; font: inherit; padding: 5px 12px; border-radius: 18px;
  color: #f1f1f1; background: #3f3f3f; border: 0;
}
button:hover:not(:disabled) { background: #535353; }
button:disabled { opacity: .5; cursor: default; }
button.round { width: 30px; height: 30px; padding: 0; font-size: 18px; line-height: 1; border-radius: 50%; }
button.primary { color: #0f0f0f; background: #f1f1f1; font-weight: 500; }
button.primary:hover:not(:disabled) { background: #d9d9d9; }
.foot { display: flex; align-items: center; gap: 10px; margin-top: 4px; }
.hint { flex: 1; font-size: 11px; color: #aaa; }
.err { color: #ff8a80; font-size: 12px; margin: 0 0 8px; word-break: break-word; }
.warn { color: #ffcf6b; font-size: 12px; margin: 0 0 8px; word-break: break-word; }
.muted { color: #aaa; margin-bottom: 8px; }
`;

interface DraftLine {
  /** The saved change this line is editing, or null for a new one. */
  job: SchedulerJob | null;
  target: Visibility | '';
  date: string;
  time: string;
  error: string | null;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const blankLine = (date = localDateOf(new Date())): DraftLine => ({ job: null, target: '', date, time: '', error: null });
const untouched = (line: DraftLine) => !line.job && !line.target && !line.time;

export class VisibilityDialog {
  private readonly host = document.createElement('div');
  private readonly box = document.createElement('div');
  /** The latest click wins: a wait for an earlier one stops attaching. */
  private opening = 0;

  private videoId: string | null = null;
  /** A reply for a video the dialog has since moved off is dropped. */
  private seq = 0;
  private loading = false;
  private busy = false;
  private needsConnect = false;
  private jobs: SchedulerJob[] | null = null;
  private problem: string | null = null;
  private warnings: string[] = [];
  private lines: DraftLine[] = [blankLine()];

  constructor(private transport: VisibilityTransport) {
    const root = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    this.box.className = 'box';
    // Typing here must not reach Studio's own keyboard shortcuts on the page underneath.
    this.box.addEventListener('keydown', (e) => e.stopPropagation());
    root.append(style, this.box);

    // The dialog sizes itself to what it held when it opened; another line needs it to fit
    // again. An event, because the method is out of reach of a content script.
    new ResizeObserver(() => {
      this.host.closest('tp-yt-paper-dialog')?.dispatchEvent(new CustomEvent('iron-resize'));
    }).observe(this.host);
  }

  start(): void {
    document.addEventListener('click', (event) => this.onClick(event), true);
  }

  /** Read the changes again, if the box is on screen: the extension has just been connected. */
  reload(): void {
    if (this.host.isConnected) void this.load();
  }

  private onClick(event: Event): void {
    if (!(event.target instanceof Element)) return;
    const cell = event.target.closest(LIST_CELL);
    if (!cell && !event.target.closest(DETAILS_FIELD)) return;

    const videoId = cell ? videoIdOfRow(cell) : videoIdFromUrl();
    const opening = (this.opening += 1);
    waitFor(() => visible<HTMLElement>(DIALOG_SELECT), "Studio's visibility dialog", 3000, 100)
      .then((select) => {
        if (opening === this.opening) this.attach(select, videoId);
      })
      .catch((error: unknown) => {
        console.error('[ContentStudio] no place for "Schedule change":', error);
      });
  }

  private attach(select: HTMLElement, videoId: string | null): void {
    if (this.host.parentElement !== select) select.appendChild(this.host);
    if (videoId !== this.videoId) {
      this.videoId = videoId;
      this.lines = [blankLine()];
      this.warnings = [];
    }
    void this.load();
  }

  private async load(): Promise<void> {
    const seq = (this.seq += 1);
    const videoId = this.videoId;
    this.jobs = null;
    this.needsConnect = false;
    this.problem = videoId ? null : 'Could not tell which video this dialog is for, so no change can be scheduled here.';
    this.loading = videoId !== null;
    this.render();
    if (!videoId) return;
    try {
      const jobs = await this.transport.jobs(videoId);
      if (seq !== this.seq) return;
      this.jobs = jobs;
    } catch (error) {
      if (seq !== this.seq) return;
      if (error instanceof PublishBridgeError && error.kind === 'no-key') this.needsConnect = true;
      else this.problem = `Could not read this video's scheduled changes: ${messageOf(error)}`;
    }
    this.loading = false;
    this.render();
  }

  // -------------------------------------------------------------------- render

  private render(): void {
    this.box.textContent = '';
    this.box.appendChild(this.el('div', 'title', 'Schedule change'));
    if (this.loading) this.box.appendChild(this.el('div', 'muted', 'Loading…'));
    if (this.problem) this.box.appendChild(this.el('div', 'err', this.problem));

    if (this.needsConnect) {
      this.box.appendChild(this.el('div', 'muted', 'Sign in once so the scheduler can make changes while this computer is off.'));
      this.box.appendChild(
        this.button('Sign in with Google', 'primary', () => {
          this.transport.connect().catch((error: unknown) => {
            this.problem = `Could not open the sign-in: ${messageOf(error)}`;
            this.render();
          });
        }),
      );
      return;
    }
    if (!this.jobs) return;

    const { pending, history } = splitJobs(this.jobs);
    const editing = new Set(this.lines.map((line) => line.job?.id));
    for (const job of pending) if (!editing.has(job.id)) this.box.appendChild(this.savedLine(job));
    for (const job of history.filter((j) => j.state === 'failed').slice(0, FAILED_SHOWN)) {
      this.box.appendChild(this.savedLine(job));
    }

    for (const w of this.warnings) this.box.appendChild(this.el('div', 'warn', w));
    this.lines.forEach((line, i) => this.draftLine(line, i));

    const foot = this.el('div', 'foot');
    foot.append(
      this.el('div', 'hint', `Your time zone (${Intl.DateTimeFormat().resolvedOptions().timeZone}). Saved when you press Schedule; Studio's buttons do not affect it.`),
      this.button(this.busy ? 'Scheduling…' : 'Schedule', 'primary', () => void this.save()),
    );
    this.box.appendChild(foot);
  }

  private savedLine(job: SchedulerJob): HTMLElement {
    const d = describeJob(job, (iso) => formatLocal(iso));
    const failed = job.state === 'failed';
    const line = this.el('div', `line saved${failed ? ' failed' : ''}`);
    line.appendChild(this.el('span', 'what', `${failed ? 'Failed: ' : ''}${visibilityLabel(job.target)} · ${formatLocal(job.runAt)}`));
    if (!failed) {
      line.append(
        this.button('Edit', '', () => this.editJob(job)),
        this.button('Cancel', '', () => void this.cancel(job)),
      );
    }
    for (const detail of d.details) line.appendChild(this.el('div', 'detail', detail));
    return line;
  }

  private draftLine(line: DraftLine, index: number): void {
    const row = this.el('div', 'line');
    row.appendChild(this.el('span', 'lead', 'Change to'));

    const select = document.createElement('select');
    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'Choose…';
    none.disabled = true;
    select.appendChild(none);
    for (const v of VISIBILITIES) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = visibilityLabel(v);
      select.appendChild(opt);
    }
    select.value = line.target;
    select.addEventListener('change', () => (line.target = select.value as Visibility));

    const date = this.input('date', line.date, (v) => (line.date = v));
    const time = this.input('time', line.time, (v) => (line.time = v));
    row.append(select, date, time);

    if (index === this.lines.length - 1) {
      const add = this.button('+', 'round', () => {
        this.lines.push(blankLine(line.date));
        this.render();
      });
      add.title = 'Add another scheduled change';
      row.appendChild(add);
    }
    if (this.lines.length > 1 || line.job) {
      const remove = this.button('×', 'round', () => {
        this.lines.splice(this.lines.indexOf(line), 1);
        if (!this.lines.length) this.lines.push(blankLine());
        this.render();
      });
      remove.title = line.job ? 'Stop editing; the change stays as it was' : 'Remove this line';
      row.appendChild(remove);
    }
    this.box.appendChild(row);
    if (line.error) this.box.appendChild(this.el('div', 'err', line.error));
  }

  private editJob(job: SchedulerJob): void {
    const at = localInputsOf(job.runAt);
    const line: DraftLine = { job, target: job.target, date: at.date, time: at.time, error: null };
    this.lines = [line, ...this.lines.filter((l) => !untouched(l))];
    this.render();
  }

  // -------------------------------------------------------------------- actions

  /**
   * Saves each line in turn. A line the server refuses stays on screen with its reason, and the
   * others still go: each is its own change, and none depends on another having been saved.
   */
  private async save(): Promise<void> {
    const videoId = this.videoId;
    if (this.busy || !videoId) return;
    const toSave = this.lines.filter((line) => !untouched(line));
    if (!toSave.length) {
      this.lines[0]!.error = 'Choose what to change it to, and when.';
      return this.render();
    }

    const seq = this.seq;
    this.busy = true;
    this.warnings = [];
    this.render();
    const kept: DraftLine[] = [];
    for (const line of toSave) {
      line.error = null;
      if (!line.target) {
        line.error = 'Choose what to change it to.';
        kept.push(line);
        continue;
      }
      const runAt = runAtFromLocal(line.date, line.time);
      if (!runAt.ok) {
        line.error = runAt.error;
        kept.push(line);
        continue;
      }
      try {
        const out = line.job
          ? await this.transport.edit(line.job.id, {
              // Only what changed: an unchanged runAt would be re-checked as "a minute ahead".
              ...(line.target !== line.job.target ? { target: line.target } : {}),
              ...(Date.parse(runAt.iso) !== Date.parse(line.job.runAt) ? { runAt: runAt.iso } : {}),
            })
          : await this.transport.create({ videoId, target: line.target, runAt: runAt.iso, note: '' });
        this.warnings.push(...out.warnings);
      } catch (error) {
        line.error = messageOf(error);
        kept.push(line);
      }
    }
    this.busy = false;
    if (seq !== this.seq) return;
    this.lines = kept.length ? kept : [blankLine()];
    await this.reloadJobs(seq);
  }

  private async cancel(job: SchedulerJob): Promise<void> {
    if (this.busy) return;
    const seq = this.seq;
    this.busy = true;
    this.problem = null;
    this.render();
    try {
      await this.transport.cancel(job.id);
    } catch (error) {
      this.problem = `Could not cancel the change to ${visibilityLabel(job.target)}: ${messageOf(error)}`;
    }
    this.busy = false;
    if (seq === this.seq) await this.reloadJobs(seq);
  }

  private async reloadJobs(seq: number): Promise<void> {
    try {
      const jobs = await this.transport.jobs(this.videoId!);
      if (seq !== this.seq) return;
      this.jobs = jobs;
    } catch (error) {
      if (seq !== this.seq) return;
      this.problem = `That was saved, but the list could not be read again: ${messageOf(error)}`;
    }
    this.render();
  }

  // ------------------------------------------------------------------- bits

  private el(tag: string, className: string, text = ''): HTMLElement {
    const e = document.createElement(tag);
    e.className = className;
    if (text) e.textContent = text;
    return e;
  }

  private button(text: string, className: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.textContent = text;
    b.disabled = this.busy;
    b.addEventListener('click', onClick);
    return b;
  }

  private input(type: string, value: string, onInput: (v: string) => void): HTMLInputElement {
    const i = document.createElement('input');
    i.type = type;
    i.value = value;
    i.disabled = this.busy;
    i.addEventListener('input', () => onInput(i.value));
    return i;
  }
}

function videoIdOfRow(cell: Element): string | null {
  const link = cell.closest('ytcp-video-row')?.querySelector('a[href*="/video/"]');
  return /\/video\/([^/?#]+)/.exec(link?.getAttribute('href') ?? '')?.[1] ?? null;
}
