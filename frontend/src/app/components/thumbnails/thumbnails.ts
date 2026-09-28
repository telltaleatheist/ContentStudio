import { Component, OnDestroy, OnInit, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';

import { ElectronService } from '../../services/electron';
import type {
  ThumbsFrame,
  ThumbsItem,
  ThumbsPhotos,
  ThumbsRenderResult,
  ThumbsRun,
  ThumbsStyle,
  ThumbsWordKind,
  ThumbsWords,
} from './thumbnails.types';

/** The three A/B variants, in the order frames are marked. */
const LETTERS = ['A', 'B', 'C'] as const;
/** The kind each variant starts on once words arrive: one idea per variant, so the test compares ideas. */
const DEFAULT_KIND: Record<string, ThumbsWordKind> = { A: 'claim', B: 'stakes', C: 'reaction' };
const KIND_LABEL: Record<ThumbsWordKind, string> = { claim: 'Claim', stakes: 'Stakes', reaction: 'Reaction' };
/** The "glance test": the widths a thumbnail is seen at on a phone. */
const PHONE_WIDTHS = [360, 246, 168];

/** One variant's words: a phrase with its kind, or no text (an image-only A/B arm). */
interface WordChoice {
  phrase: string | null;
  kind: ThumbsWordKind | null;
}

/**
 * THE THUMBNAILS TAB (testing, 2026-09-28). One page, top to bottom: pick a video, find frames,
 * mark three, write words paired with a title, make the three thumbnails. Every model call and
 * every file is the main process's (lab-service.ts); this page only shows and asks.
 */
@Component({
  selector: 'app-thumbnails',
  standalone: true,
  imports: [CommonModule, FormsModule, MatIconModule, MatButtonModule, MatTooltipModule],
  templateUrl: './thumbnails.html',
  styleUrls: ['./thumbnails.scss'],
})
export class Thumbnails implements OnInit, OnDestroy {
  readonly letters = LETTERS;
  readonly phoneWidths = PHONE_WIDTHS;
  readonly kinds: ThumbsWordKind[] = ['claim', 'stakes', 'reaction'];
  readonly kindLabel = KIND_LABEL;

  readonly items = signal<ThumbsItem[]>([]);
  readonly itemKey = signal<string>('');
  readonly useOtherVideo = signal(false);
  readonly otherVideo = signal<string | null>(null);
  start = '';
  end = '';

  readonly run = signal<ThumbsRun | null>(null);
  readonly busy = signal<null | 'finding' | 'scoring' | 'words' | 'rendering'>(null);
  readonly progress = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  readonly view = signal<'best' | 'all'>('all');
  /** Frame ids marked, in order: index 0 is A. */
  readonly marked = signal<string[]>([]);
  readonly preview = signal<{ id: string; clock: string; picture: string } | null>(null);

  readonly title = signal<string>('');
  readonly words = signal<ThumbsWords | null>(null);
  readonly choices = signal<Record<string, WordChoice>>({});

  readonly style = signal<ThumbsStyle | null>(null);
  readonly styleStored = signal(false);
  readonly styleOpen = signal(false);
  readonly styleNote = signal<string | null>(null);

  readonly photos = signal<ThumbsPhotos>({ folder: null, photos: [] });
  /** Each variant's reaction photo by name, or absent for none. */
  readonly photoChoice = signal<Record<string, string | null>>({});

  readonly results = signal<ThumbsRenderResult[] | null>(null);
  readonly folder = signal<string | null>(null);
  readonly showSlots = signal(true);

  private unsubscribe: (() => void) | null = null;

  readonly item = computed(() => this.items().find((i) => `${i.jobId}/${i.itemId}` === this.itemKey()) ?? null);
  readonly framesById = computed(() => new Map((this.run()?.frames ?? []).map((f) => [f.id, f])));
  readonly shownFrames = computed<ThumbsFrame[]>(() => {
    const run = this.run();
    if (run === null) return [];
    if (this.view() === 'best' && run.best !== null) {
      const byId = this.framesById();
      return run.best.map((id) => byId.get(id)).filter((f): f is ThumbsFrame => f !== undefined);
    }
    return run.frames;
  });
  readonly markedFrames = computed(() => {
    const byId = this.framesById();
    return this.marked().map((id, i) => ({ letter: LETTERS[i], frame: byId.get(id)! })).filter((m) => m.frame !== undefined);
  });

  constructor(private readonly electron: ElectronService) {}

  async ngOnInit(): Promise<void> {
    this.unsubscribe = this.electron.onThumbsProgress((event) => {
      const run = this.run();
      if (event.stage === 'sampling') this.progress.set(`Sampling frame ${event.done.toLocaleString()} of about ${event.total.toLocaleString()}`);
      else if (run === null || run.runId === event.runId) this.progress.set(`Scoring frame ${Math.min(event.done + 1, event.total)} of ${event.total}`);
    });
    await this.attempt(async () => {
      this.items.set(await this.electron.thumbsListItems());
      const first = this.items().find((i) => i.problem === null);
      if (first) this.itemKey.set(`${first.jobId}/${first.itemId}`);
      this.photos.set(await this.electron.thumbsPhotos());
      const { style, stored } = await this.electron.thumbsGetStyle();
      this.style.set(style);
      this.styleStored.set(stored);
    });
  }

  ngOnDestroy(): void {
    this.unsubscribe?.();
  }

  private async attempt(fn: () => Promise<void>): Promise<void> {
    this.error.set(null);
    try {
      await fn();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    }
  }

  pickItem(key: string): void {
    this.itemKey.set(key);
    this.resetRun();
    const item = this.item();
    this.title.set(item?.titles[0] ?? '');
  }

  private resetRun(): void {
    this.run.set(null);
    this.marked.set([]);
    this.words.set(null);
    this.choices.set({});
    this.results.set(null);
    this.preview.set(null);
  }

  async chooseVideo(): Promise<void> {
    await this.attempt(async () => {
      const picked = await this.electron.thumbsChooseVideo();
      if (picked !== null) {
        this.otherVideo.set(picked);
        this.useOtherVideo.set(true);
      }
    });
  }

  fileName(p: string | null): string {
    return p === null ? '' : p.split('/').pop() ?? p;
  }

  async findFrames(): Promise<void> {
    const item = this.item();
    if (item === null) return;
    if (this.useOtherVideo() && this.otherVideo() === null) {
      this.error.set('Choose the other video file first.');
      return;
    }
    this.busy.set('finding');
    this.progress.set('Starting ffmpeg');
    this.resetRun();
    if (!this.title()) this.title.set(item.titles[0] ?? '');
    await this.attempt(async () => {
      const run = await this.electron.thumbsFindFrames({
        jobId: item.jobId,
        itemId: item.itemId,
        video: this.useOtherVideo() ? this.otherVideo() : null,
        start: this.start.trim() || null,
        end: this.end.trim() || null,
      });
      this.run.set(run);
      this.view.set('all');
    });
    this.busy.set(null);
    this.progress.set(null);
  }

  async score(): Promise<void> {
    const run = this.run();
    if (run === null) return;
    this.busy.set('scoring');
    this.progress.set(`Loading the model, then scoring frame 1 of ${run.toScore.length}`);
    await this.attempt(async () => {
      const scored = await this.electron.thumbsScore(run.runId);
      this.run.set(scored);
      this.view.set('best');
    });
    this.busy.set(null);
    this.progress.set(null);
  }

  async stop(): Promise<void> {
    const run = this.run();
    if (run !== null) await this.attempt(() => this.electron.thumbsStop(run.runId));
  }

  toggleMark(frame: ThumbsFrame): void {
    const marked = this.marked();
    if (marked.includes(frame.id)) {
      this.marked.set(marked.filter((id) => id !== frame.id));
    } else if (marked.length < LETTERS.length) {
      this.marked.set([...marked, frame.id]);
    } else {
      this.error.set('Three frames are marked already. Click one of them to unmark it first.');
      return;
    }
    this.error.set(null);
    this.results.set(null);
    this.applyDefaultWords();
  }

  letterOf(id: string): string | null {
    const i = this.marked().indexOf(id);
    return i < 0 ? null : LETTERS[i];
  }

  async look(frame: ThumbsFrame, event: Event): Promise<void> {
    event.stopPropagation();
    const run = this.run();
    if (run === null) return;
    await this.attempt(async () => {
      this.preview.set({ id: frame.id, clock: frame.clock, picture: await this.electron.thumbsFramePicture(run.runId, frame.id) });
    });
  }

  percent(value: number | null): string {
    return value === null ? '' : `${Math.round(value * 100)}`;
  }

  frameTip(frame: ThumbsFrame): string {
    const r = frame.reading;
    if (r === null) return `${frame.clock}: not scored`;
    return `${frame.clock}: face ${this.percent(r.pFace)}%, expression ${r.expression.toFixed(1)} of 5, eyes open ${this.percent(r.pEyesOpen)}%, ` +
      `strong thumbnail ${this.percent(r.pStrong)}%, computer screen ${this.percent(r.pScreen)}%`;
  }

  async writeWords(): Promise<void> {
    const run = this.run();
    if (run === null || !this.title()) return;
    this.busy.set('words');
    await this.attempt(async () => {
      this.words.set(await this.electron.thumbsWords(run.runId, this.title()));
      this.choices.set({});
      this.applyDefaultWords();
    });
    this.busy.set(null);
  }

  /** Each marked variant without a choice gets its own kind's first option. */
  private applyDefaultWords(): void {
    const words = this.words();
    if (words === null) return;
    const next = { ...this.choices() };
    this.marked().forEach((_, i) => {
      const letter = LETTERS[i];
      if (next[letter] !== undefined) return;
      const kind = DEFAULT_KIND[letter];
      const first = words[kind][0];
      next[letter] = first === undefined ? { phrase: null, kind: null } : { phrase: first, kind };
    });
    this.choices.set(next);
  }

  choiceKey(letter: string): string {
    const c = this.choices()[letter];
    return c === undefined || c.phrase === null ? 'none' : `${c.kind}|${c.phrase}`;
  }

  setChoice(letter: string, key: string): void {
    const [kind, ...rest] = key.split('|');
    this.choices.set({ ...this.choices(), [letter]: key === 'none' ? { phrase: null, kind: null } : { phrase: rest.join('|'), kind: kind as ThumbsWordKind } });
    this.results.set(null);
  }

  async render(): Promise<void> {
    const run = this.run();
    if (run === null || this.marked().length === 0) return;
    this.busy.set('rendering');
    await this.attempt(async () => {
      const variants = this.marked().map((frameId, i) => {
        const letter = LETTERS[i];
        const c = this.choices()[letter] ?? { phrase: null, kind: null };
        return { letter, frameId, phrase: c.phrase, kind: c.kind, photo: this.photoChoice()[letter] ?? null };
      });
      const out = await this.electron.thumbsRender(run.runId, variants);
      this.results.set(out.results);
      this.folder.set(out.folder);
    });
    this.busy.set(null);
  }

  async choosePhotoFolder(): Promise<void> {
    await this.attempt(async () => {
      const picked = await this.electron.thumbsChoosePhotoFolder();
      if (picked !== null) {
        this.photoChoice.set({});
        this.photos.set(await this.electron.thumbsPhotos());
      }
    });
  }

  setPhoto(letter: string, name: string | null): void {
    this.photoChoice.set({ ...this.photoChoice(), [letter]: name });
    this.results.set(null);
  }

  async showFolder(): Promise<void> {
    const folder = this.folder();
    if (folder !== null) await this.attempt(() => this.electron.thumbsShowFolder(folder));
  }

  kb(bytes: number): string {
    return `${Math.round(bytes / 1024).toLocaleString()} KB`;
  }

  // ── the look ──────────────────────────────────────────────────────────────

  setStyle<K extends keyof ThumbsStyle>(key: K, value: ThumbsStyle[K]): void {
    const style = this.style();
    if (style !== null) this.style.set({ ...style, [key]: value });
  }

  setSlot(slot: 'reactionSlot' | 'logoSlot', key: 'x' | 'y' | 'w' | 'h', percent: number): void {
    const style = this.style();
    if (style !== null) this.style.set({ ...style, [slot]: { ...style[slot], [key]: percent / 100 } });
  }

  pct(value: number): number {
    return Math.round(value * 1000) / 10;
  }

  async saveStyle(): Promise<void> {
    const style = this.style();
    if (style === null) return;
    this.styleNote.set(null);
    await this.attempt(async () => {
      this.style.set(await this.electron.thumbsSetStyle(style));
      this.styleStored.set(true);
      this.styleNote.set('Saved. The next thumbnails use this look.');
    });
  }

  async resetStyle(): Promise<void> {
    await this.attempt(async () => {
      const { style } = await this.electron.thumbsGetStyle();
      this.style.set(style);
      this.styleNote.set('Put back to the saved look.');
    });
  }

  slotBox(slot: 'reactionSlot' | 'logoSlot'): Record<string, string> {
    const s = this.style()?.[slot];
    if (!s) return {};
    return { left: `${s.x * 100}%`, top: `${s.y * 100}%`, width: `${s.w * 100}%`, height: `${s.h * 100}%` };
  }
}
