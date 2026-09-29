import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { ElectronService } from '../../services/electron';
import { PublishState } from '../../features/publish/publish-state';
import { ThumbnailLookDialog } from './thumbnail-look-dialog';
import {
  WORD_KINDS,
  type PairChange,
  type PickRequest,
  type PickView,
  type StoredPair,
  type ThumbnailsView,
  type WordKind,
} from './thumbnails.types';

export interface ThumbnailsWindowData {
  jobId: string;
  itemId: string;
}

/** One saved pick as the strip shows it: the pick, the title it goes with, and whether its words were written for that title. */
interface PickSlot {
  n: number;
  view: PickView | null;
  /** Chosen title n (the A/B pairing), or null when title n is not picked yet. */
  title: string | null;
  /** For a pair's pick whose words were written for another title: that title. */
  wordsFor: string | null;
  mismatch: boolean;
}

/**
 * THE THUMBNAILS WINDOW (phase 2, Owen 2026-09-28), opened from the reports page's Thumbnails
 * block. The metadata run already made the pairs; here Owen:
 *
 *   - PICKS IN ORDER, as he picks titles: the first thumbnail clicked is pick 1, then 2, then 3;
 *     clicking a picked one removes it and the rest close the gap (publish-state.ts toggleTitle's
 *     rule). Pick n goes with chosen title n in Test & Compare's "title and thumbnail" mode; with no
 *     A/B test pick 1 is the video's thumbnail. Every change is saved at once (the record's
 *     `picks`), and pick 1 is set as the video's thumbnail through the publish record's one
 *     thumbnail door (PublishState.setThumbnail), exactly like a file chosen on the Thumbnail row.
 *   - swaps any piece of one pair (the frame from the scene strip, the words, the photo, the logo),
 *     drawn again at once on the CPU;
 *   - "Rewrite words for this title" when his title order means pick n's words were written for a
 *     different title (the 27B, on demand);
 *   - uses his own image file as a pick (or the only one);
 *   - with no story, gives 1 to 3 screenshots, and that many thumbnails are made.
 *
 * Closing the window gives back the text model it kept loaded between the words and the photos.
 */
@Component({
  selector: 'app-thumbnails-window',
  standalone: true,
  imports: [MatDialogModule, MatButtonModule, MatProgressSpinnerModule],
  templateUrl: './thumbnails-window.html',
  styleUrl: './thumbnails-window.scss',
})
export class ThumbnailsWindow implements OnInit, OnDestroy {
  private readonly electron = inject(ElectronService);
  private readonly dialog = inject(MatDialog);
  readonly publish = inject(PublishState);
  readonly data = inject<ThumbnailsWindowData>(MAT_DIALOG_DATA);

  readonly WORD_KINDS = WORD_KINDS;
  readonly view = signal<ThumbnailsView | null>(null);
  readonly busy = signal<string | null>(null);
  readonly progress = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  /** The pair the editor below is changing. */
  readonly editing = signal(1);
  /** Pictures of the frames behind "More" (by id), loaded on demand. */
  readonly more = signal<Record<string, string>>({});
  readonly moreOpen = signal<ReadonlySet<number>>(new Set());
  /** The screenshots chosen for a report with no story, before they are made into thumbnails. */
  readonly shots = signal<string[]>([]);
  /** The words Owen typed for the pair being edited. */
  readonly ownWords = signal('');
  /** The title picked in "Write the words for another title". */
  readonly otherTitle = signal('');
  private unsubscribe: (() => void) | null = null;

  readonly record = computed(() => this.view()?.record ?? null);
  readonly pairs = computed(() => this.record()?.pairs ?? []);
  readonly pair = computed<StoredPair | null>(() => this.pairs().find((p) => p.pair === this.editing()) ?? null);

  /** The three pick slots, paired with the chosen titles by position. */
  readonly slots = computed<PickSlot[]>(() => {
    const picks = this.view()?.picks ?? [];
    const titles = this.publish.chosenTitles();
    return [1, 2, 3].map((n) => {
      const view = picks[n - 1] ?? null;
      const title = titles[n - 1] ?? null;
      const wordsFor = view !== null && view.pick.kind === 'made' ? view.pick.wordsFor : null;
      return { n, view, title, wordsFor, mismatch: wordsFor !== null && title !== null && wordsFor !== title };
    });
  });

  /** Every title the words can be written for: the chosen ones first, then the generated ones. */
  readonly titleChoices = computed(() => [...new Set([...this.publish.chosenTitles(), ...(this.view()?.titles ?? [])])]);

  /** The screenshots' titles, one each, in that order. */
  readonly shotTitles = computed(() => this.titleChoices().slice(0, this.shots().length));

  /** The report has no pairs, and screenshots can make them (no story, or its stages failed). */
  readonly canScreenshots = computed(() => {
    const r = this.record();
    return r !== null && (r.state === 'no-story' || r.state === 'failed' || (r.state === 'made' && r.source?.video === null));
  });

