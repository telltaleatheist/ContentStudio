import { Component, OnDestroy, OnInit, computed, effect, signal, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';

import { ElectronService } from '../../services/electron';
import type {
  ThumbsFrame,
  ThumbsItem,
  ThumbsLogo,
  ThumbsLogoState,
  ThumbsPhotoDraw,
  ThumbsPhotoPick,
  ThumbsPhotos,
  ThumbsPiece,
  ThumbsRanked,
  ThumbsRenderResult,
  ThumbsRun,
  ThumbsStoryChoice,
  ThumbsStoryState,
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
/** How many frames a collapsed scene row of "All kept frames" shows (spread across the scene). */
const COLLAPSED_ROW = 6;

function pickKey(p: ThumbsWordPick): string {
  return p.phrase === null ? 'none' : `${p.kind}|${p.phrase}`;
}

/**
 * THE THUMBNAILS TAB (testing, 2026-09-28). One page, top to bottom: pick a report (its frames come
 * from the screen recording of the editor story it is linked to; an unlinked report picks its story
 * here, and the choice is saved as its link), find frames,
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
  /** The report's story link and the picker's stories (never matched by name: Owen picks). */
  readonly story = signal<ThumbsStoryState | null>(null);
  /** Stories of project folders chosen with "Other project folder…", added to the picker. */
  readonly extraChoices = signal<ThumbsStoryChoice[]>([]);
  readonly pickSession = signal<string>('');
  readonly pickStory = signal<string>('');
  readonly changingLink = signal(false);

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

  readonly photos = signal<ThumbsPhotos>({ folder: '', photos: [], offer: null });
  /** What the last "Add photos…" did, in one line. */
  readonly photoNote = signal<string | null>(null);
  /** Scenes opened with "More from this scene" (best view) or "Show all" (all view). */
  readonly openScenes = signal<ReadonlySet<number>>(new Set());
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
  /** Outline the photo and logo spaces that were left empty on a render. Off unless Owen ticks it. */
  readonly showSlots = signal(false);

  /** Owen's logo (kept in the app), or null when none is. */
  readonly logo = signal<ThumbsLogo | null>(null);
  /** While the app holds no logo: the old setting's file, offered for copying. */
  readonly logoOffer = signal<{ from: string } | null>(null);
  /** The photo draw's seed Owen typed (blank: a new one each time), and the last one used. */
  readonly seedText = signal('');
  readonly lastSeed = signal<number | null>(null);
  /** The last render's draws, with the words each was drawn for (a draw for other words is not shown). */
  readonly draws = signal<Record<string, { draw: ThumbsPhotoDraw; text: string | null }>>({});
  /** The per-render logo switch: on whenever a logo is set, until Owen switches it off. */
  readonly logoOn = signal(false);

  private unsubscribe: (() => void) | null = null;

  readonly item = computed(() => this.items().find((i) => `${i.jobId}/${i.itemId}` === this.itemKey()) ?? null);
  /** Every story the picker can offer: the report's week, plus any project folder chosen. */
  readonly allChoices = computed<ThumbsStoryChoice[]>(() => [...(this.story()?.choices ?? []), ...this.extraChoices()]);
  readonly sessions = computed<Array<{ projectFolder: string; session: string }>>(() => {
    const seen = new Map<string, string>();
    for (const c of this.allChoices()) if (!seen.has(c.projectFolder)) seen.set(c.projectFolder, c.session);
    return [...seen].map(([projectFolder, session]) => ({ projectFolder, session }));
  });
  readonly sessionStories = computed<ThumbsStoryChoice[]>(() => this.allChoices().filter((c) => c.projectFolder === this.pickSession()));
  readonly pickedStory = computed<ThumbsStoryChoice | null>(() => this.sessionStories().find((c) => this.storyKey(c) === this.pickStory()) ?? null);
  readonly framesById = computed(() => new Map((this.run()?.frames ?? []).map((f) => [f.id, f])));
  /** The best view: one row per scene (the best and the best clearly different frame; more on request), scenes ordered by their best frame. */
  readonly bestRows = computed<Array<{ scene: number; label: string; frames: ThumbsFrame[]; more: ThumbsFrame[] }>>(() => {
    const run = this.run();
    if (run === null || run.bestScenes === null) return [];
    const byId = this.framesById();
    const labels = new Map(run.scenes.map((s) => [s.number, s.label]));
    const pick = (ids: string[]) => ids.map((id) => byId.get(id)).filter((f): f is ThumbsFrame => f !== undefined);
    return run.bestScenes.map((row) => ({
      scene: row.scene,
      label: labels.get(row.scene) ?? `Scene ${row.scene}`,
      frames: pick(row.ids),
      more: pick(row.more),
    }));
  });
  /** "All kept frames", one row per scene: every frame, or COLLAPSED_ROW spread across it until opened. */
  readonly allRows = computed<Array<{ scene: number; label: string; frames: ThumbsFrame[]; shown: ThumbsFrame[] }>>(() => {
    const run = this.run();
    if (run === null) return [];
    const open = this.openScenes();
    return run.scenes.map((s) => {
      const frames = run.frames.filter((f) => f.scene === s.number);
      const shown = open.has(s.number) || frames.length <= COLLAPSED_ROW
        ? frames
        : Array.from({ length: COLLAPSED_ROW }, (_, k) => frames[Math.round((k * (frames.length - 1)) / (COLLAPSED_ROW - 1))]);
      return { scene: s.number, label: `${s.label} · ${frames.length} kept`, frames, shown };
    });
  });
  /** Every word line the model wrote, plus "no text", for a variant's text menu. */
  readonly allTexts = computed<ThumbsWordPick[]>(() => {
    const w = this.words();
    const out: ThumbsWordPick[] = [NO_TEXT];
    if (w) for (const k of this.kinds) for (const phrase of w[k]) out.push({ phrase, kind: k });
    for (const f of this.favTexts()) if (!out.some((o) => pickKey(o) === pickKey(f))) out.push(f);
    return out;
  });

  readonly elapsed = signal(0);
  readonly elapsedLabel = computed(() => {
    const s = this.elapsed();
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  });
  private elapsedTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly electron: ElectronService) {
    effect(() => {
      const working = this.busy() !== null;
      untracked(() => {
        if (this.elapsedTimer !== null) clearInterval(this.elapsedTimer);
        this.elapsedTimer = null;
        this.elapsed.set(0);
        if (working) this.elapsedTimer = setInterval(() => this.elapsed.update((n) => n + 1), 1000);
      });
    });
  }

  async ngOnInit(): Promise<void> {
    this.unsubscribe = this.electron.onThumbsProgress((event) => {
      const run = this.run();
      if (event.stage === 'suggesting') this.progress.set('No photo is starred, so first reading the tone and ranking the photos for these words');
      else if (event.stage === 'drawing') this.progress.set(`Drawing thumbnail ${event.done + 1} of ${event.total}`);
      else if (event.stage === 'sampling') this.progress.set(`Sampling frame ${event.done.toLocaleString()} of about ${event.total.toLocaleString()}`);
      else if (event.stage === 'filtering') this.progress.set(`Removing repeated and blurry frames from ${event.total.toLocaleString()}`);
      else if (run === null || run.runId === event.runId) this.progress.set(`Scoring frame ${Math.min(event.done + 1, event.total)} of ${event.total}`);
    });
    await this.attempt(async () => {
      this.items.set(await this.electron.thumbsListItems());
      const first = this.items().find((i) => i.problem === null);
      if (first) this.pickItem(`${first.jobId}/${first.itemId}`);
      await this.refreshPhotos();
      const { style, stored } = await this.electron.thumbsGetStyle();
      this.style.set(style);
      this.styleStored.set(stored);
    });
    // Its own attempt: a saved logo file that has gone missing is said by name without hiding the rest.
    await this.attempt(async () => this.setLogo(await this.electron.thumbsLogo()));
  }

  private setLogo(state: ThumbsLogoState): void {
    this.logo.set(state.logo);
    this.logoOffer.set(state.offer);
    this.logoOn.set(state.logo !== null);
  }

  /** Copy a logo file into the app (it replaces the one kept there). */
  async chooseLogo(): Promise<void> {
    await this.attempt(async () => {
      const picked = await this.electron.thumbsChooseLogo();
      if (picked !== null) this.setLogo(picked);
    });
  }

  /** The one click on "Copy it into the app" for the logo the tab used to read in place. */
  async copyOldLogo(): Promise<void> {
    await this.attempt(async () => this.setLogo(await this.electron.thumbsCopyOldLogo()));
  }

  ngOnDestroy(): void {
    this.unsubscribe?.();
    if (this.elapsedTimer !== null) clearInterval(this.elapsedTimer);
    // Leaving the tab gives back the text model it kept loaded between the words and the photos.
    void this.electron.thumbsReleaseModel().catch((err) => console.error('[Thumbnails] releasing the text model:', err));
  }

  isOpen(scene: number): boolean {
    return this.openScenes().has(scene);
  }

  toggleScene(scene: number): void {
    const next = new Set(this.openScenes());
    if (next.has(scene)) next.delete(scene);
    else next.add(scene);
    this.openScenes.set(next);
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
    void this.loadStory();
  }

  storyKey(c: ThumbsStoryChoice): string {
    return `${c.number}|${c.slug}`;
  }

  private async loadStory(): Promise<void> {
    const item = this.item();
    this.story.set(null);
    this.extraChoices.set([]);
    this.changingLink.set(false);
    this.pickSession.set('');
    this.pickStory.set('');
    if (item === null || item.problem !== null) return;
    await this.attempt(async () => {
      const state = await this.electron.thumbsStoryState(item.jobId, item.itemId);
      if (this.item() !== item) return;
      this.story.set(state);
      this.pickSession.set(this.sessions()[0]?.projectFolder ?? '');
    });
  }

  pickSessionFolder(folder: string): void {
    this.pickSession.set(folder);
    this.pickStory.set('');
  }

  async chooseProject(): Promise<void> {
    await this.attempt(async () => {
      const picked = await this.electron.thumbsChooseProject();
      if (picked === null) return;
      const known = new Set(this.allChoices().map((c) => `${c.projectFolder}|${this.storyKey(c)}`));
      this.extraChoices.set([...this.extraChoices(), ...picked.choices.filter((c) => !known.has(`${c.projectFolder}|${this.storyKey(c)}`))]);
      if (picked.choices.length > 0) this.pickSessionFolder(picked.choices[0].projectFolder);
      if (picked.problems.length > 0) this.error.set(picked.problems.join(' '));
    });
  }

  /** Save the picked story as the report's link (the report's publish record, like the Inputs page). */
  async linkPicked(): Promise<void> {
    const item = this.item();
    const choice = this.pickedStory();
    if (item === null || choice === null) return;
    await this.attempt(async () => {
      this.story.set(await this.electron.thumbsLinkStory(item.jobId, item.itemId, choice.projectFolder, choice.number, choice.slug));
      this.changingLink.set(false);
      this.resetRun();
    });
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
    this.openScenes.set(new Set());
    this.draws.set({});
  }

  fileName(p: string | null): string {
    return p === null ? '' : p.split('/').pop() ?? p;
  }

  async findFrames(): Promise<void> {
    const item = this.item();
    if (item === null) return;
    this.busy.set('finding');
    this.progress.set("Building the editor's timeline map for this session — this can take a few minutes, longer while the editor is processing");
    this.resetRun();
    await this.attempt(async () => {
      this.run.set(await this.electron.thumbsFindFrames({
        jobId: item.jobId,
        itemId: item.itemId,
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
    if (r === null) return `${frame.clock}, scene ${frame.scene}: not scored`;
    return `${frame.clock}, scene ${frame.scene}: face ${this.percent(r.pFace)}%, expression ${r.expression.toFixed(1)} of 5, eyes open ${this.percent(r.pEyesOpen)}%, ` +
      `strong thumbnail ${this.percent(r.pStrong)}%, computer screen ${this.percent(r.pScreen)}%`;
  }

  // ── words ─────────────────────────────────────────────────────────────────

  async writeWords(): Promise<void> {
    const run = this.run();
    if (run === null || !this.title()) return;
    this.busy.set('words');
    await this.attempt(async () => {
      this.words.set(await this.electron.thumbsWords(run.runId, this.title()));
      await this.recombine();
    });
    this.busy.set(null);
  }

  // ── photos ────────────────────────────────────────────────────────────────

  private async refreshPhotos(): Promise<void> {
    this.photos.set(await this.electron.thumbsPhotos());
    const names = new Set(this.photos().photos.map((p) => p.name));
    this.favPhotos.set(this.favPhotos().filter((n) => names.has(n)));
  }

  /** After the photo list changed: a ranking made for the old list is not used again. */
  private async photosChanged(): Promise<void> {
    this.suggestion.set(null);
    this.draws.set({});
    await this.refreshPhotos();
    await this.recombine();
  }

  /** "Add photos…": PNG files or folders, copied into the app. Names already there: ask, then replace. */
  async addPhotos(): Promise<void> {
    this.photoNote.set(null);
    await this.attempt(async () => {
      let out = await this.electron.thumbsChoosePhotos();
      if (out === null) return;
      if (out.already.length > 0) {
        const names = out.already.map((n) => `"${n}"`).join(', ');
        if (!window.confirm(`Already in your reaction photos: ${names}. Replace ${out.already.length === 1 ? 'it' : 'them'} with the chosen file${out.already.length === 1 ? '' : 's'}? (Nothing was added yet.)`)) {
          this.photoNote.set(`Nothing added: ${names} ${out.already.length === 1 ? 'is' : 'are'} already there.`);
          return;
        }
        out = await this.electron.thumbsAddPhotos(out.chosen, true);
      }
      this.photoNote.set(`Added ${out.added.length}${out.replaced.length ? `, replaced ${out.replaced.length}` : ''}. They are kept in the app from now on.`);
      await this.photosChanged();
    });
  }

  async removePhoto(name: string, event: Event): Promise<void> {
    event.stopPropagation();
    if (!window.confirm(`Remove "${name}" from your reaction photos? (Only the app's copy; your note for it stays.)`)) return;
    await this.attempt(async () => {
      await this.electron.thumbsRemovePhoto(name);
      this.photoNote.set(`Removed "${name}".`);
      await this.photosChanged();
    });
  }

  /** The one click on "Copy these into the app" for the folder the tab used to read in place. */
  async copyOldPhotos(): Promise<void> {
    await this.attempt(async () => {
      const out = await this.electron.thumbsCopyOldPhotos();
      this.photoNote.set(`Copied ${out.added.length} photos into the app. Your originals were not touched.`);
      await this.photosChanged();
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

  /** A variant's ranking, only when the suggestion ran for exactly its current words. */
  private freshRanking(letter: string): ThumbsRanked[] | null {
    const s = this.suggestion();
    const v = this.variants().find((x) => x.letter === letter);
    if (s === null || v === undefined || !(letter in s.texts) || s.texts[letter] !== v.text.phrase) return null;
    return s.photos[letter] ?? null;
  }

  /** A variant's photo menu: ranked by its suggestion when it is for these words, else the folder's order. */
  photoMenu(letter: string): Array<{ name: string; p: number | null }> {
    return this.freshRanking(letter) ?? this.photos().photos.map((p) => ({ name: p.name, p: null }));
  }

  photoKey(p: ThumbsPhotoPick): string {
    return p.pick === 'photo' ? `photo:${p.name}` : p.pick === 'none' ? 'none:' : `top:${p.of}`;
  }

  swapPhoto(letter: string, key: string): void {
    const colon = key.indexOf(':');
    const kind = key.slice(0, colon);
    const rest = key.slice(colon + 1);
    const pick: ThumbsPhotoPick = kind === 'photo' ? { pick: 'photo', name: rest } : kind === 'none' ? { pick: 'none' } : { pick: 'top', of: rest };
    this.swap(letter, { photo: pick });
  }

  /** The last draw for thumbnail `of`'s words, only when it was drawn for its current words. */
  private freshDraw(of: string): ThumbsPhotoDraw | null {
    const d = this.draws()[of];
    const v = this.variants().find((x) => x.letter === of);
    return d !== undefined && v !== undefined && d.text === v.text.phrase ? d.draw : null;
  }

  /** The "drawn from the top 3" entry's label: the draw once made, else the pool once ranked. */
  topLabel(of: string): string {
    const whose = `Drawn from the top 3 for ${of}'s words`;
    const drawn = this.freshDraw(of);
    if (drawn !== null) return `${whose}: ${drawn.name} — ${this.percent(drawn.p)}%`;
    const pool = this.freshRanking(of)?.slice(0, 3);
    if (pool && pool.length > 0) return `${whose} (${pool.map((r) => `${r.name} ${this.percent(r.p)}%`).join(', ')})`;
    return `${whose} (ranked and drawn when you make the thumbnails)`;
  }

  photoPreview(p: ThumbsPhotoPick): string | null {
    const name = p.pick === 'photo' ? p.name : p.pick === 'top' ? this.freshDraw(p.of)?.name ?? null : null;
    return name === null ? null : this.photos().photos.find((x) => x.name === name)?.preview ?? null;
  }

  /** The seed box: blank for a new draw, or a whole number to repeat one. */
  private seedOrNull(): number | null {
    const t = this.seedText().trim();
    if (t === '') return null;
    if (!/^\d+$/.test(t)) throw new Error(`The draw seed must be a whole number (or blank for a new draw), not "${t}".`);
    return Number(t);
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
  /** How many times "Combine again" was pressed since the favourites last changed: each press rotates every list by one, so the layout actually changes. */
  private turn = 0;

  async combineAgain(): Promise<void> {
    this.turn++;
    await this.recombine(true);
  }

  async recombine(keepTurn = false): Promise<void> {
    if (!keepTurn) this.turn = 0;
    this.results.set(null);
    if (this.favFrames().length === 0) {
      this.variants.set([]);
      this.combineReason.set('Star at least one frame first.');
      return;
    }
    const k = this.turn;
    const rot = <T,>(list: readonly T[]): T[] => (list.length < 2 ? [...list] : [...list.slice(k % list.length), ...list.slice(0, k % list.length)]);
    const s = this.suggestion();
    const rank = s ? Object.fromEntries(Object.entries(s.photos).map(([l, r]) => [l, { text: s.texts[l] ?? null, ranked: r.map((x) => x.name) }])) : null;
    const w = this.words();
    await this.attempt(async () => {
      const out = await this.electron.thumbsCombine(
        { frames: rot(this.favFrames()), texts: rot(this.favTexts()), photos: rot(this.favPhotos()), written: w ? { claim: rot(w.claim), stakes: rot(w.stakes), reaction: rot(w.reaction) } : null },
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
    this.progress.set('Drawing…');
    await this.attempt(async () => {
      const variants = this.variants();
      const out = await this.electron.thumbsRender(run.runId, variants.map((v) => ({
        letter: v.letter, frameId: v.frameId, phrase: v.text.phrase, kind: v.text.kind, photo: v.photo,
      })), { logo: this.logoOn(), seed: this.seedOrNull() });
      if (out.suggestion !== null) this.suggestion.set(out.suggestion);
      const textOf = (letter: string) => variants.find((v) => v.letter === letter)?.text.phrase ?? null;
      this.draws.set(Object.fromEntries(Object.entries(out.draws).map(([of, draw]) => [of, { draw, text: textOf(of) }])));
      this.lastSeed.set(out.seed);
      this.run.set({ ...run, lines: out.lines });
      this.results.set(out.results);
      this.folder.set(out.folder);
    });
    this.busy.set(null);
    this.progress.set(null);
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
