import { Component, ElementRef, OnDestroy, OnInit, computed, effect, inject, signal, untracked, viewChild, viewChildren } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialog, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { ElectronService } from '../../services/electron';
import { PublishState } from '../../features/publish/publish-state';
import { ThumbnailLookDialog } from './thumbnail-look-dialog';
import { ThumbnailCardEditor, type ThumbnailCardEditorData } from './thumbnail-card-editor';
import { PreviewPieces, Redrawer, composeError, drawCard, readyCompose } from './thumbnail-preview';
import {
  ActionRunner,
  CARD_COUNT,
  cardRequests,
  cardsFromView,
  cardsUsing,
  clearCard,
  clockOf,
  emptyCards,
  failureLine,
  frameList,
  generatedText,
  noPairFor,
  planCards,
  saveBlocked,
  setAdjust,
  setOwn,
  textOptions,
  titleOf,
  toggleFrame,
  togglePhoto,
  toggleText,
  typedText,
  unsavedCards,
  wordsMismatch,
  sameCard,
  type Card,
  type CardPlan,
  type TextOption,
} from './thumbnails-compose';
import type { StoredFrame, StoredPair, ThumbnailsView } from './thumbnails.types';

export interface ThumbnailsWindowData {
  jobId: string;
  itemId: string;
}