  async ngOnInit(): Promise<void> {
    this.unsubscribe = this.electron.onThumbnailsProgress((event) => {
      if (event.jobId === this.data.jobId && event.itemId === this.data.itemId) this.progress.set(event.line);
    });
    await this.run('Reading the thumbnails', async () => this.electron.thumbnailsItem(this.data.jobId, this.data.itemId), false);
    const first = this.pairs()[0];
    if (first !== undefined) this.editing.set(first.pair);
  }

  ngOnDestroy(): void {
    this.unsubscribe?.();
    // The main process never refuses a release (it is housekeeping); a missing bridge is said in the console.
    void this.electron.thumbnailsReleaseModel().catch((err: Error) => console.error('[Thumbnails] giving back the text model:', err.message));
  }

  /**
   * One action: the busy line, the new view, and the video's thumbnail kept on pick 1. A refusal is
   * shown as the main process wrote it. `sync` is off for a plain read.
   */
  private async run(what: string, fn: () => Promise<ThumbnailsView>, sync = true): Promise<void> {
    if (this.busy() !== null) return;
    this.busy.set(what);
    this.progress.set(null);
    this.error.set(null);
    try {
      const view = await fn();
      this.view.set(view);
      if (sync) await this.syncPublish(view);
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.busy.set(null);
      this.progress.set(null);
    }
  }

  /**
   * Pick 1's copy is the video's thumbnail, through the publish record's one door (the same one a
   * file chosen on the Thumbnail row goes through). Set again after every change, so a redrawn pick
   * 1 is re-read. With no picks, a thumbnail that was pick 1's copy is cleared; one Owen chose on the
   * Thumbnail row himself is left alone.
   */
  private async syncPublish(view: ThumbnailsView): Promise<void> {
    if (this.publish.itemId() !== this.data.itemId) return;
    if (view.publishFile !== null) {
      await this.publish.setThumbnail(view.publishFile);
      return;
    }
    const current = this.publish.thumbnailPath();
    if (current !== null && view.picksFolder !== null && current.startsWith(view.picksFolder)) await this.publish.clearThumbnail();
  }

  // ── picks ─────────────────────────────────────────────────────────────────

  private requests(): PickRequest[] {
    return (this.view()?.picks ?? []).map((p) => (p.pick.kind === 'made' ? { kind: 'made' as const, pair: p.pick.pair } : { kind: 'own' as const, file: p.pick.file }));
  }

  /** The pick number of a pair, or null when it is not picked. */
  pickNumber(pair: number): number | null {
    const i = (this.view()?.picks ?? []).findIndex((p) => p.pick.kind === 'made' && p.pick.pair === pair);
    return i === -1 ? null : i + 1;
  }

  /** True when picking this pair would be a fourth pick. */
  pickBlocked(pair: number): boolean {
    return this.pickNumber(pair) === null && (this.view()?.picks.length ?? 0) >= 3;
  }

  /** Click order is pick order; clicking a picked one removes it and the rest close the gap. */
  async togglePick(pair: StoredPair): Promise<void> {
    const notDrawn = this.notDrawn(pair);
    if (notDrawn !== null) {
      this.error.set(`Thumbnail ${pair.pair} was not drawn (${notDrawn}); change a piece to draw it.`);
      return;
    }
    const current = this.requests();
    const at = current.findIndex((r) => r.kind === 'made' && r.pair === pair.pair);
    if (at === -1 && current.length >= 3) {
      this.error.set('You can pick at most 3 thumbnails. Remove one first.');
      return;
    }
    const next = at === -1 ? [...current, { kind: 'made' as const, pair: pair.pair }] : current.filter((_, i) => i !== at);
    await this.run('Saving the picks', () => this.electron.thumbnailsSavePicks(this.data.jobId, this.data.itemId, next));
  }

  async removePick(n: number): Promise<void> {
    const next = this.requests().filter((_, i) => i !== n - 1);
    await this.run('Saving the picks', () => this.electron.thumbnailsSavePicks(this.data.jobId, this.data.itemId, next));
  }

  async clearPicks(): Promise<void> {
    await this.run('Saving the picks', () => this.electron.thumbnailsSavePicks(this.data.jobId, this.data.itemId, []));
  }

  /** Owen's own image file as the next pick (or the only one). It is checked against YouTube's thumbnail rules. */
  async addOwn(): Promise<void> {
    if ((this.view()?.picks.length ?? 0) >= 3) {
      this.error.set('You can pick at most 3 thumbnails. Remove one first.');
      return;
    }
    let file: string | null;
    try {
      file = await this.electron.thumbnailsChooseOwn();
    } catch (err) {
      this.error.set((err as Error).message);
      return;
    }
    if (file === null) return;
    const next = [...this.requests(), { kind: 'own' as const, file }];
    await this.run('Saving the picks', () => this.electron.thumbnailsSavePicks(this.data.jobId, this.data.itemId, next));
  }

  /** "Rewrite words for this title": pick n's pair gets words written for chosen title n. */
  async rewriteForSlot(slot: PickSlot): Promise<void> {
    if (slot.view === null || slot.view.pick.kind !== 'made' || slot.title === null) return;
    const pair = slot.view.pick.pair;
    const title = slot.title;
    await this.run(`Writing the words for “${title}”`, () => this.electron.thumbnailsPairTitle(this.data.jobId, this.data.itemId, pair, title));
  }

