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
  clockOf,
  photoOf,
  pickRequests,
  planSlots,
  rankingFor,
  samePicks,
  selectionFromPicks,
  textOptions,
  togglePick,
  typedText,
  wantedChange,
  type PhotoChoice,
  type Slot,
  type TextOption,
} from './thumbnails-compose';
import type { PickRequest, PickView, Ranked, StoredFrame, StoredPair, ThumbnailsView } from './thumbnails.types';

export interface ThumbnailsWindowData {
  jobId: string;
  itemId: string;
}

/** One photo button of a thumbnail's row: the ranking's order, then the library's unranked photos. */
interface PhotoRow {
  name: string;
  p: number | null;
  preview: string | null;
  ranked: boolean;
}

/**
 * THE THUMBNAILS WINDOW, rebuilt as one top-to-bottom flow (2026-09-29). Owen tried the phase-2
 * window and "nothing is doing anything at all ... the images it gathered from the original section
 * should be at the top. i pick three. the text it generated. i pick three. it overlays them."
 *
 *   1. FRAMES from the story's section (two per scene, More per scene): up to three, in click order.
 *   2. TEXT the model wrote, every option in one list labelled with its title and kind, plus typed
 *      words and No text: up to three, in click order.
 *   3. PHOTOS (optional): per thumbnail, ranked with their percentages; left alone, drawn from the
 *      top 3 of the ranking made for those words.
 *   4. RESULT: thumbnail n = frame n + text n + photo n + logo, drawn on the CPU as soon as both are
 *      picked, large and phone-size. SAVED AS HE GOES: the drawn thumbnails are the ordered picks
 *      (pick 1 is the video's thumbnail through the publish record's one door; with an A/B test pick
 *      n goes with title n). His own image can take any place; "Rewrite words for this title" when a
 *      thumbnail's words were written for another title than the one it goes with.
 *
 * A report whose thumbnail stages stopped says where and why, with "Finish making thumbnails"
 * (only the missing stages) and "Make thumbnails again from scratch". Every action runs through ONE
 * runner (thumbnails-compose.ts ActionRunner): a spinner and a running clock while it runs, and any
 * failure as a banner naming what failed. Picking rules: thumbnails-compose.ts.
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
  readonly photos = signal<Record<number, PhotoChoice>>({});
  readonly own = signal<Record<number, string>>({});
  readonly logo = signal(true);
  readonly typed = signal('');
  /** The thumbnail being drawn now, for its card. */
  readonly drawing = signal<number | null>(null);

  readonly more = signal<Record<string, string>>({});
  readonly moreOpen = signal<ReadonlySet<number>>(new Set());
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
  private syncing = false;
  private again = false;
  /** Bumped on every change Owen makes to his picks: a draw that raced a click is not called wrong. */
  private version = 0;
  /** Pick 1's source file when the publish record was last set from it. */
  private publishedFrom: string | null = null;

  readonly record = computed(() => this.view()?.record ?? null);
  readonly pairs = computed<StoredPair[]>(() => this.record()?.pairs ?? []);
  readonly options = computed(() => textOptions(this.pairs()));
  readonly slots = computed<Slot[]>(() => planSlots({ pairs: this.pairs(), frames: this.frames(), texts: this.texts(), photos: this.photos(), own: this.own() }));
  readonly elapsed = computed(() => {
    const b = this.busy();
    return b === null ? '' : clockOf(this.now() - b.since);
  });
  /** The report's chosen titles (pick n goes with title n), when the publish record open is this item's. */
  readonly chosenTitles = computed(() => (this.publish.itemId() === this.data.itemId ? this.publish.chosenTitles() : []));

  /** Why the thumbnails cannot be drawn now, or null when they can. */
  readonly drawBlocked = computed<string | null>(() => {
    const v = this.view();
    if (v === null) return 'The thumbnails are not read yet.';
    const r = v.record;
    if (r === null) return 'This report was made before thumbnails were made with the metadata. Use the Thumbnail row\'s Choose… for your own image, or “Use my own image…” below.';
    if (r.state === 'off') return r.line;
    if (r.state === 'failed') return `The thumbnails stopped at the ${r.failure?.stage ?? 'unknown'} stage, so they cannot be drawn yet. Press “Finish making thumbnails” above.`;
    if (r.state === 'no-story') return 'This report has no story to take frames from. Make thumbnails from your screenshots below.';
    return null;
  });

  /** Too few reaction photos to rank: said at the top whenever the report can use photos. */
  readonly libraryShort = computed<string | null>(() => {
    const v = this.view();
    if (v === null || v.record === null || v.record.state === 'off') return null;
    const n = v.photos.length;
    if (n >= 2) return null;
    return `${n === 0 ? 'No reaction photos are' : 'Only one reaction photo is'} in the library, and ranking photos needs at least two. Add them in Thumbnail look.`;
  });

  readonly canPickFrames = computed(() => (this.record()?.bestScenes.length ?? 0) > 0);

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
    void this.sync();
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
    const sel = selectionFromPicks(view.picks, pairs);
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

  /** A change Owen made to his picks: count it, clear old lines, draw and save. */
  private changed(): void {
    this.version++;
    this.notice.set(null);
    void this.sync();
  }

  /**
   * DRAW, THEN SAVE, one at a time: every thumbnail whose picks changed is drawn (pair n takes frame
   * n, text n, photo n, the logo), then the picks are saved when they differ from the saved ones. A
   * click while this runs makes it go round again. A failure stops it with its banner.
   */
  private async sync(): Promise<void> {
    if (this.syncing) {
      this.again = true;
      return;
    }
    this.syncing = true;
    try {
      do {
        this.again = false;
        const record = this.record();
        if (record === null || record.state === 'off') return;
        if (this.drawBlocked() === null) {
          for (const slot of this.slots()) {
            const change = wantedChange(slot, this.pairs(), this.logo());
            if (change === null) continue;
            const asked = this.version;
            this.drawing.set(slot.n);
            const ok = await this.act(`Drawing thumbnail ${slot.n}`, () => this.electron.thumbnailsRenderPair(this.data.jobId, this.data.itemId, change));
            this.drawing.set(null);
            if (!ok) return;
            if (this.version !== asked) {
              this.again = true;
              break;
            }
            const now = this.slots().find((s) => s.n === slot.n)!;
            if (wantedChange(now, this.pairs(), this.logo()) !== null) {
              this.failure.set(`Thumbnail ${slot.n} was drawn, and it still does not show what was picked. Close the window and open it again; if it happens again, the record and the picks disagree.`);
              return;
            }
          }
          if (this.again) continue;
        }
        const requests: PickRequest[] | null = this.drawBlocked() === null
          ? pickRequests(this.slots(), this.pairs(), this.logo())
          : this.slots().flatMap((s) => (s.own === null ? [] : [{ kind: 'own' as const, file: s.own }]));
        if (requests === null) continue;
        if (!samePicks(requests, this.view()?.picks ?? [])) {
          const ok = await this.act('Saving your picks', () => this.electron.thumbnailsSavePicks(this.data.jobId, this.data.itemId, requests));
          if (!ok) return;
        }
      } while (this.again);
    } finally {
      this.syncing = false;
      this.drawing.set(null);
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
    return `${f.clock} · ${f.score === null ? 'not scored' : `score ${Math.round(f.score * 100)}`}`;
  }

  framePicture(id: string): string | null {
    return this.view()?.frames[id] ?? this.more()[id] ?? null;
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
      const got = await this.runner.run(`Loading more frames of ${this.sceneLabel(scene)}`, () => this.electron.thumbnailsFrames(this.data.jobId, this.data.itemId, missing));
      if (got === null) return;
      this.more.set({ ...this.more(), ...got });
    }
    open.add(scene);
    this.moreOpen.set(open);
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

  /** The thumbnails a photo can be chosen for: every place that is not Owen's own image and has a pair. */
  readonly photoSlots = computed(() => this.slots().filter((s) => s.own === null && this.pairs().some((p) => p.pair === s.n)));

  photoRow(slot: Slot): PhotoRow[] {
    const library = this.view()?.photos ?? [];
    const ranking: Ranked[] = rankingFor(slot, this.pairs());
    const preview = (name: string) => library.find((p) => p.name === name)?.preview ?? null;
    const rows: PhotoRow[] = ranking.map((r) => ({ name: r.name, p: r.p, preview: preview(r.name), ranked: true }));
    for (const p of library) if (!rows.some((r) => r.name === p.name)) rows.push({ name: p.name, p: null, preview: p.preview, ranked: false });
    return rows;
  }

  rankedForLine(slot: Slot): string {
    const pair = this.pairs().find((p) => p.pair === slot.rankingPair);
    if (pair === undefined || pair.photos.length === 0) return 'The photos were never ranked for these words; pick one, or leave No photo.';
    const words = pair.rankedFor === undefined ? pair.default.phrase : pair.rankedFor;
    return `Ranked for “${words ?? 'no text'}”${slot.text?.phrase !== words ? ' (the closest ranking to these words)' : ''}. Left alone, one of the top 3 is drawn.`;
  }

  setPhoto(n: number, choice: PhotoChoice): void {
    const cur = photoOf(this.photos(), n);
    // Clicking the chosen photo again goes back to the draw.
    const next = cur === choice && choice !== 'auto' && choice !== null ? 'auto' : choice;
    this.photos.set({ ...this.photos(), [n]: next });
    this.changed();
  }

  photoChoice(n: number): PhotoChoice {
    return photoOf(this.photos(), n);
  }

  /** The photo thumbnail n shows now (drawn or chosen), for its card. */
  shownPhoto(n: number): string | null {
    return this.pairs().find((p) => p.pair === n)?.default.photo ?? null;
  }

  setLogo(on: boolean): void {
    this.logo.set(on);
    this.changed();
  }

  // ── 4. result ─────────────────────────────────────────────────────────────

  /** The saved pick this place is (1-based), or null while it is not saved. */
  pickOf(slot: Slot): PickView | null {
    const picks = this.view()?.picks ?? [];
    return picks.find((p) => (slot.own !== null ? p.pick.kind === 'own' && p.pick.file === slot.own : p.pick.kind === 'made' && p.pick.pair === slot.n)) ?? null;
  }

  /** The drawn picture of place n: current when it shows what is picked. */
  resultPicture(slot: Slot): { src: string; current: boolean } | null {
    if (slot.own !== null) {
      const pv = this.pickOf(slot);
      return pv !== null && pv.picture !== '' ? { src: pv.picture, current: true } : null;
    }
    if (slot.missing !== null || this.drawBlocked() !== null) return null;
    const pair = this.pairs().find((p) => p.pair === slot.n);
    if (pair === undefined || !pair.default.render.ok) return null;
    const src = this.view()?.renders[pair.default.render.file];
    if (src === undefined) return null;
    return { src, current: wantedChange(slot, this.pairs(), this.logo()) === null };
  }

  renderNotes(slot: Slot): string[] {
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
    return this.libraryShort();
  }

  async rewrite(slot: Slot): Promise<void> {
    const title = this.titleFor(this.pickOf(slot));
    if (title === null || slot.pickIndex === null) return;
    this.failure.set(null);
    const at = slot.pickIndex;
    const ok = await this.act(`Writing the words for “${title}”`, () => this.electron.thumbnailsPairTitle(this.data.jobId, this.data.itemId, slot.n, title));
    if (!ok) return;
    // Thumbnail n now carries the new words for its title, and the photo drawn for them.
    const pair = this.pairs().find((p) => p.pair === slot.n);
    const option = pair === undefined ? undefined : this.options().find((o) => o.pair === slot.n && o.phrase === pair.default.phrase);
    if (option !== undefined) {
      const texts = [...this.texts()];
      texts[at] = option;
      this.texts.set(texts);
      this.photos.set({ ...this.photos(), [slot.n]: 'auto' });
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

  /** Start from the three the metadata run made: their frames, words and photos. */
  suggested(): void {
    const pairs = [...this.pairs()].sort((a, b) => a.pair - b.pair).slice(0, MAX_PICKS);
    const sel = selectionFromPicks(pairs.map((p, i) => ({ n: i + 1, pick: { kind: 'made' as const, pair: p.pair, file: '', wordsFor: p.title }, copy: '', picture: '' })), this.pairs());
    this.frames.set(sel.frames);
    this.texts.set(sel.texts);
    this.photos.set(sel.photos);
    this.own.set({});
    this.changed();
  }

  clearAll(): void {
    this.frames.set([]);
    this.texts.set([]);
    this.photos.set({});
    this.own.set({});
    this.changed();
  }

  // ── a report whose thumbnail stages stopped ───────────────────────────────

  async finish(): Promise<void> {
    this.failure.set(null);
    const ok = await this.act('Finishing the thumbnails', () => this.electron.thumbnailsFinish(this.data.jobId, this.data.itemId));
    if (ok) this.changed();
  }

  async remake(): Promise<void> {
    if (!window.confirm('Make the thumbnails again from scratch? The story is found again, the frames sampled and scored, the words written and the photos ranked (several minutes on the Crucible card). Your own images stay picked.')) return;
    this.failure.set(null);
    const ok = await this.act('Making the thumbnails again', () => this.electron.thumbnailsRemake(this.data.jobId, this.data.itemId));
    if (!ok) return;
    const view = this.view();
    if (view !== null) this.readSelection(view);
    this.changed();
  }

  stageList(stages: readonly string[]): string {
    return stages.join(', ');
  }

  // ── no story: screenshots ─────────────────────────────────────────────────

  readonly canScreenshots = computed(() => {
    const r = this.record();
    return r !== null && (r.state === 'no-story' || r.state === 'failed' || (r.state === 'made' && r.source?.video === null));
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
    this.suggested();
  }

  // ── elsewhere ─────────────────────────────────────────────────────────────

  openLook(): void {
    const ref = this.dialog.open(ThumbnailLookDialog, { width: '760px', maxHeight: '90vh', autoFocus: false });
    // Photos or the logo may have been added: read the thumbnails again.
    ref.afterClosed().subscribe(async () => {
      if (await this.act('Reading the thumbnails', () => this.electron.thumbnailsItem(this.data.jobId, this.data.itemId))) this.changed();
    });
  }

  async showFolder(folder: string): Promise<void> {
    await this.runner.run('Opening the folder', () => this.electron.thumbnailsShowFolder(folder));
  }

  percent(p: number | null): string {
    return p === null ? 'not ranked' : `${Math.round(p * 100)}%`;
  }

  fileName(file: string): string {
    return file.split('/').pop() ?? file;
  }
}