/**
 * THE THUMBNAILS WINDOW: THE CARD EDITOR (2026-09-29, Owen: "maybe i select the thumbnail card i
 * want to fill. then i select the frame, the text, and the image of myself to use in it. then i
 * click a different card and do the same ... as soon as i click something, it adds it to the frame.
 * if i unclick it, it removes it from the frame").
 *
 *   - THREE CARDS across the top, each a LIVE preview drawn here with the final render's own layout
 *     and drawing (thumbnail-preview.ts), with the title it goes with under it. One card is ACTIVE
 *     (card 1 on opening); clicking a card makes it active.
 *   - THE TRAYS below: Frames (the grid), Text (every generated line, labelled with its kind and
 *     title, and words he types), Photos. A click puts the item on the active card at once, replacing
 *     what it had; clicking what the active card already has takes it off. The badges on each item
 *     say which cards use it (thumbnails-compose.ts has the rules).
 *   - EDIT (on a card): a larger editor (thumbnail-card-editor.ts) to zoom or move the frame, move or
 *     size the words and the photo. The logo (top right) and the border are drawn automatically and
 *     are never edited.
 *   - SAVE THUMBNAILS draws every card with a frame at 1280x720 and saves the cards in order as the
 *     picks (the first saved card is Pick 1, the video's thumbnail), each card showing its progress
 *     and any failure by name. A card with no frame is left out and says why. Closing with changes
 *     not saved asks first, in the window.
 *
 * A video whose frames and text are not ready is prepared on opening (Owen: "i havent even started
 * making a thumbnail yet. why would i hit finish making thumbnails?"). Every action runs through ONE
 * runner (a spinner and a running clock while it runs, any failure as a banner naming what failed).
 * Closing the window gives back the text model it kept loaded for the words.
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
  private readonly ref = inject<MatDialogRef<ThumbnailsWindow>>(MatDialogRef);
  readonly publish = inject(PublishState);
  readonly data = inject<ThumbnailsWindowData>(MAT_DIALOG_DATA);

  readonly CARD_NUMBERS = Array.from({ length: CARD_COUNT }, (_, i) => i + 1);
  readonly view = signal<ThumbnailsView | null>(null);
  readonly busy = signal<{ what: string; since: number } | null>(null);
  readonly progress = signal<string | null>(null);
  readonly now = signal(Date.now());
  /** The last failure, as a banner, until closed or the next action is asked for. */
  readonly failure = signal<string | null>(null);
  /** A click that was refused, said where the eye is. */
  readonly notice = signal<string | null>(null);

  // ── the cards ─────────────────────────────────────────────────────────────
  readonly cards = signal<Card[]>(emptyCards());
  /** The cards as last saved (what "not saved" is measured against). */
  readonly saved = signal<Card[]>(emptyCards());
  readonly active = signal(1);
  /** The card Save thumbnails is drawing now (from the main process's progress). */
  readonly savingCard = signal<number | null>(null);
  /** Per card: a preview still loading, its failure, its notes. */
  readonly loading = signal<Record<number, boolean>>({});
  readonly cardError = signal<Record<number, string | null>>({});
  readonly cardNotes = signal<Record<number, string[]>>({});
  /** A card whose save failed, and why (shown on the card). */
  readonly saveFailed = signal<Record<number, string>>({});
  /** The saved thumbnails could not be read (the record and its picks disagree): Save is refused. */
  readonly readError = signal<string | null>(null);
  /** Closing was asked with changes not saved: the in-window question is showing. */
  readonly closeAsked = signal(false);
  readonly typed = signal('');
  readonly shots = signal<string[]>([]);

  private readonly canvases = viewChildren<ElementRef<HTMLCanvasElement>>('cardCanvas');

  // ── the cards stay at the top (Owen 2026-09-29: "stickied to the top. as we scroll down, they
  // shrink a bit so i can still select them") ─────────────────────────────────────────────────
  private readonly statusEl = viewChild<ElementRef<HTMLElement>>('status');
  private readonly cardsSecEl = viewChild<ElementRef<HTMLElement>>('cardsSec');
  /** The sticky status line's height: the cards stick just below it. */
  readonly statusHeight = signal(0);
  /** Scrolled past the cards: they shrink to pictures only. */
  readonly compact = signal(false);
  private statusObserver: ResizeObserver | null = null;
  private readonly watchStatus = effect(() => {
    const el = this.statusEl()?.nativeElement;
    this.statusObserver?.disconnect();
    if (el === undefined) return;
    this.statusObserver = new ResizeObserver(() => this.statusHeight.set(el.offsetHeight));
    this.statusObserver.observe(el);
  });

  /** Shrink once the cards' own top has scrolled under the status line; grow back near the top (a gap so the change in height cannot flicker). */
  onScroll(event: Event): void {
    const sec = this.cardsSecEl()?.nativeElement;
    if (sec === undefined) return;
    const scrolled = (event.target as HTMLElement).scrollTop;
    const stuckAt = this.naturalTop(sec) - this.statusHeight();
    if (!this.compact() && scrolled > stuckAt + 40) this.compact.set(true);
    else if (this.compact() && scrolled < stuckAt + 4) this.compact.set(false);
  }

  /** The section's top in the scrolling content when not stuck: the element before it, which does not move. */
  private naturalTop(sec: HTMLElement): number {
    const prev = sec.previousElementSibling as HTMLElement | null;
    return prev === null ? 0 : prev.offsetTop + prev.offsetHeight;
  }
  private pieces: PreviewPieces;
  private readonly redrawers = new Map<HTMLCanvasElement, { redrawer: Redrawer; shape: string }>();

  private readonly runner = new ActionRunner({
    busy: (state) => {
      this.busy.set(state);
      if (state === null) {
        this.progress.set(null);
        this.savingCard.set(null);
      }
    },
    failed: (line) => this.failure.set(line),
  });
  private unsubscribe: (() => void) | null = null;
  private clock: ReturnType<typeof setInterval> | null = null;
  /** Pick 1's source file when the publish record was last set from it. */
  private publishedFrom: string | null = null;

  constructor() {
    this.pieces = new PreviewPieces(this.electron, this.data.jobId, this.data.itemId);
    // Closing asks first when a card changed (the window's own question, never a browser dialog).
    this.ref.disableClose = true;
    this.ref.backdropClick().subscribe(() => this.requestClose());
    this.ref.keydownEvents().subscribe((event) => {
      if (event.key === 'Escape') this.requestClose();
    });
    // Each card redraws when it, the look or its surface changes; the rest are left as they are.
    effect(() => {
      const compose = this.view()?.compose ?? null;
      const cards = this.cards();
      const canvases = this.canvases();
      for (const ref of canvases) {
        const el = ref.nativeElement;
        const n = Number(el.dataset['card']);
        const card = cards.find((c) => c.n === n);
        if (card === undefined) continue;
        const shape = JSON.stringify([card, compose === null ? null : 'error' in compose ? compose.error : [compose.style, compose.border?.length, compose.logo?.image.length]]);
        let entry = this.redrawers.get(el);
        if (entry === undefined) {
          entry = { redrawer: new Redrawer(() => this.paint(el, n)), shape: '' };
          this.redrawers.set(el, entry);
        }
        if (entry.shape === shape) continue;
        entry.shape = shape;
        const draw = entry.redrawer;
        untracked(() => draw.request());
      }
    });
  }

  readonly record = computed(() => this.view()?.record ?? null);
  readonly pairs = computed<StoredPair[]>(() => this.record()?.pairs ?? []);
  readonly options = computed(() => textOptions(this.pairs()));
  /**
   * The grid. Empty while the frames are to be prepared again (an old record's up-to-120 scoring
   * frames): the stored ones are about to be replaced, look-alikes dropped, so they are not offered.
   */
  readonly frameIds = computed(() => (this.view()?.finish?.run.includes('frames') ? [] : frameList(this.record())));
  readonly plans = computed<CardPlan[]>(() => planCards(this.cards(), this.pairs()));
  readonly unsaved = computed(() => unsavedCards(this.cards(), this.saved()));
  readonly elapsed = computed(() => {
    const b = this.busy();
    return b === null ? '' : clockOf(this.now() - b.since);
  });
  /** The report's chosen titles (pick n goes with title n), when the publish record open is this item's. */
  readonly chosenTitles = computed(() => (this.publish.itemId() === this.data.itemId ? this.publish.chosenTitles() : []));
  readonly activeCard = computed(() => this.cards().find((c) => c.n === this.active())!);
  /** Why the cards cannot be drawn (the look, border or logo could not be read), or null. */
  readonly composeProblem = computed(() => composeError(this.view()?.compose));
  /** The look's own lines (an older look read with new defaults, no logo kept, no border). */
  readonly lookLines = computed(() => {
    const c = this.view()?.compose;
    return readyCompose(c) ? c.lines : [];
  });

  /** Why the trays cannot fill a card now (his own image still can), or null. */
  readonly fillBlocked = computed<string | null>(() => {
    const v = this.view();
    if (v === null) return 'The thumbnails are not read yet.';
    const r = v.record;
    const own = this.ownBlocked();
    if (own !== null || r === null) return own;
    if (r.state === 'failed') return 'The frames and text for this video are not ready yet.';
    if (r.state === 'no-story') return 'This report has no story to take frames from. Make thumbnails from your screenshots below, or use your own image on a card.';
    if (composeError(v.compose) !== null) return `The thumbnails cannot be drawn: ${composeError(v.compose)}`;
    return null;
  });

  /** Why Save thumbnails cannot run now, or null. */
  readonly saveWhy = computed<string | null>(() => {
    const b = this.busy();
    if (b !== null) return `Wait: ${b.what.toLowerCase()} is running.`;
    const v = this.view();
    if (v === null) return 'The thumbnails are not read yet.';
    const unread = this.readError();
    if (unread !== null) return `Your saved thumbnails could not be read, so saving would write over them: ${unread}`;
    const own = this.ownBlocked();
    if (own !== null) return own;
    return saveBlocked(this.cards(), this.pairs(), v.picks.length);
  });

  /**
   * Why nothing at all can be saved in this window, not even his own image (the main process refuses
   * the same): a report from before thumbnails were made with the metadata, or one whose thumbnails
   * were switched off. Null otherwise.
   */
  readonly ownBlocked = computed<string | null>(() => {
    const r = this.view()?.record;
    if (r === undefined) return 'The thumbnails are not read yet.';
    if (r === null) return 'This report was made before thumbnails were made with the metadata. Use the Thumbnail row\'s Choose… on the report for your own image.';
    if (r.state === 'off') return r.line;
    return null;
  });

  async ngOnInit(): Promise<void> {
    this.unsubscribe = this.electron.onThumbnailsProgress((event) => {
      if (event.jobId !== this.data.jobId || event.itemId !== this.data.itemId) return;
      this.progress.set(event.line);
      if (event.card !== undefined) this.savingCard.set(event.card);
    });
    this.clock = setInterval(() => this.now.set(Date.now()), 1000);
    const view = await this.runner.run('Reading the thumbnails', () => this.electron.thumbnailsItem(this.data.jobId, this.data.itemId));
    if (view === null) return;
    this.takeView(view, true);
    this.publishedFrom = view.picks[0]?.pick.file ?? null;
    // Not ready (the metadata job's preparation stopped, or an older version made it): prepared on
    // opening, with no button to find. A reason it cannot run now is shown instead, with Try again.
    if (view.finish !== null && view.finish.blocked === null) await this.prepare();
  }

  ngOnDestroy(): void {
    this.statusObserver?.disconnect();
    this.unsubscribe?.();
    if (this.clock !== null) clearInterval(this.clock);
    // The window is gone, so there is nowhere to show a failure: the main process never refuses
    // this (it is housekeeping), and a missing bridge is said in the console.
    void this.electron.thumbnailsClosed().catch((err: Error) => console.error('[Thumbnails] closing the window:', err.message));
  }

  /** A new view; with `cards`, the cards are read from it too (opening, a save, new frames). */
  private takeView(view: ThumbnailsView, cards: boolean): void {
    this.view.set(view);
    if (!cards) return;
    let read: Card[];
    try {
      read = cardsFromView(view);
      this.readError.set(null);
    } catch (err) {
      // The cards are left empty and Save is refused with this reason: saving would write over
      // picks that could not be read.
      this.readError.set((err as Error).message);
      this.failure.set(failureLine('Reading your saved thumbnails', err));
      read = emptyCards();
    }
    this.saved.set(read);
    this.cards.set(read);
  }

  /** Draw card n on its surface; its loading line, failure and notes follow. */
  private async paint(el: HTMLCanvasElement, n: number): Promise<void> {
    const card = this.cards().find((c) => c.n === n);
    const compose = this.view()?.compose;
    if (card === undefined || !readyCompose(compose)) return;
    const set = <T>(sig: { update(fn: (v: Record<number, T>) => Record<number, T>): void }, value: T) => sig.update((v) => ({ ...v, [n]: value }));
    set(this.loading, true);
    try {
      const drawn = await drawCard(el, card, this.pieces, compose);
      if (drawn === null) el.getContext('2d')?.clearRect(0, 0, el.width, el.height);
      set(this.cardError, null);
      set(this.cardNotes, drawn?.notes ?? []);
    } catch (err) {
      set(this.cardError, (err as Error).message);
      set(this.cardNotes, []);
    } finally {
      set(this.loading, false);
    }
  }

  /**
   * One action through the runner: the new view, and the video's thumbnail kept on pick 1 (set
   * through the publish record's one door whenever pick 1's source changes; with no picks left, a
   * thumbnail that was pick 1's copy is cleared, and one Owen chose himself is left).
   */
  private async act(what: string, fn: () => Promise<ThumbnailsView>, cards: boolean): Promise<boolean> {
    const done = await this.runner.run(what, async () => {
      const view = await fn();
      this.takeView(view, cards);
      await this.followPublish(view);
      return view;
    });
    return done !== null;
  }

  private async followPublish(view: ThumbnailsView): Promise<void> {
    const first = view.picks[0]?.pick.file ?? null;
    if (first !== this.publishedFrom && this.publish.itemId() === this.data.itemId) {
      if (view.publishFile !== null) await this.publish.setThumbnail(view.publishFile);
      else {
        const current = this.publish.thumbnailPath();
        if (current !== null && view.picksFolder !== null && current.startsWith(view.picksFolder)) await this.publish.clearThumbnail();
      }
    }
    this.publishedFrom = first;
  }

  // ── the cards ─────────────────────────────────────────────────────────────

  selectCard(n: number): void {
    this.active.set(n);
    this.notice.set(null);
  }

  plan(n: number): CardPlan {
    return this.plans().find((p) => p.n === n)!;
  }

  card(n: number): Card {
    return this.cards().find((c) => c.n === n)!;
  }

  /** The title card n goes with once saved (pick k, title k: his chosen titles first). */
  titleFor(n: number): { title: string; chosen: boolean } | null {
    return titleOf(this.plan(n).position, this.chosenTitles(), this.view()?.titles ?? []);
  }

  /** Whether a saved pick is card n (a pair's drawing, or his own image put on it). */
  isPicked(n: number): boolean {
    return (this.view()?.picks ?? []).some((p) => (p.pick.kind === 'made' ? p.pick.pair === n : (p.pick.card ?? p.n) === n));
  }

  /** Card n's state in a few words. */
  cardState(n: number): string {
    if (this.unsaved().includes(n)) return 'Changed: not saved yet.';
    if (this.isPicked(n)) return 'Saved.';
    return this.plan(n).saved === null ? '' : 'Not saved yet.';
  }

  /** Card n's words were written for another title than the chosen one it goes with. */
  mismatch(n: number): string | null {
    return wordsMismatch(this.card(n), this.titleFor(n));
  }

  /** Put a change on the active card, unless it cannot hold frames and text. */
  private change(fn: (cards: Card[], n: number) => Card[]): void {
    const n = this.active();
    const blocked = this.fillBlocked() ?? noPairFor(n, this.pairs());
    if (blocked !== null) {
      this.notice.set(blocked);
      return;
    }
    this.notice.set(null);
    this.saveFailed.update((f) => {
      const next = { ...f };
      delete next[n];
      return next;
    });
    this.cards.set(fn(this.cards(), n));
  }

  clickFrame(id: string): void {
    this.change((cards, n) => toggleFrame(cards, n, id));
  }

  clickText(option: TextOption): void {
    this.change((cards, n) => toggleText(cards, n, option));
  }

  clickPhoto(name: string): void {
    this.change((cards, n) => togglePhoto(cards, n, name));
  }

  putTyped(): void {
    let option: TextOption;
    try {
      option = typedText(this.typed());
    } catch (err) {
      this.notice.set((err as Error).message);
      return;
    }
    this.typed.set('');
    if (this.activeCard().text?.key === option.key) return;
    this.clickText(option);
  }

  clear(n: number, event: Event): void {
    event.stopPropagation();
    this.active.set(n);
    this.cards.set(clearCard(this.cards(), n));
  }

  /** Put back what is saved on card n. */
  undo(n: number, event: Event): void {
    event.stopPropagation();
    const saved = this.saved().find((c) => c.n === n)!;
    this.cards.set(this.cards().map((c) => (c.n === n ? saved : c)));
  }

  async useOwn(n: number, event: Event): Promise<void> {
    event.stopPropagation();
    this.active.set(n);
    this.failure.set(null);
    const own = await this.runner.run('Choosing your image', () => this.electron.thumbnailsChooseOwn());
    if (own === null) return;
    this.cards.set(setOwn(this.cards(), n, own));
  }

  // ── what the trays show ───────────────────────────────────────────────────

  frameCards(id: string): number[] {
    return cardsUsing(this.cards(), (c) => c.frameId === id);
  }

  textCards(option: TextOption): number[] {
    return cardsUsing(this.cards(), (c) => c.text?.key === option.key);
  }

  photoCards(name: string): number[] {
    return cardsUsing(this.cards(), (c) => c.photo === name);
  }

  onActive(numbers: number[]): boolean {
    return numbers.includes(this.active());
  }

  /** Text on a card that is not in the generated list (typed words, or words written for a title since replaced). */
  readonly otherTexts = computed(() => {
    const keys = new Set(this.options().map((o) => o.key));
    const seen = new Set<string>();
    return this.cards().flatMap((c) => (c.own === null && c.text !== null && !keys.has(c.text.key) && !seen.has(c.text.key) && seen.add(c.text.key) ? [c.text] : []));
  });

  frameInfo(id: string): string {
    const f = this.record()?.frames.find((x: StoredFrame) => x.id === id);
    if (f === undefined) return id;
    if (this.record()?.source?.video === null) return `Screenshot ${f.scene}`;
    return f.clock;
  }

  framePicture(id: string): string | null {
    return this.view()?.frames[id] ?? null;
  }

  // ── edit, save, close ─────────────────────────────────────────────────────

  /** Why card n cannot be edited, or null. */
  editBlocked(n: number): string | null {
    const c = this.card(n);
    if (c.own !== null) return 'Your own image is saved as it is.';
    if (c.frameId === null) return 'Pick a frame for it first.';
    const compose = this.view()?.compose;
    if (!readyCompose(compose)) return this.fillBlocked();
    return null;
  }

  edit(n: number, event: Event): void {
    event.stopPropagation();
    this.active.set(n);
    const compose = this.view()?.compose;
    if (this.editBlocked(n) !== null || !readyCompose(compose)) return;
    const data: ThumbnailCardEditorData = { card: this.card(n), pieces: this.pieces, compose, title: this.titleFor(n)?.title ?? null };
    const ref = this.dialog.open(ThumbnailCardEditor, { data, width: '1100px', maxWidth: '96vw', maxHeight: '96vh', autoFocus: false });
    ref.afterClosed().subscribe((adjust) => {
      if (adjust === undefined) return;
      try {
        this.cards.set(setAdjust(this.cards(), n, adjust));
      } catch (err) {
        this.failure.set(failureLine(`Keeping your changes to thumbnail ${n}`, err));
      }
    });
  }

  /**
   * SAVE THUMBNAILS: every card with a frame drawn at 1280x720 with its edits, then the cards in
   * order saved as the picks. A card that cannot be drawn stops it, named on the card, and nothing
   * is saved. Changes made while it runs stay on the cards, not saved yet.
   */
  async save(): Promise<boolean> {
    if (this.saveWhy() !== null) return false;
    this.failure.set(null);
    this.notice.set(null);
    this.saveFailed.set({});
    const sent = this.cards();
    const requests = cardRequests(sent, this.pairs());
    const done = await this.runner.run('Saving the thumbnails', () => this.electron.thumbnailsSaveCards(this.data.jobId, this.data.itemId, requests).catch((err: Error) => this.failedOnCard(err)));
    if (done === null) return false;
    const changedMeanwhile = this.cards().some((c, i) => !sameCard(c, sent[i]));
    const kept = changedMeanwhile ? this.cards() : null;
    this.takeView(done, true);
    if (kept !== null) this.cards.set(kept);
    await this.runner.run('Setting the video\'s thumbnail', () => this.followPublish(done));
    return true;
  }

  /** "Thumbnail 2 could not be drawn, so nothing was saved: ..." is said on that card too; the failure goes on to the banner. */
  private failedOnCard(err: Error): never {
    const n = /^Thumbnail (\d) could not be drawn/.exec(err.message)?.[1];
    if (n !== undefined) this.saveFailed.set({ [Number(n)]: err.message });
    throw err;
  }

  /** Close, asking first (in the window) when a card has changes that are not saved. */
  requestClose(): void {
    if (this.busy() !== null && /^Saving/.test(this.busy()!.what)) {
      this.notice.set('Wait: the thumbnails are being saved.');
      return;
    }
    if (this.unsaved().length > 0) {
      this.closeAsked.set(true);
      return;
    }
    this.ref.close();
  }

  async saveAndClose(): Promise<void> {
    this.closeAsked.set(false);
    if (await this.save()) this.ref.close();
  }

  closeWithoutSaving(): void {
    this.ref.close();
  }

  /** The cards with changes not saved, in words. */
  unsavedLine(): string {
    const list = this.unsaved();
    return list.length === 1 ? `Thumbnail ${list[0]} has changes that are not saved.` : `Thumbnails ${list.join(', ').replace(/, (\d)$/, ' and $1')} have changes that are not saved.`;
  }

  // ── rewrite the words for a title ─────────────────────────────────────────

  /** Why "Rewrite words for this title" cannot run now, or null. */
  rewriteBlocked(): string | null {
    if (this.busy() !== null) return `Wait: ${this.busy()!.what.toLowerCase()} is running.`;
    return null;
  }

  /** New words for card n's title (pair n's words are written again for it); they go on card n, not saved yet. */
  async rewrite(n: number, event: Event): Promise<void> {
    event.stopPropagation();
    const title = this.titleFor(n);
    if (title === null) return;
    this.failure.set(null);
    const kind = this.card(n).text?.kind ?? null;
    const answer = await this.runner.run(`Writing the words for “${title.title}”`, () => this.electron.thumbnailsPairTitle(this.data.jobId, this.data.itemId, n, title.title, kind));
    if (answer === null) return;
    this.view.set(answer.view);
    const option = generatedText(this.options(), answer.text.kind, answer.text.phrase, answer.text.wordsFor, n);
    this.cards.set(this.cards().map((c) => (c.n === n ? { ...c, text: option } : c)));
  }

  // ── a video whose frames and text are not ready ───────────────────────────

  /** Prepares what is missing (frames on the CPU, the words on the 27B); on opening, and on Try again. */
  async prepare(): Promise<void> {
    this.failure.set(null);
    this.pieces.forgetFrames();
    await this.act('Preparing the frames and text', () => this.electron.thumbnailsFinish(this.data.jobId, this.data.itemId), true);
  }

  /** Reads the view again (a Crucible server may be there now) and prepares if it can. */
  async tryAgain(): Promise<void> {
    this.failure.set(null);
    const view = await this.runner.run('Reading the thumbnails', () => this.electron.thumbnailsItem(this.data.jobId, this.data.itemId));
    if (view === null) return;
    this.takeView(view, true);
    if (view.finish !== null && view.finish.blocked === null) await this.prepare();
  }

  /** What is missing, in Owen's terms. */
  missingOf(run: readonly string[]): string {
    return run.includes('frames') ? 'the frames and text' : run.includes('words') ? 'the text' : 'the drawings';
  }

  // ── no story: screenshots ─────────────────────────────────────────────────

  readonly canScreenshots = computed(() => {
    const r = this.record();
    return r !== null && (r.state === 'no-story' || (r.state === 'failed' && r.story?.state !== 'linked') || (r.state === 'made' && r.source?.video === null));
  });

  /** Every title the words can be written for: the chosen ones first, then the generated ones. */
  readonly titleChoices = computed(() => [...new Set([...this.chosenTitles(), ...(this.view()?.titles ?? [])])]);
  readonly shotTitles = computed(() => this.titleChoices().slice(0, this.shots().length));

  async chooseShots(): Promise<void> {
    this.failure.set(null);
    const files = await this.runner.run('Choosing screenshots', () => this.electron.thumbnailsChooseScreenshots());
    if (files === null) return;
    if (files.length > CARD_COUNT) {
      this.notice.set(`Pick 1 to 3 screenshots; ${files.length} were chosen.`);
      return;
    }
    this.shots.set(files);
  }

  /** Screenshots make that many pairs; each card then shows its screenshot with the words written for its title. */
  async makeFromShots(): Promise<void> {
    const files = this.shots();
    const titles = this.shotTitles();
    if (files.length === 0) return;
    this.failure.set(null);
    this.pieces.forgetFrames();
    const what = `Making ${files.length} thumbnail${files.length === 1 ? '' : 's'} from your screenshots`;
    if (await this.act(what, () => this.electron.thumbnailsScreenshots(this.data.jobId, this.data.itemId, files, titles), true)) this.shots.set([]);
  }

  // ── elsewhere ─────────────────────────────────────────────────────────────

  openLook(): void {
    const ref = this.dialog.open(ThumbnailLookDialog, { width: '760px', maxHeight: '90vh', autoFocus: false });
    // Photos, the logo, the border or the look may have changed: read them again (the cards stay).
    ref.afterClosed().subscribe(async () => {
      this.pieces.forgetPhotos();
      const view = await this.runner.run('Reading the thumbnails', () => this.electron.thumbnailsItem(this.data.jobId, this.data.itemId));
      if (view !== null) this.takeView(view, false);
    });
  }

  async showFolder(folder: string): Promise<void> {
    await this.runner.run('Opening the folder', () => this.electron.thumbnailsShowFolder(folder));
  }

  fileName(file: string): string {
    return file.split('/').pop() ?? file;
  }
}