  // ── changing one pair ─────────────────────────────────────────────────────

  edit(pair: StoredPair): void {
    this.editing.set(pair.pair);
    this.ownWords.set('');
    this.otherTitle.set('');
  }

  private async change(change: Omit<PairChange, 'pair'>): Promise<void> {
    const pair = this.editing();
    await this.run(`Drawing thumbnail ${pair}`, () => this.electron.thumbnailsRenderPair(this.data.jobId, this.data.itemId, { pair, ...change }));
  }

  useFrame(id: string): Promise<void> {
    return this.change({ frameId: id });
  }

  useWords(phrase: string, kind: WordKind): Promise<void> {
    return this.change({ phrase, kind });
  }

  useOwnWords(): Promise<void> {
    const phrase = this.ownWords().trim();
    if (phrase === '') {
      this.error.set('Type the words first.');
      return Promise.resolve();
    }
    return this.change({ phrase, kind: null });
  }

  noWords(): Promise<void> {
    return this.change({ phrase: null });
  }

  usePhoto(name: string | null): Promise<void> {
    return this.change({ photo: name });
  }

  drawPhoto(): Promise<void> {
    return this.change({ photo: 'draw' });
  }

  setLogo(on: boolean): Promise<void> {
    return this.change({ logo: on });
  }

  async rewriteFor(title: string): Promise<void> {
    if (title === '') return;
    const pair = this.editing();
    await this.run(`Writing the words for “${title}”`, () => this.electron.thumbnailsPairTitle(this.data.jobId, this.data.itemId, pair, title));
  }

  // ── pictures ──────────────────────────────────────────────────────────────

  /** Why a pair has no picture (a record from before phase 2 refused its words), or null when it was drawn. */
  notDrawn(pair: StoredPair): string | null {
    const r = pair.default.render;
    return r.ok === false ? (r as { reason: string }).reason : null;
  }

  renderNotes(pair: StoredPair): string[] {
    const r = pair.default.render;
    return r.ok === true ? (r as { notes: string[] }).notes : [];
  }

  renderPicture(pair: StoredPair): string | null {
    const r = pair.default.render;
    return r.ok === true ? (this.view()?.renders[(r as { file: string }).file] ?? null) : null;
  }

  framePicture(id: string): string | null {
    return this.view()?.frames[id] ?? this.more()[id] ?? null;
  }

  photoPreview(name: string): string | null {
    return this.view()?.photos.find((p) => p.name === name)?.preview ?? null;
  }

  sceneLabel(scene: number): string {
    return this.record()?.scenes.find((s) => s.number === scene)?.label ?? `Scene ${scene}`;
  }

  async toggleMore(scene: number, ids: string[]): Promise<void> {
    const open = new Set(this.moreOpen());
    if (open.delete(scene)) {
      this.moreOpen.set(open);
      return;
    }
    const missing = ids.filter((id) => this.framePicture(id) === null);
    if (missing.length > 0) {
      try {
        const got = await this.electron.thumbnailsFrames(this.data.jobId, this.data.itemId, missing);
        this.more.set({ ...this.more(), ...got });
      } catch (err) {
        this.error.set((err as Error).message);
        return;
      }
    }
    open.add(scene);
    this.moreOpen.set(open);
  }

  percent(p: number | null): string {
    return p === null ? 'not rated' : `${Math.round(p * 100)}%`;
  }

  fileName(file: string): string {
    return file.split('/').pop() ?? file;
  }

  // ── no story: screenshots ─────────────────────────────────────────────────

  async chooseShots(): Promise<void> {
    try {
      const files = await this.electron.thumbnailsChooseScreenshots();
      if (files === null) return;
      if (files.length > 3) {
        this.error.set(`Pick 1 to 3 screenshots; ${files.length} were chosen.`);
        return;
      }
      this.error.set(null);
      this.shots.set(files);
    } catch (err) {
      this.error.set((err as Error).message);
    }
  }

  async makeFromShots(): Promise<void> {
    const files = this.shots();
    const titles = this.shotTitles();
    if (files.length === 0) return;
    if (titles.length < files.length) {
      this.error.set(`There are ${titles.length} titles for ${files.length} screenshots; each screenshot needs its own title.`);
      return;
    }
    await this.run(`Making ${files.length} thumbnail${files.length === 1 ? '' : 's'} from your screenshots`, () =>
      this.electron.thumbnailsScreenshots(this.data.jobId, this.data.itemId, files, titles));
    this.shots.set([]);
    const first = this.pairs()[0];
    if (first !== undefined) this.editing.set(first.pair);
  }

  // ── elsewhere ─────────────────────────────────────────────────────────────

  openLook(): void {
    this.dialog.open(ThumbnailLookDialog, { width: '760px', maxHeight: '90vh', autoFocus: false });
  }

  async showFolder(folder: string): Promise<void> {
    try {
      await this.electron.thumbnailsShowFolder(folder);
    } catch (err) {
      this.error.set((err as Error).message);
    }
  }
}
