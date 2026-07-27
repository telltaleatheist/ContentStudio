/**
 * Publish State
 *
 * Owns the operator's title/description/tag selection for the item currently open in
 * the reports page, and persists it through the publish-* IPC channels.
 *
 * Lives in features/publish/ (not inside metadata-reports) on purpose: it is the single
 * seam between the existing generator UI and the publish feature, so the whole feature
 * can be lifted into another Angular host with one wiring change.
 *
 * Selection semantics: clicking a title APPENDS it, so click order becomes variant
 * order. That matters — variant 1 is what YouTube falls back to when a test comes back
 * inconclusive, so the operator is choosing a default, not just a set.
 */

import { Injectable, computed, inject, signal } from '@angular/core';
import { ElectronService } from '../../services/electron';
import { ChosenMetadata, MAX_AB_VARIANTS, MAX_TITLE_LENGTH, ResolvedMetadata } from './publish.types';

@Injectable({ providedIn: 'root' })
export class PublishState {
  private electron = inject(ElectronService);

  private readonly _selection = signal<ChosenMetadata | null>(null);
  /**
   * The item as the extension will actually fill it: overrides applied, description
   * composed (chapters at the top, hashtags before the links), tags normalized.
   *
   * Read from the main process rather than composed here on purpose. This used to be two
   * implementations — the reports page composed one description for display while the
   * extension filled the raw one — so the app showed something YouTube never got. There
   * is now a single composer (electron/services/metadata/description-composer.ts) and this
   * is its output.
   */
  private readonly _resolved = signal<ResolvedMetadata | null>(null);
  private readonly _jobId = signal<string | null>(null);
  private readonly _itemIndex = signal<number | null>(null);
  private readonly _saving = signal(false);
  private readonly _error = signal<string | null>(null);

  readonly selection = this._selection.asReadonly();
  readonly resolved = this._resolved.asReadonly();
  readonly saving = this._saving.asReadonly();
  readonly error = this._error.asReadonly();

  /** Ordered chosen titles; empty when nothing is selected. */
  readonly chosenTitles = computed(() => this._selection()?.chosenTitles ?? []);

  readonly chosenCount = computed(() => this.chosenTitles().length);

  readonly isFull = computed(() => this.chosenCount() >= MAX_AB_VARIANTS);

  /** True once at least one title is picked, i.e. the item is fillable. */
  readonly isReady = computed(() => this.chosenCount() > 0);

  /** The operator's description edit, or null when they haven't made one. */
  readonly descriptionOverride = computed(() => this._selection()?.descriptionOverride ?? null);

  /** The operator's tags edit, or null when they haven't made one. */
  readonly tagsOverride = computed(() => this._selection()?.tagsOverride ?? null);

  /** Exactly what the extension will type into Studio's description box. */
  readonly resolvedDescription = computed(() => this._resolved()?.description ?? '');

  /** Exactly what the extension will type into Studio's tags box. */
  readonly resolvedTags = computed(() => this._resolved()?.tags ?? '');

  /** False until the resolved values have loaded, so the UI can avoid showing a blank. */
  readonly hasResolved = computed(() => this._resolved() !== null);

  /**
   * True when this state is pointed at an item. Every mutating method requires it, so the
   * UI can disable controls rather than let a click do nothing.
   */
  readonly hasTarget = computed(() => this._jobId() !== null && this._itemIndex() !== null);

  /**
   * Guard for every mutation.
   *
   * Returns the target or records an error. Previously these methods returned silently
   * when no item was loaded, which is indistinguishable from a successful save: clicking
   * a title did nothing, showed nothing, and saved nothing. A no-op that looks like
   * success is a bug, so it now says so.
   */
  private target(action: string): { jobId: string; itemIndex: number } | null {
    const jobId = this._jobId();
    const itemIndex = this._itemIndex();
    if (!jobId || itemIndex === null) {
      this._error.set(`Cannot ${action}: no report is loaded. Reopen the report and try again.`);
      return null;
    }
    return { jobId, itemIndex };
  }

  /**
   * Point the state at a report item. Safe to call repeatedly; clears any stale
   * selection first so the UI never briefly shows the previous item's picks.
   */
  async load(jobId: string | null | undefined, itemIndex: number | null | undefined): Promise<void> {
    this._error.set(null);

    if (!jobId || itemIndex === null || itemIndex === undefined) {
      this._jobId.set(null);
      this._itemIndex.set(null);
      this._selection.set(null);
      this._resolved.set(null);
      return;
    }

    this._jobId.set(jobId);
    this._itemIndex.set(itemIndex);
    this._selection.set(null);
    this._resolved.set(null);

    const [selections, resolved] = await Promise.all([
      this.electron.publishGetSelections(jobId),
      this.electron.publishGetResolved(jobId, itemIndex),
    ]);

    // Ignore responses that arrived after the operator moved to another item.
    if (this._jobId() !== jobId || this._itemIndex() !== itemIndex) return;

    if (!selections.success) {
      this._error.set(selections.error ?? 'Failed to load selections');
      return;
    }
    this._selection.set(selections.data?.[itemIndex] ?? null);

    // A failure here means the description and tags on screen would be blank, which reads
    // as "this item has none". Say what happened instead.
    if (!resolved.success || !resolved.data) {
      this._error.set(
        resolved.error ?? 'Could not read the description and tags for this item.'
      );
      return;
    }
    this._resolved.set(resolved.data);
  }

