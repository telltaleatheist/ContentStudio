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
  ThumbsPiece,
  ThumbsRanked,
  ThumbsRenderResult,
  ThumbsRun,
  ThumbsStyle,
  ThumbsSuggestion,
  ThumbsVariant,
  ThumbsWordKind,
  ThumbsWordPick,
  ThumbsWords,
} from './thumbnails.types';

const KIND_LABEL: Record<ThumbsWordKind, string> = { claim: 'Claim', stakes: 'Stakes', reaction: 'Reaction' };
/** The "glance test": the widths a thumbnail is seen at on a phone. */
const PHONE_WIDTHS = [360, 246, 168];
const NO_TEXT: ThumbsWordPick = { phrase: null, kind: null };

function pickKey(p: ThumbsWordPick): string {
  return p.phrase === null ? 'none' : `${p.kind}|${p.phrase}`;
}

/**
 * THE THUMBNAILS TAB (testing, 2026-09-28). One page, top to bottom: pick a video, find frames,
 * star favourite frames, words and photos, let the tab combine them into A, B and C (every piece
 * swappable), and make the thumbnails. Every model call and every file is the main process's
 * (lab-service.ts); this page only shows and asks.
 */
@Component({
  selector: 'app-thumbnails',
  standalone: true,
  imports: [CommonModule, FormsModule, MatIconModule, MatButtonModule, MatTooltipModule],
  templateUrl: './thumbnails.html',
  styleUrls: ['./thumbnails.scss'],
})
export class Thumbnails implements OnInit, OnDestroy {
  readonly phoneWidths = PHONE_WIDTHS;
  readonly kinds: ThumbsWordKind[] = ['claim', 'stakes', 'reaction'];
  readonly kindLabel = KIND_LABEL;
  readonly pieces: ThumbsPiece[] = ['frame', 'text', 'photo'];
  readonly pieceLabel: Record<ThumbsPiece, string> = { frame: 'the frame', text: 'the words', photo: 'the photo' };
  readonly pickKey = pickKey;

  readonly items = signal<ThumbsItem[]>([]);
  readonly itemKey = signal<string>('');
  readonly useOtherVideo = signal(false);
  readonly otherVideo = signal<string | null>(null);
  start = '';
  end = '';

  readonly run = signal<ThumbsRun | null>(null);
  readonly busy = signal<null | 'finding' | 'scoring' | 'words' | 'suggesting' | 'rendering'>(null);
  readonly progress = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  readonly view = signal<'best' | 'all'>('all');
  readonly preview = signal<{ id: string; clock: string; picture: string } | null>(null);

  readonly title = signal<string>('');
  readonly words = signal<ThumbsWords | null>(null);

  // Favourites, in the order starred.
  readonly favFrames = signal<string[]>([]);
  readonly favTexts = signal<ThumbsWordPick[]>([]);
  readonly favPhotos = signal<string[]>([]);

  readonly photos = signal<ThumbsPhotos>({ folder: null, photos: [] });
  readonly notesOpen = signal(false);
  readonly suggestion = signal<ThumbsSuggestion | null>(null);

  readonly mode = signal<'best' | 'test'>('best');
  readonly vary = signal<ThumbsPiece>('text');
  readonly variants = signal<ThumbsVariant[]>([]);
  readonly combineReason = signal<string | null>(null);

