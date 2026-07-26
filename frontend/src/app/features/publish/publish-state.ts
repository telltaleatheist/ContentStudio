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
import { ChosenMetadata, MAX_AB_VARIANTS, MAX_TITLE_LENGTH } from './publish.types';

@Injectable({ providedIn: 'root' })
export class PublishState {
  private electron = inject(ElectronService);

  private readonly _selection = signal<ChosenMetadata | null>(null);
  private readonly _jobId = signal<string | null>(null);
  private readonly _itemIndex = signal<number | null>(null);
  private readonly _saving = signal(false);
  private readonly _error = signal<string | null>(null);

  readonly selection = this._selection.asReadonly();
  readonly saving = this._saving.asReadonly();
  readonly error = this._error.asReadonly();

  /** Ordered chosen titles; empty when nothing is selected. */
  readonly chosenTitles = computed(() => this._selection()?.chosenTitles ?? []);

  readonly chosenCount = computed(() => this.chosenTitles().length);

  readonly isFull = computed(() => this.chosenCount() >= MAX_AB_VARIANTS);

  /** True once at least one title is picked, i.e. the item is fillable. */
  readonly isReady = computed(() => this.chosenCount() > 0);

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
      return;
    }

    this._jobId.set(jobId);
    this._itemIndex.set(itemIndex);
    this._selection.set(null);

    const res = await this.electron.publishGetSelections(jobId);
    if (!res.success) {
      this._error.set(res.error ?? 'Failed to load selections');
      return;
    }

    // Ignore a response that arrived after the operator moved to another item.
    if (this._jobId() !== jobId || this._itemIndex() !== itemIndex) return;

    this._selection.set(res.data?.[itemIndex] ?? null);
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
    const jobId = this._jobId();
    const itemIndex = this._itemIndex();
    if (!jobId || itemIndex === null) return;

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

    await this.persistTitles(jobId, itemIndex, next);
  }

  /** Replace a chosen title in place — used by inline editing, keeps variant order. */
  async replaceTitle(oldTitle: string, newTitle: string): Promise<void> {
    const jobId = this._jobId();
    const itemIndex = this._itemIndex();
    if (!jobId || itemIndex === null) return;

    const trimmed = newTitle.trim();
    if (!trimmed) {
      this._error.set('A title cannot be empty.');
      return;
    }
    if (trimmed.length > MAX_TITLE_LENGTH) {
      this._error.set(`That title is ${trimmed.length} characters; YouTube's limit is ${MAX_TITLE_LENGTH}.`);
      return;
    }

    const next = this.chosenTitles().map((t) => (t === oldTitle ? trimmed : t));
    await this.persistTitles(jobId, itemIndex, next);
  }

  /** Move a chosen title up or down, changing which variant it is. */
  async reorder(title: string, direction: -1 | 1): Promise<void> {
    const jobId = this._jobId();
    const itemIndex = this._itemIndex();
    if (!jobId || itemIndex === null) return;

    const current = [...this.chosenTitles()];
    const from = current.indexOf(title);
    const to = from + direction;
    if (from === -1 || to < 0 || to >= current.length) return;

    [current[from], current[to]] = [current[to], current[from]];
    await this.persistTitles(jobId, itemIndex, current);
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
    const jobId = this._jobId();
    const itemIndex = this._itemIndex();
    if (!jobId || itemIndex === null) return;

    this._saving.set(true);
    this._error.set(null);
    try {
      const res = await this.electron.publishSetFields(jobId, itemIndex, fields);
      if (!res.success || !res.data) {
        this._error.set(res.error ?? 'Failed to save changes');
        return;
      }
      this._selection.set(res.data);
    } finally {
      this._saving.set(false);
    }
  }

  /** Drop every pick for the current item. */
  async clear(): Promise<void> {
    const jobId = this._jobId();
    const itemIndex = this._itemIndex();
    if (!jobId || itemIndex === null) return;

    this._saving.set(true);
    try {
      const res = await this.electron.publishClear(jobId, itemIndex);
      if (!res.success) {
        this._error.set(res.error ?? 'Failed to clear selection');
        return;
      }
      this._selection.set(null);
    } finally {
      this._saving.set(false);
    }
  }

  dismissError(): void {
    this._error.set(null);
  }
}
