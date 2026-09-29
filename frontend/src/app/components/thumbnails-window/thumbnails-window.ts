import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { ElectronService } from '../../services/electron';
import { PublishState } from '../../features/publish/publish-state';
import { ThumbnailLookDialog } from './thumbnail-look-dialog';
import {
  ActionRunner,
  MAX_PICKS,
  NO_TEXT,
  addNoPhoto,
  clockOf,
  drawChange,
  failureLine,
  frameList,
  generateBlocked,
  photoNumbers,
  pickRequests,
  planSlots,
  ready,
  removePhotoAt,
  samePicks,
  selectionFromPicks,
  suggestedTexts,
  textOptions,
  togglePhoto,
  togglePick,
  typedText,
  wantedChange,
  type PhotoOption,
  type Slot,
  type TextOption,
} from './thumbnails-compose';
import type { PickRequest, PickView, StoredFrame, StoredPair, ThumbnailsView } from './thumbnails.types';

export interface ThumbnailsWindowData {
  jobId: string;
  itemId: string;
}

/**
 * THE THUMBNAILS WINDOW (2026-09-29, rebuilt twice that day with Owen). Top to bottom:
 *
 *   1. FRAMES: one flat list of the story's frames in time order (at most two per scene, the
 *      sharpest, chosen on the CPU; nothing ranks them since the frame scoring was removed
 *      2026-09-29). Up to three, in click order (badges 1, 2, 3). Frame n is thumbnail n's: the run
 *      gives no pair a frame, so a thumbnail is drawn only once its frame is picked.
 *   2. TEXT: every line the model wrote, one per row, with its kind and the title it was written
 *      for in small text; typed words; "No text". Up to three, in click order.
 *   3. PHOTOS: one row of Owen's reaction photos and "No photo". Up to three, in click order: photo n
 *      goes on thumbnail n (Owen: "just let me pick the image of myself that goes in the corner
 *      instead of letting the model pick it"). The logo switch.
 *   4. GENERATE THUMBNAILS, at the bottom (Owen: "the 'generate thumbnails' button should be at the
 *      bottom"): draws thumbnail n = frame n + text n + photo n + logo, then saves them as the
 *      ordered picks (pick 1 the video's thumbnail through the publish record's one door; pick n goes
 *      with title n in an A/B test). Disabled, with the reason written beside it, until at least one
 *      frame and text are picked. Nothing is drawn before it is pressed.
 *   5. YOUR THUMBNAILS: what was generated, large and phone-size; a card whose picks changed since
 *      says so. His own image can take any place; "Rewrite words for this title" when a thumbnail's
 *      words were written for another title than the one it goes with.
 *
 * A report whose thumbnail stages stopped says where and why, with "Finish making thumbnails" (only
 * the missing stages) and "Make thumbnails again from scratch". Every action runs through ONE runner
 * (thumbnails-compose.ts ActionRunner): a spinner and a running clock while it runs, and any failure
 * as a banner naming what failed. Picking rules: thumbnails-compose.ts.
 *
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
  readonly publish = inject(PublishState);
  readonly data = inject<ThumbnailsWindowData>(MAT_DIALOG_DATA);

  readonly MAX_PICKS = MAX_PICKS;
  readonly NO_TEXT = NO_TEXT;
  readonly view = signal<ThumbnailsView | null>(null);
  readonly busy = signal<{ what: string; since: number } | null>(null);
  readonly progress = signal<string | null>(null);
  readonly now = signal(Date.now());
  /** The last failure, as a banner, until closed or the next action is asked for. */
  readonly failure = signal<string | null>(null);
  /** A click that was refused (a fourth pick), said where the eye is. */
  readonly notice = signal<string | null>(null);

  // ── Owen's picks (in click order) ─────────────────────────────────────────
  readonly frames = signal<string[]>([]);
  readonly texts = signal<TextOption[]>([]);
  readonly photos = signal<PhotoOption[]>([]);
  readonly own = signal<Record<number, string>>({});
  readonly logo = signal(true);
  readonly typed = signal('');
  /** The thumbnail being drawn now, for its card. */
  readonly drawing = signal<number | null>(null);

  readonly shots = signal<string[]>([]);

  private readonly runner = new ActionRunner({
    busy: (state) => {
      this.busy.set(state);
      if (state === null) this.progress.set(null);
    },
    failed: (line) => this.failure.set(line),
  });
  private unsubscribe: (() => void) | null = null;
  private clock: ReturnType<typeof setInterval> | null = null;
  /** Pick 1's source file when the publish record was last set from it. */
  private publishedFrom: string | null = null;

  readonly record = computed(() => this.view()?.record ?? null);
  readonly pairs = computed<StoredPair[]>(() => this.record()?.pairs ?? []);
  readonly options = computed(() => textOptions(this.pairs()));
  /**
   * The grid. Empty while the frames are to be prepared again (an old record's up-to-120 scoring
   * frames, Owen 2026-09-29: "doesnt look like anything changed at all"): the stored ones are about
   * to be replaced, look-alikes dropped, so they are not offered.
   */
  readonly frameIds = computed(() => (this.view()?.finish?.run.includes('frames') ? [] : frameList(this.record())));
  readonly slots = computed<Slot[]>(() => planSlots({ pairs: this.pairs(), frames: this.frames(), texts: this.texts(), photos: this.photos(), own: this.own() }));
  readonly elapsed = computed(() => {
    const b = this.busy();
    return b === null ? '' : clockOf(this.now() - b.since);
  });
  /** The report's chosen titles (pick n goes with title n), when the publish record open is this item's. */
  readonly chosenTitles = computed(() => (this.publish.itemId() === this.data.itemId ? this.publish.chosenTitles() : []));

  /** Why the record's thumbnails cannot be drawn now, or null when they can. */
  readonly drawBlocked = computed<string | null>(() => {
    const v = this.view();
    if (v === null) return 'The thumbnails are not read yet.';
    const r = v.record;
    if (r === null) return 'This report was made before thumbnails were made with the metadata. Use the Thumbnail row\'s Choose… for your own image, or “Use my own image…” below.';
    if (r.state === 'off') return r.line;
    if (r.state === 'failed') return 'The frames and text for this video are not ready yet.';
    if (r.state === 'no-story') return 'This report has no story to take frames from. Make thumbnails from your screenshots below.';
    return null;
  });

  /** Why Generate thumbnails cannot run now, or null. */
  readonly generateWhy = computed<string | null>(() => {
    const b = this.busy();
    if (b !== null) return `Wait: ${b.what.toLowerCase()} is running.`;
    return generateBlocked(this.slots(), this.drawBlocked());
  });

  readonly canPickFrames = computed(() => this.frameIds().length > 0);

  async ngOnInit(): Promise<void> {
    this.unsubscribe = this.electron.onThumbnailsProgress((event) => {
      if (event.jobId === this.data.jobId && event.itemId === this.data.itemId) this.progress.set(event.line);
    });
    this.clock = setInterval(() => this.now.set(Date.now()), 1000);
    const view = await this.runner.run('Reading the thumbnails', () => this.electron.thumbnailsItem(this.data.jobId, this.data.itemId));
    if (view === null) return;
    this.view.set(view);
    this.publishedFrom = view.picks[0]?.pick.file ?? null;
    this.readSelection(view);
    // Not ready (the metadata job's thumbnail preparation stopped, or an older version made it):
    // prepared on opening, with no button to find (Owen 2026-09-29: "i havent even started making
    // a thumbnail yet. why would i hit finish making thumbnails?"). A reason it cannot run now is
    // shown instead, with Try again.
    if (view.finish !== null && view.finish.blocked === null) await this.prepare();
  }

  ngOnDestroy(): void {
    this.unsubscribe?.();
    if (this.clock !== null) clearInterval(this.clock);
    // The window is gone, so there is nowhere to show a failure: the main process never refuses a
    // release (it is housekeeping), and a missing bridge is said in the console.
    void this.electron.thumbnailsReleaseModel().catch((err: Error) => console.error('[Thumbnails] giving back the text model:', err.message));
  }

  /** Owen's picks as the saved picks stand for them; the logo as the drawn thumbnails have it. */
  private readSelection(view: ThumbnailsView): void {
    const pairs = view.record?.pairs ?? [];
    let sel: ReturnType<typeof selectionFromPicks>;
    try {
      sel = selectionFromPicks(view.picks, pairs);
    } catch (err) {
      this.failure.set(failureLine('Reading your saved picks', err));
      return;
    }
    this.frames.set(sel.frames);
    this.texts.set(sel.texts);
    this.photos.set(sel.photos);
    this.own.set(sel.own);
    const drawnLogo = pairs.find((p) => view.picks.some((k) => k.pick.kind === 'made' && k.pick.pair === p.pair))?.default.logo;
    this.logo.set(view.hasLogo && (drawnLogo ?? true));
  }

  /**
   * One action through the runner: the new view, and the video's thumbnail kept on pick 1 (set
   * through the publish record's one door whenever pick 1's source changes; with no picks left, a
   * thumbnail that was pick 1's copy is cleared, and one Owen chose himself is left).
   */
  private async act(what: string, fn: () => Promise<ThumbnailsView>): Promise<boolean> {
    const done = await this.runner.run(what, async () => {
      const view = await fn();
      this.view.set(view);
      const first = view.picks[0]?.pick.file ?? null;
      if (first !== this.publishedFrom && this.publish.itemId() === this.data.itemId) {
        if (view.publishFile !== null) await this.publish.setThumbnail(view.publishFile);
        else {
          const current = this.publish.thumbnailPath();
          if (current !== null && view.picksFolder !== null && current.startsWith(view.picksFolder)) await this.publish.clearThumbnail();
        }
      }
      this.publishedFrom = first;
      return view;
    });
    return done !== null;
  }

  /** A change Owen made to his picks: nothing is drawn until Generate thumbnails; old lines go. */
  private changed(): void {
    this.notice.set(null);
  }

  /**
   * GENERATE THUMBNAILS: every place with a frame and a text is drawn (pair n takes frame n, text n,
   * photo n, the logo; always drawn fresh, so a look changed since is used), then the places are
   * saved as the ordered picks. One at a time through the runner; a failure stops it with its banner.
   */
  async generate(): Promise<void> {
    if (this.generateWhy() !== null) return;
    this.failure.set(null);
    this.notice.set(null);
    // A stopped or story-less record draws nothing; only Owen's own images are saved then.
    const slots = this.drawBlocked() === null ? this.slots().filter(ready) : [];
    for (const slot of slots) {
      const change = drawChange(slot, this.logo());
      this.drawing.set(slot.n);
      const ok = await this.act(`Drawing thumbnail ${slot.n}`, () => this.electron.thumbnailsRenderPair(this.data.jobId, this.data.itemId, change));
      this.drawing.set(null);
      if (!ok) return;
      const now = this.slots().find((s) => s.n === slot.n)!;
      if (wantedChange(now, this.pairs(), this.logo()) !== null) {
        this.failure.set(`Thumbnail ${slot.n} was drawn, and it still does not show what was picked. Close the window and open it again; if it happens again, the record and the picks disagree.`);
        return;
      }
    }
    const requests: PickRequest[] | null = this.drawBlocked() === null
      ? pickRequests(this.slots(), this.pairs(), this.logo())
      : this.slots().flatMap((s) => (s.own === null ? [] : [{ kind: 'own' as const, file: s.own }]));
    if (requests === null) {
      this.failure.set('A thumbnail changed while the others were drawn. Press Generate thumbnails again.');
      return;
    }
    if (!samePicks(requests, this.view()?.picks ?? [])) {
      await this.act('Saving your picks', () => this.electron.thumbnailsSavePicks(this.data.jobId, this.data.itemId, requests));
    }
  }

  // ── 1. frames ─────────────────────────────────────────────────────────────

  frameNumber(id: string): number | null {
    const i = this.frames().indexOf(id);
    return i === -1 ? null : i + 1;
  }

  toggleFrame(id: string): void {
    const r = togglePick(this.frames(), id, (x) => x, 'frames');
    if (r.refused !== null) {
      this.notice.set(r.refused);
      return;
    }
    this.frames.set(r.list);
    this.changed();
  }

  frameInfo(id: string): string {
    const f = this.record()?.frames.find((x: StoredFrame) => x.id === id);
    if (f === undefined) return id;
    if (this.record()?.source?.video === null) return `Screenshot ${f.scene}`;
    return f.clock;
  }

  framePicture(id: string): string | null {
    return this.view()?.frames[id] ?? null;
  }

  // ── 2. text ───────────────────────────────────────────────────────────────

  textNumber(option: TextOption): number | null {
    const i = this.texts().findIndex((t) => t.key === option.key);
    return i === -1 ? null : i + 1;
  }

  toggleText(option: TextOption): void {
    const r = togglePick(this.texts(), option, (t) => t.key, 'lines of text');
    if (r.refused !== null) {
      this.notice.set(r.refused);
      return;
    }
    this.texts.set(r.list);
    this.changed();
  }

  /** Typed words that are picked (they are not in the generated list). */
  readonly typedPicked = computed(() => this.texts().filter((t) => t.kind === null && t.phrase !== null));

  addTyped(): void {
    let option: TextOption;
    try {
      option = typedText(this.typed());
    } catch (err) {
      this.notice.set((err as Error).message);
      return;
    }
    if (this.textNumber(option) !== null) {
      this.notice.set('These words are already picked.');
      return;
    }
    this.typed.set('');
    this.toggleText(option);
  }

  // ── 3. photos ─────────────────────────────────────────────────────────────

  photoNumber(name: string): number | null {
    return photoNumbers(this.photos(), name)[0] ?? null;
  }

  /** The places "No photo" holds, 1-based. */
  readonly noPhotoNumbers = computed(() => photoNumbers(this.photos(), null));

  togglePhoto(name: string): void {
    const r = togglePhoto(this.photos(), name);
    if (r.refused !== null) {
      this.notice.set(r.refused);
      return;
    }
    this.photos.set(r.list);
    this.changed();
  }

  addNoPhoto(): void {
    const r = addNoPhoto(this.photos());
    if (r.refused !== null) {
      this.notice.set(r.refused);
      return;
    }
    this.photos.set(r.list);
    this.changed();
  }

  /** Take one "No photo" out (its badge was clicked); the rest close up. */
  removeNoPhoto(n: number): void {
    this.photos.set(removePhotoAt(this.photos(), n - 1));
    this.changed();
  }

  setLogo(on: boolean): void {
    this.logo.set(on);
    this.changed();
  }

  // ── 4. generate, 5. result ────────────────────────────────────────────────

  /** What Generate thumbnails will draw, one line per place. */
  readonly plan = computed(() => this.slots().map((s) => {
    if (s.own !== null) return `${s.n}: your image`;
    if (!ready(s)) return `${s.n}: ${s.missing ?? 'not picked'}`;
    const photo = s.photo === null ? 'no photo' : `photo “${s.photo}”`;
    return `${s.n}: frame ${s.pickIndex! + 1} + ${s.text!.phrase === null ? 'no text' : `text ${s.pickIndex! + 1}`} + ${photo}`;
  }));

  /** The saved pick this place is (1-based), or null while it is not saved. */
  pickOf(slot: Slot): PickView | null {
    const picks = this.view()?.picks ?? [];
    return picks.find((p) => (slot.own !== null ? p.pick.kind === 'own' && p.pick.file === slot.own : p.pick.kind === 'made' && p.pick.pair === slot.n)) ?? null;
  }

  /**
   * The generated picture of place n, once Generate thumbnails has saved it as a pick; `current` is
   * false when the picks changed since (the card says to generate again).
   */
  resultPicture(slot: Slot): { src: string; current: boolean } | null {
    const pv = this.pickOf(slot);
    if (slot.own !== null) return pv !== null && pv.picture !== '' ? { src: pv.picture, current: true } : null;
    if (pv === null || this.drawBlocked() !== null) return null;
    const pair = this.pairs().find((p) => p.pair === slot.n);
    if (pair === undefined || !pair.default.render.ok) return null;
    const src = this.view()?.renders[pair.default.render.file];
    if (src === undefined) return null;
    return { src, current: ready(slot) && wantedChange(slot, this.pairs(), this.logo()) === null };
  }

  renderNotes(slot: Slot): string[] {
    if (this.pickOf(slot) === null) return [];
    const r = this.pairs().find((p) => p.pair === slot.n)?.default.render;
    return r !== undefined && r.ok ? r.notes : [];
  }

  /** The title this place goes with (pick k goes with chosen title k), or null. */
  titleFor(pick: PickView | null): string | null {
    return pick === null ? null : this.chosenTitles()[pick.n - 1] ?? null;
  }

  /** Its words were written for another title than the one it goes with. */
  mismatch(slot: Slot): string | null {
    const title = this.titleFor(this.pickOf(slot));
    const t = slot.text;
    if (slot.own !== null || t === null || t.kind === null || t.wordsFor === null || title === null) return null;
    return t.wordsFor !== title ? t.wordsFor : null;
  }

  /** Why "Rewrite words for this title" cannot run now, or null. */
  rewriteBlocked(): string | null {
    if (this.busy() !== null) return `Wait: ${this.busy()!.what.toLowerCase()} is running.`;
    return null;
  }

  async rewrite(slot: Slot): Promise<void> {
    const title = this.titleFor(this.pickOf(slot));
    if (title === null || slot.pickIndex === null) return;
    this.failure.set(null);
    const at = slot.pickIndex;
    const ok = await this.act(`Writing the words for “${title}”`, () => this.electron.thumbnailsPairTitle(this.data.jobId, this.data.itemId, slot.n, title));
    if (!ok) return;
    // Thumbnail n now carries the new words for its title (drawn with the photo it had).
    const pair = this.pairs().find((p) => p.pair === slot.n);
    const option = pair === undefined ? undefined : this.options().find((o) => o.pair === slot.n && o.phrase === pair.default.phrase);
    if (option !== undefined) {
      const texts = [...this.texts()];
      texts[at] = option;
      this.texts.set(texts);
    }
    this.changed();
  }

  async useOwn(slot: Slot): Promise<void> {
    this.failure.set(null);
    const file = await this.runner.run('Choosing your image', () => this.electron.thumbnailsChooseOwn());
    if (file === null) return;
    this.own.set({ ...this.own(), [slot.n]: file });
    this.changed();
  }

  clearOwn(slot: Slot): void {
    const own = { ...this.own() };
    delete own[slot.n];
    this.own.set(own);
    this.changed();
  }

  /** Start from the words the metadata run chose for its three titles (the frames and photos are Owen's to pick). */
  suggested(): void {
    try {
      this.texts.set(suggestedTexts(this.pairs()));
    } catch (err) {
      this.failure.set(failureLine('Taking the suggested words', err));
      return;
    }
    this.changed();
  }

  clearAll(): void {
    this.frames.set([]);
    this.texts.set([]);
    this.photos.set([]);
    this.own.set({});
    this.changed();
  }

  // ── a video whose frames and text are not ready ───────────────────────────

  /** Prepares what is missing (frames on the CPU, the words on the 27B); on opening, and on Try again. */
  async prepare(): Promise<void> {
    this.failure.set(null);
    const ok = await this.act('Preparing the frames and text', () => this.electron.thumbnailsFinish(this.data.jobId, this.data.itemId));
    if (ok) this.changed();
  }

  /** Reads the view again (a Crucible server may be there now) and prepares if it can. */
  async tryAgain(): Promise<void> {
    this.failure.set(null);
    const view = await this.runner.run('Reading the thumbnails', () => this.electron.thumbnailsItem(this.data.jobId, this.data.itemId));
    if (view === null) return;
    this.view.set(view);
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
    if (files.length > MAX_PICKS) {
      this.notice.set(`Pick 1 to 3 screenshots; ${files.length} were chosen.`);
      return;
    }
    this.shots.set(files);
  }

  async makeFromShots(): Promise<void> {
    const files = this.shots();
    const titles = this.shotTitles();
    if (files.length === 0) return;
    this.failure.set(null);
    const what = `Making ${files.length} thumbnail${files.length === 1 ? '' : 's'} from your screenshots`;
    const ok = await this.act(what, () => this.electron.thumbnailsScreenshots(this.data.jobId, this.data.itemId, files, titles));
    if (!ok) return;
    this.shots.set([]);
    // Each screenshot is its own pair's frame (screenshot n, thumbnail n), with the words the run chose.
    const pairs = [...this.pairs()].sort((a, b) => a.pair - b.pair).slice(0, MAX_PICKS);
    this.frames.set(pairs.flatMap((p) => (p.default.frameId === null ? [] : [p.default.frameId])));
    this.photos.set([]);
    this.own.set({});
    this.suggested();
  }

  // ── elsewhere ─────────────────────────────────────────────────────────────

  openLook(): void {
    const ref = this.dialog.open(ThumbnailLookDialog, { width: '760px', maxHeight: '90vh', autoFocus: false });
    // Photos, the logo or the border may have been added: read the thumbnails again.
    ref.afterClosed().subscribe(async () => {
      if (await this.act('Reading the thumbnails', () => this.electron.thumbnailsItem(this.data.jobId, this.data.itemId))) this.changed();
    });
  }

  async showFolder(folder: string): Promise<void> {
    await this.runner.run('Opening the folder', () => this.electron.thumbnailsShowFolder(folder));
  }

  fileName(file: string): string {
    return file.split('/').pop() ?? file;
  }
}