  readonly style = signal<ThumbsStyle | null>(null);
  readonly styleStored = signal(false);
  readonly styleOpen = signal(false);
  readonly styleNote = signal<string | null>(null);

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
  /** Every word line the model wrote, plus "no text", for a variant's text menu. */
  readonly allTexts = computed<ThumbsWordPick[]>(() => {
    const w = this.words();
    const out: ThumbsWordPick[] = [NO_TEXT];
    if (w) for (const k of this.kinds) for (const phrase of w[k]) out.push({ phrase, kind: k });
    for (const f of this.favTexts()) if (!out.some((o) => pickKey(o) === pickKey(f))) out.push(f);
    return out;
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
      if (first) this.pickItem(`${first.jobId}/${first.itemId}`);
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
    this.title.set(this.item()?.titles[0] ?? '');
  }

  private resetRun(): void {
    this.run.set(null);
    this.favFrames.set([]);
    this.favTexts.set([]);
    this.words.set(null);
    this.suggestion.set(null);
    this.variants.set([]);
    this.combineReason.set(null);
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
    await this.attempt(async () => {
      this.run.set(await this.electron.thumbsFindFrames({
        jobId: item.jobId,
        itemId: item.itemId,
        video: this.useOtherVideo() ? this.otherVideo() : null,
        start: this.start.trim() || null,
        end: this.end.trim() || null,
      }));
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
      this.run.set(await this.electron.thumbsScore(run.runId));
      this.view.set('best');
    });
    this.busy.set(null);
    this.progress.set(null);
  }

  async stop(): Promise<void> {
    const run = this.run();
    if (run !== null) await this.attempt(() => this.electron.thumbsStop(run.runId));
  }

  // ── favourites ────────────────────────────────────────────────────────────

  toggleFrame(frame: ThumbsFrame): void {
    const fav = this.favFrames();
    this.favFrames.set(fav.includes(frame.id) ? fav.filter((id) => id !== frame.id) : [...fav, frame.id]);
    void this.recombine();
  }

  frameStar(id: string): number | null {
    const i = this.favFrames().indexOf(id);
    return i < 0 ? null : i + 1;
  }

  isFavText(p: ThumbsWordPick): boolean {
    return this.favTexts().some((f) => pickKey(f) === pickKey(p));
  }

  toggleText(p: ThumbsWordPick): void {
    const fav = this.favTexts();
    this.favTexts.set(this.isFavText(p) ? fav.filter((f) => pickKey(f) !== pickKey(p)) : [...fav, p]);
    void this.recombine();
  }

  togglePhoto(name: string): void {
    const fav = this.favPhotos();
    this.favPhotos.set(fav.includes(name) ? fav.filter((n) => n !== name) : [...fav, name]);
    void this.recombine();
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

  // ── words ─────────────────────────────────────────────────────────────────

  async writeWords(): Promise<void> {
    const run = this.run();
    if (run === null || !this.title()) return;
    this.busy.set('words');
    await this.attempt(async () => {
      this.words.set(await this.electron.thumbsWords(run.runId, this.title()));
    });
    this.busy.set(null);
  }

  // ── photos ────────────────────────────────────────────────────────────────

  async choosePhotoFolder(): Promise<void> {
    await this.attempt(async () => {
      const picked = await this.electron.thumbsChoosePhotoFolder();
      if (picked !== null) {
        this.favPhotos.set([]);
        this.suggestion.set(null);
        this.photos.set(await this.electron.thumbsPhotos());
        await this.recombine();
      }
    });
  }

  async saveNote(name: string, note: string): Promise<void> {
    await this.attempt(async () => {
      await this.electron.thumbsSetPhotoNote(name, note);
      this.photos.set(await this.electron.thumbsPhotos());
    });
  }

  /** The tone, and each variant's photos ranked from its words; the top favourite (or top) is pre-selected. */
  async suggest(): Promise<void> {
    const run = this.run();
    if (run === null || this.variants().length === 0) return;
    this.busy.set('suggesting');
    await this.attempt(async () => {
      this.suggestion.set(await this.electron.thumbsSuggest(run.runId, this.variants().map((v) => ({ letter: v.letter, text: v.text.phrase }))));
      await this.recombine();
    });
    this.busy.set(null);
  }

  /** A variant's photo menu: ranked by its suggestion when there is one, else the folder's order. */
  photoMenu(letter: string): Array<{ name: string; p: number | null }> {
    const ranked: ThumbsRanked[] | undefined = this.suggestion()?.photos[letter];
    if (ranked) return ranked;
    return this.photos().photos.map((p) => ({ name: p.name, p: null }));
  }

  photoPreview(name: string | null): string | null {
    return name === null ? null : this.photos().photos.find((p) => p.name === name)?.preview ?? null;
  }

  // ── combine ───────────────────────────────────────────────────────────────

  setMode(mode: 'best' | 'test'): void {
    this.mode.set(mode);
    void this.recombine();
  }

  setVary(piece: ThumbsPiece): void {
    this.vary.set(piece);
    void this.recombine();
  }

  /** Lay the favourites out as A/B/C again (the main process's combine.ts), dropping hand swaps. */
  async recombine(): Promise<void> {
    this.results.set(null);
    if (this.favFrames().length === 0) {
      this.variants.set([]);
      this.combineReason.set(null);
      return;
    }
    const s = this.suggestion();
    const rank = s ? Object.fromEntries(Object.entries(s.photos).map(([l, r]) => [l, r.map((x) => x.name)])) : null;
    await this.attempt(async () => {
      const out = await this.electron.thumbsCombine(
        { frames: this.favFrames(), texts: this.favTexts(), photos: this.favPhotos() },
        this.mode() === 'best' ? { mode: 'best' } : { mode: 'test', vary: this.vary() },
        rank,
      );
      if (out.ok === true) {
        this.variants.set(out.variants);
        this.combineReason.set(null);
      } else {
        this.variants.set([]);
        this.combineReason.set((out as { reason: string }).reason);
      }
    });
  }

  swap(letter: string, change: Partial<ThumbsVariant>): void {
    this.variants.set(this.variants().map((v) => (v.letter === letter ? { ...v, ...change } : v)));
    this.results.set(null);
  }

  swapText(letter: string, key: string): void {
    const pick = this.allTexts().find((p) => pickKey(p) === key) ?? NO_TEXT;
    this.swap(letter, { text: pick });
  }

  async render(): Promise<void> {
    const run = this.run();
    if (run === null || this.variants().length === 0) return;
    this.busy.set('rendering');
    await this.attempt(async () => {
      const out = await this.electron.thumbsRender(run.runId, this.variants().map((v) => ({
        letter: v.letter, frameId: v.frameId, phrase: v.text.phrase, kind: v.text.kind, photo: v.photo,
      })));
      this.results.set(out.results);
      this.folder.set(out.folder);
    });
    this.busy.set(null);
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