  /**
   * Re-read the resolved values after a write.
   *
   * Overrides are applied in the main process, so the composed description/tags on screen
   * are only correct once they come back from there.
   */
  private async refreshResolved(): Promise<void> {
    const jobId = this._jobId();
    const itemIndex = this._itemIndex();
    if (!jobId || itemIndex === null) return;

    const res = await this.electron.publishGetResolved(jobId, itemIndex);
    if (this._jobId() !== jobId || this._itemIndex() !== itemIndex) return;
    if (!res.success || !res.data) {
      this._error.set(res.error ?? 'Saved, but could not re-read the item.');
      return;
    }
    this._resolved.set(res.data);
  }

  /** 1-based variant position for a title, or null when it isn't chosen. */
  variantNumber(title: string): number | null {
    const idx = this.chosenTitles().indexOf(title);
    return idx === -1 ? null : idx + 1;
  }

  isChosen(title: string): boolean {
    return this.chosenTitles().includes(title);
  }

  /** True when picking this title would exceed the 3-variant cap. */
  isBlocked(title: string): boolean {
    return !this.isChosen(title) && this.isFull();
  }

  /**
   * Add or remove a title. Adding appends (preserving click order as variant order);
   * removing closes the gap so variants stay 1..n with no holes.
   */
  async toggleTitle(title: string): Promise<void> {
    const t = this.target('pick a title');
    if (!t) return;

    const current = this.chosenTitles();
    const idx = current.indexOf(title);

    let next: string[];
    if (idx === -1) {
      if (current.length >= MAX_AB_VARIANTS) {
        this._error.set(`You can test at most ${MAX_AB_VARIANTS} titles. Deselect one first.`);
        return;
      }
      if (title.trim().length > MAX_TITLE_LENGTH) {
        this._error.set(`That title is ${title.trim().length} characters; YouTube's limit is ${MAX_TITLE_LENGTH}.`);
        return;
      }
      next = [...current, title];
    } else {
      next = current.filter((_, i) => i !== idx);
    }

    await this.persistTitles(t.jobId, t.itemIndex, next);
  }

  /**
   * Save an inline title edit.
   *
   * Handles both rows the operator can edit:
   *   - an already-CHOSEN title  -> replaced in place, keeping its variant position
   *   - a not-yet-chosen title   -> picked, using the edited text
   *
   * The second case exists because a generated title longer than YouTube's limit cannot
   * be picked at all, so if editing only worked on chosen titles that one would be
   * permanently unusable. Editing it is exactly how you'd fix it.
   *
   * The generated set in the job's report is never touched — it stays pristine so an item
   * can be regenerated. The edit lives in the chosen-title set only.
   */
  async saveTitleEdit(originalTitle: string, editedTitle: string): Promise<void> {
    const t = this.target('edit a title');
    if (!t) return;

    const current = this.chosenTitles();
    const index = current.indexOf(originalTitle);
    const wasChosen = index !== -1;

    const trimmed = editedTitle.trim();

    // Opening the editor and closing it unchanged must not pick anything. Nothing changed,
    // so nothing changes.
    if (trimmed === originalTitle.trim() && !wasChosen) return;

    if (!trimmed) {
      this._error.set('A title cannot be empty.');
      return;
    }
    if (trimmed.length > MAX_TITLE_LENGTH) {
      this._error.set(`That title is ${trimmed.length} characters; YouTube's limit is ${MAX_TITLE_LENGTH}.`);
      return;
    }

    const duplicateAt = current.indexOf(trimmed);
    if (duplicateAt !== -1 && duplicateAt !== index) {
      this._error.set('That title is already one of the variants.');
      return;
    }

    if (wasChosen) {
      await this.persistTitles(
        t.jobId,
        t.itemIndex,
        current.map((title, i) => (i === index ? trimmed : title))
      );
      return;
    }

    if (current.length >= MAX_AB_VARIANTS) {
      this._error.set(`You can test at most ${MAX_AB_VARIANTS} titles. Deselect one first.`);
      return;
    }
    await this.persistTitles(t.jobId, t.itemIndex, [...current, trimmed]);
  }

  private async persistTitles(jobId: string, itemIndex: number, titles: string[]): Promise<void> {
    this._saving.set(true);
    this._error.set(null);
    try {
      const res = await this.electron.publishSetTitles(jobId, itemIndex, titles);
      if (!res.success || !res.data) {
        this._error.set(res.error ?? 'Failed to save titles');
        return;
      }
      this._selection.set(res.data);
    } finally {
      this._saving.set(false);
    }
  }

  /**
   * Persist a description/tags edit. Pass null to clear the override and fall back to
   * the generated value.
   */
  async setFields(fields: {
    descriptionOverride?: string | null;
    tagsOverride?: string | null;
    channelId?: string | null;
  }): Promise<void> {
    const t = this.target('save that change');
    if (!t) return;

    this._saving.set(true);
    this._error.set(null);
    try {
      const res = await this.electron.publishSetFields(t.jobId, t.itemIndex, fields);
      if (!res.success || !res.data) {
        this._error.set(res.error ?? 'Failed to save changes');
        return;
      }
      this._selection.set(res.data);
      // Description/tags just changed — the composed values have to be re-read.
      await this.refreshResolved();
    } finally {
      this._saving.set(false);
    }
  }

  /** Drop every pick for the current item. */
  async clear(): Promise<void> {
    const t = this.target('clear the selection');
    if (!t) return;

    this._saving.set(true);
    try {
      const res = await this.electron.publishClear(t.jobId, t.itemIndex);
      if (!res.success) {
        this._error.set(res.error ?? 'Failed to clear selection');
        return;
      }
      this._selection.set(null);
      // Clearing drops any description/tag overrides too, so the generated values are
      // what's live again.
      await this.refreshResolved();
    } finally {
      this._saving.set(false);
    }
  }

  dismissError(): void {
    this._error.set(null);
  }
}
