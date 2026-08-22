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
import { AnalyticsChannel, ElectronService, PublishFields } from '../../services/electron';
import {
  CarryForwardCandidate,
  CarryReceipt,
  ChannelResolution,
  ChosenMetadata,
  MAX_AB_VARIANTS,
  MAX_TITLE_LENGTH,
  PushReceipt,
  ResolvedMetadata,
  ThumbnailMeta,
  ThumbnailPreview,
  ThumbnailProposal,
} from './publish.types';
import { composePublishAt } from './publish-schedule';

/**
 * How big a preview the main process renders. Wide enough to stay sharp in the panel on
 * a retina display and small enough that the data URL is not the size of the file.
 */
const THUMBNAIL_PREVIEW_MAX_PX = 640;

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
  /**
   * The item currently open, by its permanent id.
   *
   * This used to be a (jobId, itemIndex) pair. The index was not an identity — deleting a
   * sibling item silently re-pointed it at the item below — so the whole publish wire now
   * carries the id alone and the job is a fact the main process reads back off the item.
   */
  private readonly _itemId = signal<string | null>(null);
  private readonly _saving = signal(false);
  private readonly _error = signal<string | null>(null);

  // ------------------------------------------------------- the Publish panel's state
  //
  // Everything below belongs to the panel above Titles: the channel registry it offers,
  // the routing it suggests for an item nobody has routed yet, and the thumbnail it
  // shows. None of it is stored — it is what the panel needs in order to ASK.

  /** Every registered channel, re-read on each load so a newly connected one appears. */
  private readonly _channels = signal<AnalyticsChannel[]>([]);

  /**
   * Whether that list has actually been read yet.
   *
   * An empty list means two different things — "the registry has no channels" and "the
   * registry has not been read" — and one of them is not something to draw a conclusion
   * from. Without this, an item with a stored channel is briefly accused of pointing at
   * an unregistered one every time a report is opened.
   */
  private readonly _channelsLoaded = signal(false);

  /**
   * What the item's prompt set routes to, when the record has no channel of its own.
   *
   * A SUGGESTION, never a stored value: it pre-selects the picker and is written with the
   * operator's next save (see withChannelSeed). Resolving is only ever done for a record
   * whose channelId is null, so a stored choice is never re-routed behind the operator.
   */
  private readonly _channelSuggestion = signal<ChannelResolution | null>(null);

  /**
   * True once the operator has touched the picker themselves.
   *
   * This is what makes an override sticky. Without it, choosing "not routed" on an item
   * that HAS a suggestion would be undone by the next save of any other field, which
   * would silently route a video the operator had just declined to route.
   */
  private readonly _channelTouched = signal(false);

  /** The stored thumbnail, decoded and downscaled by the main process. */
  private readonly _thumbnailPreview = signal<ThumbnailPreview | null>(null);

  /** Non-fatal notes about the stored thumbnail — small, or not 16:9. Shown, not hidden. */
  private readonly _thumbnailWarnings = signal<string[]>([]);

  /** An exported thumbnail found on disk for an item that has none. Never auto-applied. */
  private readonly _proposal = signal<ThumbnailProposal | null>(null);

  /** The proposal's own preview, so Confirm is a decision about an image, not a path. */
  private readonly _proposalPreview = signal<ThumbnailPreview | null>(null);

  /**
   * The earlier run of this same video whose publish state is on offer, or null.
   *
   * Read when the panel opens and ONLY for an item nobody has touched yet (see
   * carryOffer). Nothing about it is stored, and nothing is applied until the operator
   * clicks — ITEM-ID-PLAN §3.2 is explicit that source_key is a hint driving an explicit
   * action, never an implicit join.
   */
  private readonly _carryCandidate = signal<CarryForwardCandidate | null>(null);

  /**
   * The items whose offer has been dismissed in THIS sitting.
   *
   * Deliberately in memory and deliberately not on the record. There is no "declined"
   * field, and inventing one would be a claim the record cannot make — the earlier run
   * still exists and this item still has nothing set. Reopening the app offers again,
   * which is honest, and is exactly how the thumbnail proposal already behaves.
   *
   * Keyed by item id rather than a single flag because the operator moves between
   * reports: dismissing one item's offer must not silence another's.
   */
  private readonly _carryDismissed = signal<ReadonlySet<string>>(new Set<string>());

  /** True while a carry-forward apply is in flight. */
  private readonly _carrying = signal(false);

  /**
   * The receipt from the carry-forward applied in this sitting, or null.
   *
   * Every one of the four fields is in it — applied, skipped or refused — because a
   * partial carry is a legitimate outcome and the operator has to be able to see which
   * part did not happen. Cleared when the panel moves to another item.
   */
  private readonly _carryReceipt = signal<CarryReceipt | null>(null);

  /** True while a push is in flight. Separate from _saving: it is a REMOTE write. */
  private readonly _pushing = signal(false);

  /**
   * The receipt from the push made in this sitting, or null.
   *
   * Deliberately not the same thing as `selection().pushReceipt`, which is the LAST push
   * whenever it happened — possibly last week, possibly by a different sitting. This one
   * says "the thing you just clicked did this", and it is cleared when the panel moves to
   * another item.
   */
  private readonly _receipt = signal<PushReceipt | null>(null);

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

  // The Phase-1 publish fields, read-only for now: the panel that edits them lands with
  // the Publish UI. They are exposed here rather than reached out of `selection()` at
  // the call site so there is one place that knows how a missing selection reads —
  // which is NOT the same as a stored value: no record at all means the operator has
  // never touched this item, and every one of these says so with the field's own
  // never-set value.

  /** The routed channel, or null when the item is not routed yet. */
  readonly channelId = computed(() => this._selection()?.channelId ?? null);

  /** The requested go-live time (ISO with zone), or null for no schedule. */
  readonly publishAt = computed(() => this._selection()?.publishAt ?? null);

  /** When the schedule was last set — what explains a stale publishAt. */
  readonly publishAtSetAt = computed(() => this._selection()?.publishAtSetAt ?? null);

  /** Absolute path of the accepted thumbnail, or null. */
  readonly thumbnailPath = computed(() => this._selection()?.thumbnailPath ?? null);

  /** What that file measured when it was accepted. */
  readonly thumbnailMeta = computed<ThumbnailMeta | null>(
    () => this._selection()?.thumbnailMeta ?? null
  );

  /** Podcast episode rather than a YouTube-first video. False until set otherwise. */
  readonly isPodcast = computed(() => this._selection()?.isPodcast ?? false);

  /**
   * Monetization intent: true, false, or null for "no decision recorded".
   *
   * `?? null` covers the item with NO record at all, which is the same answer — nobody
   * has decided — and NOT `false`. Only null keeps the extension's hands off Studio's
   * monetization control.
   */
  readonly monetize = computed<boolean | null>(() => this._selection()?.monetize ?? null);

  /** Every channel the picker can offer. */
  readonly channels = this._channels.asReadonly();

  /** The stored thumbnail's preview, or null when there is nothing stored to show. */
  readonly thumbnailPreview = this._thumbnailPreview.asReadonly();

  /** Warnings that came back with the stored thumbnail. Empty is the usual answer. */
  readonly thumbnailWarnings = this._thumbnailWarnings.asReadonly();

  /** The exported thumbnail on offer, or null when there is none to offer. */
  readonly proposal = this._proposal.asReadonly();

  /** The offered image itself. Confirm is only shown once this has arrived. */
  readonly proposalPreview = this._proposalPreview.asReadonly();

  /** The video this item is linked to, or null when nothing is linked yet. */
  readonly videoId = computed(() => this._selection()?.videoId ?? null);

  /** ISO of the last push to that video, or null for never. */
  readonly pushedAt = computed(() => this._selection()?.pushedAt ?? null);

  /** What the last push sent, whenever it happened. Null until there has been one. */
  readonly lastPushReceipt = computed<PushReceipt | null>(
    () => this._selection()?.pushReceipt ?? null
  );

  /**
   * Is this item's record still untouched in every way carry-forward cares about?
   *
   * The offer is for a REGENERATED video nobody has set up yet. An item that is already
   * routed, has a thumbnail, is linked to a video, has been pushed, or carries a
   * transcript link this run declared for itself is an item with decisions on it, and
   * putting "carry the old one forward?" in front of those decisions invites undoing
   * them by reflex.
   *
   * Chosen titles are deliberately NOT part of this. They belong to this run's title
   * list, nothing carried touches them, and an operator who has picked titles but not a
   * channel is precisely who the offer is for.
   */
  readonly recordIsFresh = computed(() => {
    const record = this._selection();
    if (!record) return true;  // never touched at all
    return (
      record.channelId === null &&
      record.thumbnailPath === null &&
      record.transcriptRef === null &&
      record.isPodcast === false &&
      record.videoId === null &&
      record.pushedAt === null
    );
  });

  /**
   * The offer to show, or null for "say nothing".
   *
   * Three things have to be true at once: there IS an earlier run carrying state, this
   * item is still fresh, and the operator has not waved it away this sitting. Anything
   * else and the panel shows nothing at all — a permanently visible offer would be
   * clutter on every report the operator has already dealt with.
   */
  readonly carryOffer = computed<CarryForwardCandidate | null>(() => {
    const candidate = this._carryCandidate();
    if (!candidate) return null;
    if (!this.recordIsFresh()) return null;
    const itemId = this._itemId();
    if (itemId && this._carryDismissed().has(itemId)) return null;
    return candidate;
  });

  /** Which of the four fields the offer would actually bring, in the panel's words. */
  readonly carryOfferFields = computed<string[]>(() => {
    const offer = this.carryOffer();
    if (!offer) return [];
    const fields: string[] = [];
    if (offer.state.channelId) fields.push('channel');
    if (offer.state.thumbnailPath) fields.push('thumbnail');
    if (offer.state.isPodcast) fields.push('podcast flag');
    if (offer.state.transcriptRef) fields.push('transcript link');
    return fields;
  });

  /** True while the carry-forward write is in flight. */
  readonly carrying = this._carrying.asReadonly();

  /** The receipt from the carry-forward applied in this sitting, or null. */
  readonly carryReceipt = this._carryReceipt.asReadonly();

  /** True while the push is in flight. */
  readonly pushing = this._pushing.asReadonly();

  /** The receipt from a push made in this sitting. Null until one succeeds here. */
  readonly receipt = this._receipt.asReadonly();

  /** The title a push would put on the video: variant 1, and nothing else. */
  readonly pushTitle = computed(() => this.chosenTitles()[0] ?? null);

  /**
   * Why "Push to YouTube" is unavailable, or null when it is available.
   *
   * A disabled button with no account of itself is a dead end. Each of these is also
   * refused by the main process — this is the same rule said early, not a second one, and
   * it never lets a push through that the main process would reject.
   */
  readonly pushBlockedReason = computed<string | null>(() => {
    if (!this.hasTarget()) return 'No report is open.';
    if (!this.videoId()) {
      return 'This item is not linked to a YouTube video yet. Upload the draft in the ' +
        'browser and link it first — nothing here uploads video.';
    }
    if (!this.channelId()) return 'This item is not routed to a channel yet.';
    if (!this.pushTitle()) return 'No title is chosen. Variant 1 is what goes on the video.';
    return null;
  });

  /**
   * What the picker shows: the stored channel, or the suggestion standing in for it.
   *
   * One value for both cases, because the picker has one selected option. Which of the
   * two it is comes from channelIsSuggested, and the panel says so on screen — a
   * suggestion that looked stored would be a routing decision nobody made.
   */
  readonly selectedChannelId = computed(
    () => this.channelId() ?? this._channelSuggestion()?.channelId ?? null
  );

  /** True when the picker is showing a suggestion that has not been saved yet. */
  readonly channelIsSuggested = computed(
    () => this.channelId() === null && !!this._channelSuggestion()?.channelId
  );

  /**
   * Why the picker reads the way it does: "Prompt set X is mapped to Y", or the reason
   * nothing could be routed. Null once the item has a channel of its own, which needs no
   * explanation.
   */
  readonly channelNote = computed(() => this._channelSuggestion()?.reason ?? null);

  /**
   * A stored channel id that the registry no longer knows.
   *
   * The picker cannot show an option that does not exist, and a blank picker on an item
   * that IS routed reads as "not routed yet" — the opposite of the truth. Named instead.
   */
  readonly unknownStoredChannel = computed(() => {
    if (!this._channelsLoaded()) return null;
    const stored = this.channelId();
    if (!stored) return null;
    return this._channels().some((c) => c.channelId === stored) ? null : stored;
  });

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
  readonly hasTarget = computed(() => this._itemId() !== null);

  /**
   * Record a failure.
   *
   * APPENDS when there is already one, rather than replacing it. Loading the panel makes
   * several independent calls, and keeping only the first (or only the last) failure
   * leaves a half-loaded panel with one plausible explanation for two problems.
   */
  private reportError(message: string): void {
    const existing = this._error();
    this._error.set(existing ? `${existing}\n${message}` : message);
  }

  /**
   * Guard for every mutation.
   *
   * Returns the target or records an error. Previously these methods returned silently
   * when no item was loaded, which is indistinguishable from a successful save: clicking
   * a title did nothing, showed nothing, and saved nothing. A no-op that looks like
   * success is a bug, so it now says so.
   */
  private target(action: string): string | null {
    const itemId = this._itemId();
    if (!itemId) {
      this._error.set(`Cannot ${action}: no report is loaded. Reopen the report and try again.`);
      return null;
    }
    return itemId;
  }

  /**
   * Point the state at a report item. Safe to call repeatedly; clears any stale
   * selection first so the UI never briefly shows the previous item's picks.
   *
   * `promptSet` is the run's prompt set, and it is REQUIRED rather than optional because
   * it is the whole input to channel seeding: an item opened without one cannot be
   * routed, and the panel says that instead of showing an empty picker with no account
   * of why. Pass null only when the report genuinely records none.
   */
  async load(itemId: string | null | undefined, promptSet: string | null | undefined): Promise<void> {
    this._error.set(null);
    this.resetPanel();

    if (!itemId) {
      this._itemId.set(null);
      this._selection.set(null);
      this._resolved.set(null);
      return;
    }

    this._itemId.set(itemId);
    this._selection.set(null);
    this._resolved.set(null);

    const [selection, resolved] = await Promise.all([
      this.electron.publishGetSelection(itemId),
      this.electron.publishGetResolved(itemId),
    ]);

    // Ignore responses that arrived after the operator moved to another item.
    if (this._itemId() !== itemId) return;

    if (!selection.success) {
      this._error.set(selection.error ?? 'Failed to load selections');
      return;
    }
    this._selection.set(selection.data ?? null);

    // A failure here means the description and tags on screen would be blank, which reads
    // as "this item has none". Say what happened instead.
    if (!resolved.success || !resolved.data) {
      this.reportError(
        resolved.error ?? 'Could not read the description and tags for this item.'
      );
    } else {
      this._resolved.set(resolved.data);
    }

    // The panel's own reads. Deliberately AFTER the selection is in place — both of them
    // are decided by what the record already holds — and deliberately not fatal to each
    // other: a channel registry that will not load must not also cost the thumbnail.
    await this.refreshChannels();
    if (this._itemId() !== itemId) return;
    await this.refreshChannelSuggestion(itemId, promptSet ?? null);
    if (this._itemId() !== itemId) return;
    await this.refreshThumbnail(itemId);
    if (this._itemId() !== itemId) return;
    await this.refreshCarryForward(itemId);
  }

  /**
   * Ask whether this video was generated before.
   *
   * Only for a FRESH record. An item that already has a channel, a thumbnail, a link or a
   * push has been dealt with, and the answer would be shown to nobody — asking anyway
   * would walk the whole report index for an offer that carryOffer discards.
   *
   * A failure is REPORTED, not swallowed. "No earlier run" and "we could not look" are
   * different facts, and only one of them means there is nothing to carry.
   */
  private async refreshCarryForward(itemId: string): Promise<void> {
    this._carryCandidate.set(null);
    if (!this.recordIsFresh()) return;

    const res = await this.electron.publishFindCarryForward(itemId);
    if (this._itemId() !== itemId) return;
    if (!res.success) {
      this.reportError(
        res.error ?? 'Could not check whether this video was generated before.'
      );
      return;
    }
    // null is the ordinary answer: most items are the only run over their source.
    this._carryCandidate.set(res.data ?? null);
  }

  /** Everything the panel derives, back to "nothing is open". */
  private resetPanel(): void {
    // The offer and its receipt belong to the item they were about. The DISMISSALS do
    // not: they are keyed by item id and survive moving between reports, which is the
    // whole point of remembering them for the sitting.
    this._carryCandidate.set(null);
    this._carryReceipt.set(null);
    this._channelSuggestion.set(null);
    this._channelTouched.set(false);
    this._thumbnailPreview.set(null);
    this._thumbnailWarnings.set([]);
    this._proposal.set(null);
    this._proposalPreview.set(null);
    // The receipt belongs to the item it was for. Leaving it up while another report is
    // open would credit this item with a push that happened to a different video.
    this._receipt.set(null);
  }

  /**
   * Re-read the channel registry.
   *
   * Not cached, for the reason publish-ipc does not cache it either: connecting a channel
   * or editing its prompt sets has to take effect without a restart, and a stale list
   * would show the operator a picker missing the channel they just added.
   */
  private async refreshChannels(): Promise<void> {
    const res = await this.electron.analyticsListChannels();
    if (!res.success || !res.channels) {
      this.reportError(
        res.error ?? 'Could not read the channel registry, so no channel can be chosen.'
      );
      return;
    }
    this._channels.set(res.channels);
    this._channelsLoaded.set(true);
  }

  /**
   * Seed the channel picker for an item that has never been routed (spec Q6).
   *
   * Three outcomes, all visible:
   *   the item already has a channel -> nothing happens. A stored choice is the answer.
   *   the prompt set routes          -> a pre-selected SUGGESTION, saved with the next save.
   *   it does not (or there is none) -> the picker stays empty WITH THE REASON, which is
   *                                     the whole point of resolveChannelForPromptSet
   *                                     returning one. A contradictory registry (two
   *                                     channels claiming one prompt set) comes back as a
   *                                     failed call and lands in the error banner naming
   *                                     both — it is a config error, not a choice.
   */
  private async refreshChannelSuggestion(itemId: string, promptSet: string | null): Promise<void> {
    if (this._selection()?.channelId) return;

    if (!promptSet || !promptSet.trim()) {
      this._channelSuggestion.set({
        channelId: null,
        name: null,
        reason:
          'This report records no prompt set, so there is nothing to route from. ' +
          'Choose a channel yourself.',
      });
      return;
    }

    const res = await this.electron.publishResolveChannel(promptSet);
    if (this._itemId() !== itemId) return;
    if (!res.success || !res.data) {
      this.reportError(res.error ?? `Could not route prompt set "${promptSet}" to a channel.`);
      return;
    }
    this._channelSuggestion.set(res.data);
  }

  /**
   * Read the thumbnail half of the panel: the stored image, or the one on offer.
   *
   * Exactly one of the two, and in that order — an item with a thumbnail is not offered
   * another one. The proposal is read only when there is nothing stored, and it is never
   * applied here; it is shown with its own preview so Confirm is a decision about an
   * image rather than about a path (spec Q5 — slots are renumbered between export and
   * upload often enough that pre-applying would be wrong routinely and invisibly).
   */
  private async refreshThumbnail(itemId: string): Promise<void> {
    this._thumbnailPreview.set(null);
    this._thumbnailWarnings.set([]);
    this._proposal.set(null);
    this._proposalPreview.set(null);

    if (this.thumbnailPath()) {
      const res = await this.electron.publishReadThumbnail(itemId, THUMBNAIL_PREVIEW_MAX_PX);
      if (this._itemId() !== itemId) return;
      if (!res.success) {
        this.reportError(res.error ?? 'Could not read the stored thumbnail.');
        return;
      }
      if (!res.data) {
        // The record says there is a thumbnail and the reader says there is not. That is
        // a disagreement about the record, not an empty slot.
        this.reportError(
          `The record has thumbnail ${this.thumbnailPath()} but the main process found ` +
          `nothing to preview for this item.`
        );
        return;
      }
      this._thumbnailPreview.set(res.data);
      this._thumbnailWarnings.set(res.data.warnings);
      return;
    }

    const proposal = await this.electron.publishProposeThumbnail(itemId);
    if (this._itemId() !== itemId) return;
    if (!proposal.success) {
      this.reportError(proposal.error ?? 'Could not look for an exported thumbnail.');
      return;
    }
    // No proposal is the ordinary answer — most items have no exported thumbnail.
    if (!proposal.data) return;
    this._proposal.set(proposal.data);

    const preview = await this.electron.publishReadThumbnail(
      itemId,
      THUMBNAIL_PREVIEW_MAX_PX,
      proposal.data.path
    );
    if (this._itemId() !== itemId) return;
    if (!preview.success || !preview.data) {
      this.reportError(
        preview.error ?? `Could not render a preview of ${proposal.data.path}.`
      );
      return;
    }
    this._proposalPreview.set(preview.data);
  }

  /**
   * Re-read the resolved values after a write.
   *
   * Overrides are applied in the main process, so the composed description/tags on screen
   * are only correct once they come back from there.
   */
  private async refreshResolved(): Promise<void> {
    const itemId = this._itemId();
    if (!itemId) return;

    const res = await this.electron.publishGetResolved(itemId);
    if (this._itemId() !== itemId) return;
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

    await this.persistTitles(t, next);
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
        t,
        current.map((title, i) => (i === index ? trimmed : title))
      );
      return;
    }

    if (current.length >= MAX_AB_VARIANTS) {
      this._error.set(`You can test at most ${MAX_AB_VARIANTS} titles. Deselect one first.`);
      return;
    }
    await this.persistTitles(t, [...current, trimmed]);
  }

  private async persistTitles(itemId: string, titles: string[]): Promise<void> {
    this._saving.set(true);
    this._error.set(null);
    try {
      const res = await this.electron.publishSetTitles(itemId, titles);
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
   * Persist one or more publish fields.
   *
   * Pass null to clear a field where null is legal (the overrides fall back to the
   * generated value). Validation lives in the main process and the write is
   * all-or-nothing, so a rejection here means NOTHING changed — the error text names the
   * field and the rule and is shown as-is rather than summarised.
   */
  async setFields(fields: PublishFields): Promise<void> {
    const t = this.target('save that change');
    if (!t) return;

    // A pending channel suggestion rides along with whatever else is being saved, in the
    // SAME call, so it is written by the same all-or-nothing write rather than by a
    // second one that could half-succeed.
    const payload = this.withChannelSeed(fields);

    this._saving.set(true);
    this._error.set(null);
    try {
      const res = await this.electron.publishSetFields(t, payload);
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

  // --------------------------------------------------------- the Publish panel's writes
  //
  // Channel seeding, spelled out once: a suggestion is shown pre-selected and is written
  // WITH THE OPERATOR'S NEXT SAVE, whatever that save is. It is never written on its own
  // off the back of merely opening a report — an open is not a decision — and it is
  // dropped the moment the operator touches the picker, because at that point they have
  // decided and the suggestion has nothing left to say. The panel states this on screen
  // ("saved with your next change") so the write is never a surprise.

  /** The suggestion a save should carry, or null when there is nothing pending. */
  private pendingChannelSeed(): string | null {
    if (this._channelTouched()) return null;
    if (this._selection()?.channelId) return null;
    return this._channelSuggestion()?.channelId ?? null;
  }

  /** Merge the pending suggestion into a write, unless the write is about the channel. */
  private withChannelSeed(fields: PublishFields): PublishFields {
    if ('channelId' in fields) return fields;
    const seed = this.pendingChannelSeed();
    return seed === null ? fields : { ...fields, channelId: seed };
  }

  /**
   * Save the suggestion after a write that went through a DIFFERENT channel.
   *
   * The thumbnail has its own IPC channel, so it cannot carry the seed in its payload the
   * way setFields does. It is written after the thumbnail write succeeds, never before:
   * a failed action must not still route the video.
   */
  private async commitChannelSeed(itemId: string): Promise<void> {
    const seed = this.pendingChannelSeed();
    if (seed === null) return;

    const res = await this.electron.publishSetFields(itemId, { channelId: seed });
    if (!res.success || !res.data) {
      this.reportError(res.error ?? 'Saved, but the suggested channel could not be stored.');
      return;
    }
    this._selection.set(res.data);
  }

  /**
   * The operator's own choice of channel, including `null` for "not routed".
   *
   * Marks the picker touched first, so no later save re-applies the suggestion this
   * choice replaces. That is what makes an override stick.
   */
  async chooseChannel(channelId: string | null): Promise<void> {
    this._channelTouched.set(true);
    this._channelSuggestion.set(null);
    await this.setFields({ channelId });
  }

  /**
   * Set the go-live time from the two local boxes the panel offers.
   *
   * Composition lives here rather than in the component so the ONE place that turns a
   * wall clock into an instant is inside the feature. A value that cannot be composed
   * (an incomplete pair, or the hour that does not exist on a spring-forward morning)
   * is a refusal shown in the same banner as a rejected save — nothing is sent.
   */
  async setPublishAtLocal(date: string, time: string): Promise<void> {
    let iso: string;
    try {
      iso = composePublishAt(date, time);
    } catch (err: any) {
      this._error.set(err?.message || String(err));
      return;
    }
    await this.setFields({ publishAt: iso });
  }

  /** Drop the schedule. The record still records when it was dropped. */
  async clearPublishAt(): Promise<void> {
    await this.setFields({ publishAt: null });
  }

  /** Podcast episode or not. Strictly boolean — the main process refuses anything else. */
  async setPodcast(isPodcast: boolean): Promise<void> {
    await this.setFields({ isPodcast });
  }

  /**
   * Record what should happen to monetization in Studio, or null to record no decision.
   *
   * The Data API cannot write monetization at all (PUBLISH-PIPELINE-PLAN Phase 5), so
   * this value does nothing on its own — it travels to the companion extension, which
   * fills Studio's Monetization tab when the operator clicks the action there. Setting it
   * here monetizes nothing by itself.
   */
  async setMonetize(monetize: boolean | null): Promise<void> {
    await this.setFields({ monetize });
  }

  /**
   * Attach a thumbnail file.
   *
   * Validation is entirely the main process's (extension AND magic bytes, ≤2 MiB,
   * ≥640x360), so a rejection arrives as text naming the file and the rule and is shown
   * verbatim. Warnings come back WITH a success — a 4:3 image is stored and used, and the
   * note about it sits under the row rather than replacing the image.
   */
  async setThumbnail(absPath: string): Promise<void> {
    const t = this.target('set the thumbnail');
    if (!t) return;

    this._saving.set(true);
    this._error.set(null);
    try {
      const res = await this.electron.publishSetThumbnail(t, absPath);
      if (!res.success || !res.data) {
        this._error.set(res.error ?? 'Failed to set the thumbnail');
        return;
      }
      this._selection.set(res.data.selection);
      this._thumbnailWarnings.set(res.data.warnings);
      this._proposal.set(null);
      this._proposalPreview.set(null);
      await this.commitChannelSeed(t);
      await this.refreshThumbnail(t);
    } finally {
      this._saving.set(false);
    }
  }

  /**
   * Detach the thumbnail.
   *
   * refreshThumbnail runs afterwards, which means the exported thumbnail (if there is
   * one) is offered again — clearing a thumbnail is how the operator asks to be shown
   * what is on disk.
   */
  async clearThumbnail(): Promise<void> {
    const t = this.target('clear the thumbnail');
    if (!t) return;

    this._saving.set(true);
    this._error.set(null);
    try {
      const res = await this.electron.publishSetThumbnail(t, null);
      if (!res.success || !res.data) {
        this._error.set(res.error ?? 'Failed to clear the thumbnail');
        return;
      }
      this._selection.set(res.data.selection);
      this._thumbnailWarnings.set([]);
      await this.commitChannelSeed(t);
      await this.refreshThumbnail(t);
    } finally {
      this._saving.set(false);
    }
  }

  /** Accept the offered thumbnail. The only thing that ever applies a proposal. */
  async confirmProposal(): Promise<void> {
    const proposal = this._proposal();
    if (!proposal) {
      this._error.set('There is no proposed thumbnail to confirm.');
      return;
    }
    await this.setThumbnail(proposal.path);
  }

  /**
   * Stop offering it, for now.
   *
   * Stores NOTHING — there is no field for "declined", and inventing one here would be a
   * claim the record cannot make. Reopening the report offers it again, which is honest:
   * the file is still on disk and the item still has no thumbnail.
   */
  dismissProposal(): void {
    this._proposal.set(null);
    this._proposalPreview.set(null);
  }

  // ------------------------------------------------------------------- carry forward
  //
  // The regeneration hint, and the only place it turns into a write. Everything below
  // happens because the operator clicked: nothing here runs off a load, and the offer
  // itself (refreshCarryForward) writes nothing at all.

  /**
   * Take the earlier run's channel / thumbnail / podcast flag / transcript link.
   *
   * The main process re-reads that record and re-validates every value NOW, so this is
   * not a copy of what the offer displayed — a thumbnail file that has vanished since the
   * panel opened is refused by name rather than carried as a dead path. The receipt names
   * all four fields either way, and it stays on screen until dismissed: a carry that
   * brought three of four fields is a result the operator has to be able to read.
   */
  async applyCarryForward(): Promise<CarryReceipt | null> {
    const t = this.target('carry forward the earlier run');
    if (!t) return null;

    const offer = this.carryOffer();
    if (!offer) {
      this._error.set('There is no earlier run on offer for this item.');
      return null;
    }

    this._carrying.set(true);
    this._error.set(null);
    try {
      const res = await this.electron.publishApplyCarryForward(t, offer.fromItemId);
      if (this._itemId() !== t) return null;
      if (!res.success || !res.data) {
        this._error.set(res.error ?? 'The carry-forward failed and the main process gave no reason.');
        return null;
      }

      const receipt = res.data;
      this._carryReceipt.set(receipt);
      // null means nothing was applied, so no record was created — the item is exactly as
      // it was, and saying so is the receipt's job, not this signal's.
      if (receipt.selection) this._selection.set(receipt.selection);

      // The offer is spent either way. When fields were applied the record is no longer
      // fresh and carryOffer would drop it anyway; when everything was refused, the
      // receipt below the panel is now the answer, and re-offering the same click that
      // just refused four fields would be asking the operator to try again in the hope of
      // a different result.
      this._carryCandidate.set(null);
      // The thumbnail half of the panel is now describing a different record.
      await this.refreshThumbnail(t);
      return receipt;
    } finally {
      this._carrying.set(false);
    }
  }

  /**
   * Wave the offer away for this sitting.
   *
   * Stores NOTHING, for the same reason dismissProposal does: there is no "declined"
   * field on the record, and inventing one would be a claim the record cannot make. The
   * earlier run still exists and this item still has nothing set, so reopening the app
   * offers again — which is the honest answer, not a nag.
   */
  dismissCarryForward(): void {
    const itemId = this._itemId();
    if (!itemId) return;
    const next = new Set(this._carryDismissed());
    next.add(itemId);
    this._carryDismissed.set(next);
  }

  /** Put the carry-forward receipt away. Nothing on the record changes. */
  dismissCarryReceipt(): void {
    this._carryReceipt.set(null);
  }

  /** Drop every pick for the current item. */
  async clear(): Promise<void> {
    const t = this.target('clear the selection');
    if (!t) return;

    this._saving.set(true);
    try {
      const res = await this.electron.publishClear(t);
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

  /**
   * Push this item's chosen metadata to its linked video.
   *
   * THE ONLY REMOTE WRITE IN THIS SERVICE, and the only one that changes something the
   * audience can see. It is never called from a value change — the component asks for an
   * explicit confirmation first, showing exactly what will be sent.
   *
   * Nothing is decided here. The main process reads the video, refuses what has to be
   * refused (no chosen title, a video on another channel, a published video that cannot
   * be scheduled, a thumbnail that no longer validates) and its message is shown as it
   * came. A failure means NOTHING was written — the refusals all happen before the write.
   */
  async pushToYouTube(): Promise<PushReceipt | null> {
    const t = this.target('push to YouTube');
    if (!t) return null;

    const blocked = this.pushBlockedReason();
    if (blocked) {
      this._error.set(`Cannot push: ${blocked}`);
      return null;
    }

    this._pushing.set(true);
    this._error.set(null);
    this._receipt.set(null);
    try {
      const res = await this.electron.publishPushYouTube(t);
      if (this._itemId() !== t) return null;
      if (!res.success || !res.data) {
        this._error.set(res.error ?? 'The push failed and the main process gave no reason.');
        return null;
      }
      this._selection.set(res.data.selection);
      this._receipt.set(res.data.receipt);
      return res.data.receipt;
    } finally {
      this._pushing.set(false);
    }
  }

  /** Put the receipt away. It stays on the record; this only closes the panel's copy. */
  dismissReceipt(): void {
    this._receipt.set(null);
  }

  dismissError(): void {
    this._error.set(null);
  }

  /**
   * Show a refusal that came from the panel rather than from the main process.
   *
   * There are a couple: picking two files for one thumbnail, confirming a proposal that
   * is no longer on screen. They are refusals like any other and belong in the same
   * banner, not in a console nobody is reading.
   */
  showError(message: string): void {
    this._error.set(message);
  }
}
