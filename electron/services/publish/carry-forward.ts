/**
 * Carry Forward — publish state across a REGENERATION
 *
 * Regenerating a video mints a NEW item id (item-identity.ts: two runs over the same
 * source are two different items, deliberately), so the publish record the operator built
 * up against the first run — its channel, its thumbnail, its podcast flag, its editor
 * transcript link — does not travel with it. Every one of those is a fact about the
 * VIDEO, not about the run, and re-entering them by hand after every regeneration is
 * exactly the kind of chore that gets done wrong once and then shipped.
 *
 * What links the two runs is `source_key` (ITEM-ID-PLAN.md §3.2), and that document is
 * emphatic about what it is: A HINT DRIVING AN EXPLICIT OPERATOR ACTION, never an
 * implicit join. So this module OFFERS and APPLIES; it never inherits. Nothing here runs
 * off the back of opening a report, `findCarryForward` writes nothing at all, and
 * `applyCarryForward` only ever happens because someone clicked.
 *
 * WHAT CARRIES (spec §5, PR 6): transcriptRef, channelId, thumbnailPath (+ its meta) and
 * isPodcast.
 *
 * WHAT DOES NOT, and why each one would be wrong rather than merely unimplemented:
 *   publishAt      — a schedule is about ONE upload. The old run's slot is either already
 *                    past or already taken by the video that went out.
 *   videoId        — it names the video the OLD item was linked to. Carrying it forward
 *                    would silently aim the next push at a video this run never produced.
 *   chosenTitles   — they index a different run's title list. The new run generated new
 *                    titles; carrying strings from the old set would put titles on screen
 *                    that the report does not contain.
 *   descriptionOverride / tagsOverride — same reason, one level down: an override is an
 *                    edit OF a generated value, and the generated value has changed.
 *   pushedAt / pushReceipt — they are the record of something YouTube actually received.
 *                    Copying them onto a fresh item would claim a push that never happened.
 *
 * RE-READ AT APPLY TIME. The offer the operator sees was computed when the panel opened;
 * the apply re-reads the source record, re-checks the source_key join, and puts every
 * value back through the SAME validator a fresh write would face — the channel registry
 * can have changed, and the thumbnail lives on Callisto, an external volume. A carried
 * value that no longer validates is REFUSED and named, never carried as a dead link.
 *
 * PARTIAL IS A STATED OUTCOME, NOT A FALLBACK. Four fields go in and each one comes back
 * in exactly one of three buckets — applied, skipped (with the reason it had nothing to
 * do), refused (with the validator's own message). A field in none of them would be a
 * field nobody can account for. The store write itself is still one atomic update of the
 * fields that passed.
 */

import { ChosenMetadata, ThumbnailMeta, TranscriptRef, isItemId } from './publish-types';
import { GeneratedFallback, GeneratedItemSummary, PublishStoreService } from './publish-store.service';
import { FieldContext, FieldPatch, applyFieldValidator } from './field-validators';
import { validateThumbnailFile } from './thumbnail-validate';
import { RoutableChannel } from './channel-routing';

/**
 * The three-state resolution of a stored transcript ref, as this module needs it.
 *
 * Declared structurally rather than imported: the resolver is
 * services/metadata/editor-transcript-link.ts, and publish/ does not import from
 * services/metadata (that is what keeps this directory liftable). The host injects the
 * real one; this is the shape it has to satisfy. `ok` is the only state that carries.
 */
export type CarriedRefResolution =
  | { state: 'ok' }
  | { state: 'missing'; reason: string }
  | { state: 'changed'; reason: string };

/** The four fields that describe the VIDEO rather than the run. Nothing else carries. */
export type CarryField = 'transcriptRef' | 'channelId' | 'thumbnail' | 'isPodcast';

export const CARRY_FIELDS: CarryField[] = ['transcriptRef', 'channelId', 'thumbnail', 'isPodcast'];

/**
 * What an earlier item holds that could be carried.
 *
 * `thumbnailPath` and `thumbnailMeta` travel together because they are one fact stated
 * twice — the file, and what it measured. The meta stored by an apply is the FRESH
 * measurement, not this one; this copy is here so the offer can say how big the image is
 * without touching the disk.
 */
export interface CarryableState {
  transcriptRef: TranscriptRef | null;
  channelId: string | null;
  thumbnailPath: string | null;
  thumbnailMeta: ThumbnailMeta | null;
  isPodcast: boolean;
}

/** One earlier item over the same source, and what its publish record holds. */
export interface CarrySibling {
  itemId: string;
  jobId: string;
  /** ISO. The job that produced it — what "generated before (DATE)" says on screen. */
  jobCreatedAt: string;
  /** False when the operator never touched that item: there is a sibling, not a source. */
  hasRecord: boolean;
  /** null exactly when hasRecord is false. */
  state: CarryableState | null;
  /** True when at least one of the four fields holds something worth offering. */
  carryable: boolean;
}

/** The offer: the newest earlier item that actually has something to carry. */
export interface CarryForwardCandidate {
  fromItemId: string;
  fromJobId: string;
  jobCreatedAt: string;
  state: CarryableState;
  /** The join that found it, shown so the operator can see WHY these two are the same video. */
  sourceKey: string;
  /**
   * How many other items share this source_key, whether or not they carry state.
   *
   * Travels with the offer because "one earlier run" and "the newest of six" are
   * different situations and the second one is worth a second look before clicking.
   */
  siblingCount: number;
}

/** One field's outcome. Exactly one of these per field, every time. */
export interface CarryFieldOutcome {
  field: CarryField;
  /** What was written, or what was refused/skipped — in the operator's terms, not JSON. */
  detail: string;
}

/**
 * What one apply actually did.
 *
 * Every one of the four fields appears in EXACTLY ONE of applied / skipped / refused.
 * That is the whole receipt: a partial carry is a legitimate result and this is how it is
 * stated, rather than a success message that quietly covers three fields out of four.
 *
 *   applied  — written to the record, having passed the same validator a fresh write faces.
 *   skipped  — nothing to do: the source has no value, or the target already has one
 *              (a carry NEVER overwrites; the value on the target is the operator's).
 *   refused  — the source had a value and it did not validate NOW. The message is the
 *              validator's own, naming the path / id / rule. This is the loud failure.
 */
export interface CarryReceipt {
  fromItemId: string;
  toItemId: string;
  applied: CarryFieldOutcome[];
  skipped: CarryFieldOutcome[];
  refused: CarryFieldOutcome[];
  /** Non-fatal notes that came back WITH an accepted value (a thumbnail that is not 16:9). */
  warnings: string[];
  /**
   * The record as it now stands, or null when nothing was applied AND the item had no
   * record — an apply that writes nothing creates nothing.
   */
  selection: ChosenMetadata | null;
}

export interface CarryForwardDeps {
  store: PublishStoreService;
  /** The host's index of every generated item, newest-first. Format knowledge stays there. */
  listGenerated: () => { items: GeneratedItemSummary[] };
  /** The generated values for an item — the store's seed when a record is created. */
  readGenerated: (itemId: string) => GeneratedFallback | null;
  /** The channel registry, read fresh, exactly as publish-set-fields reads it. */
  listChannels: () => RoutableChannel[];
  /** Is the linked story transcript still the file that was linked? Injected; see above. */
  resolveTranscriptRef: (ref: TranscriptRef) => CarriedRefResolution;
  /** "Now" for the validators that are time-relative. */
  now?: Date;
}

/** The carryable half of a stored record. */
function carryableOf(record: ChosenMetadata): CarryableState {
  return {
    transcriptRef: record.transcriptRef,
    channelId: record.channelId,
    thumbnailPath: record.thumbnailPath,
    thumbnailMeta: record.thumbnailMeta,
    isPodcast: record.isPodcast,
  };
}

/**
 * Is there anything here worth offering?
 *
 * `isPodcast: false` is NOT something to carry. It is the value every fresh record is
 * born with, so an offer whose only content was `false` would be an offer to change
 * nothing — and a receipt saying "applied isPodcast" for a no-op is a receipt that has
 * started lying about what happened.
 */
function hasCarryableState(state: CarryableState): boolean {
  return (
    state.transcriptRef !== null ||
    state.channelId !== null ||
    state.thumbnailPath !== null ||
    state.isPodcast === true
  );
}

/**
 * Other items generated from the same source file, newest first.
 *
 * Pure, over the index the host already builds. Three rules, each one a case that would
 * otherwise produce a wrong join:
 *   - a null source_key NEVER matches, on either side. Text subjects and compilations
 *     record null (item-identity.ts), and "null equals null" would join every text
 *     subject in the app to every other one.
 *   - the item never matches ITSELF. Its own record is not a carry-forward source.
 *   - order is by the job's creation time, newest first, with the item id breaking ties
 *     (the id is time-sortable, so this is still "most recent first" within a job).
 */
export function selectRegenSiblings(
  itemId: string,
  items: GeneratedItemSummary[]
): { sourceKey: string | null; siblings: GeneratedItemSummary[] } {
  const target = items.find((i) => i.itemId === itemId);
  if (!target) {
    throw new Error(
      `No generated item ${JSON.stringify(itemId)} in the report index — carry-forward ` +
      `cannot say what an item it cannot find was generated from.`
    );
  }

  // A text subject or a compilation has no single source file, so it has no regeneration
  // join at all. That is an answer, not a miss.
  if (target.sourceKey === null) return { sourceKey: null, siblings: [] };

  const siblings = items
    .filter(
      (i) => i.itemId !== target.itemId && i.sourceKey !== null && i.sourceKey === target.sourceKey
    )
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '') || b.itemId.localeCompare(a.itemId));

  return { sourceKey: target.sourceKey, siblings };
}

/**
 * Every earlier item over the same source, each one saying whether it has a publish
 * record and what that record holds. Newest first.
 *
 * READ ONLY. An unreadable selection file throws out of `store.get` and is left to throw:
 * a record we cannot read is not a record with nothing in it, and reporting it as "no
 * state to carry" would look exactly like an item the operator never touched.
 */
export function listCarrySiblings(itemId: string, deps: CarryForwardDeps): CarrySibling[] {
  requireItemId(itemId, 'itemId');
  const { siblings } = selectRegenSiblings(itemId, deps.listGenerated().items);

  return siblings.map((sibling) => {
    const record = deps.store.get(sibling.itemId);
    const state = record ? carryableOf(record) : null;
    return {
      itemId: sibling.itemId,
      jobId: sibling.jobId,
      jobCreatedAt: sibling.createdAt,
      hasRecord: record !== null,
      state,
      carryable: state !== null && hasCarryableState(state),
    };
  });
}

/**
 * The offer, or null when there is nothing to offer.
 *
 * The NEWEST sibling that actually carries something. Newest because it is the operator's
 * most recent statement about this video; "actually carries something" because a sibling
 * whose record is empty is a run that happened, not a decision that was made — offering
 * it would put a button on screen that applies nothing.
 */
export function findCarryForward(
  itemId: string,
  deps: CarryForwardDeps
): CarryForwardCandidate | null {
  requireItemId(itemId, 'itemId');
  const { sourceKey, siblings } = selectRegenSiblings(itemId, deps.listGenerated().items);
  if (sourceKey === null || siblings.length === 0) return null;

  for (const sibling of siblings) {
    const record = deps.store.get(sibling.itemId);
    if (!record) continue;
    const state = carryableOf(record);
    if (!hasCarryableState(state)) continue;

    return {
      fromItemId: sibling.itemId,
      fromJobId: sibling.jobId,
      jobCreatedAt: sibling.createdAt,
      state,
      sourceKey,
      siblingCount: siblings.length,
    };
  }
  return null;
}

/**
 * Carry the four fields from one item's record onto another's. One click, logged by the
 * caller, and never automatic.
 *
 * The join is RE-CHECKED here rather than trusted from the offer: `fromItemId` arrives
 * over IPC, and an item that does not share this item's source_key is not a regeneration
 * of it — carrying from it would move one video's thumbnail onto another video.
 */
export async function applyCarryForward(
  toItemId: string,
  fromItemId: string,
  deps: CarryForwardDeps
): Promise<CarryReceipt> {
  requireItemId(toItemId, 'itemId');
  requireItemId(fromItemId, 'fromItemId');
  if (toItemId === fromItemId) {
    throw new Error(
      `Carry-forward needs two different items; both ids were ${toItemId}. An item's own ` +
      `record is not a source to carry from.`
    );
  }

  // The join, re-established from the reports themselves.
  const { sourceKey, siblings } = selectRegenSiblings(toItemId, deps.listGenerated().items);
  if (sourceKey === null) {
    throw new Error(
      `Item ${toItemId} records no source_key (a text subject or a compilation), so no ` +
      `earlier item can be a regeneration of it.`
    );
  }
  const sibling = siblings.find((s) => s.itemId === fromItemId);
  if (!sibling) {
    throw new Error(
      `Item ${fromItemId} is not a regeneration of ${toItemId}: it does not share the ` +
      `source_key ${JSON.stringify(sourceKey)}.`
    );
  }

  // RE-READ, not taken from the offer. The offer was computed when the panel opened and
  // the operator may have changed that record since.
  const source = deps.store.get(fromItemId);
  if (!source) {
    throw new Error(
      `Item ${fromItemId} has no publish record to carry forward. It had one when this ` +
      `was offered — it has since been cleared.`
    );
  }
  const target = deps.store.get(toItemId);

  const ctx: FieldContext = { listChannels: deps.listChannels, now: deps.now ?? new Date() };
  const applied: CarryFieldOutcome[] = [];
  const skipped: CarryFieldOutcome[] = [];
  const refused: CarryFieldOutcome[] = [];
  const warnings: string[] = [];
  let patch: FieldPatch = {};

  // ---------------------------------------------------------------- transcriptRef
  if (source.transcriptRef === null) {
    skipped.push({ field: 'transcriptRef', detail: 'the earlier run had no editor transcript linked.' });
  } else if (target && target.transcriptRef !== null) {
    skipped.push({
      field: 'transcriptRef',
      detail: `already set — this item is linked to "${target.transcriptRef.storyTitle}" ` +
        `(session ${target.transcriptRef.sourceSession}).`,
    });
  } else {
    // Same three-state resolution the generator applies before it will use a link: a file
    // that is gone, or that is no longer the file that was linked, is refused. Silent
    // reuse of a re-exported session is prohibited (spec §3.1) and carrying one forward
    // would be exactly that, one step earlier.
    let resolution: CarriedRefResolution;
    try {
      resolution = deps.resolveTranscriptRef(source.transcriptRef);
    } catch (err: any) {
      // The resolver THROWS rather than answering when the ref itself is malformed (no
      // path, wrong kind — a hand-edited record). That is still an answer about this one
      // field, and it is reported as one: it lands in `refused` with the resolver's own
      // message, exactly like a file that is gone. Nothing is carried and nothing is
      // swallowed — the other three fields are not this field's business.
      resolution = { state: 'missing', reason: err?.message || String(err) };
    }
    if (resolution.state === 'ok') {
      patch = { ...patch, transcriptRef: source.transcriptRef };
      applied.push({
        field: 'transcriptRef',
        detail: `"${source.transcriptRef.storyTitle}" (story ${source.transcriptRef.storyNumber} ` +
          `of session ${source.transcriptRef.sourceSession}).`,
      });
    } else {
      refused.push({
        field: 'transcriptRef',
        detail: `the linked transcript is ${resolution.state} — ${resolution.reason}`,
      });
    }
  }

  // -------------------------------------------------------------------- channelId
  if (source.channelId === null) {
    skipped.push({ field: 'channelId', detail: 'the earlier run was never routed to a channel.' });
  } else if (target && target.channelId !== null) {
    skipped.push({ field: 'channelId', detail: `already set — this item is routed to ${target.channelId}.` });
  } else {
    try {
      // The registry as it is NOW. A channel that has since been disconnected is not a
      // channel this app can push to, and storing it because it was valid in July would
      // put a value on the record that the field's own contract says cannot be there.
      patch = { ...patch, ...applyFieldValidator('channelId', source.channelId, ctx) };
      const name = deps.listChannels().find((c) => c.channelId === source.channelId)?.name;
      applied.push({
        field: 'channelId',
        detail: name ? `${name} (${source.channelId}).` : `${source.channelId}.`,
      });
    } catch (err: any) {
      refused.push({ field: 'channelId', detail: err?.message || String(err) });
    }
  }

  // -------------------------------------------------------------------- thumbnail
  if (source.thumbnailPath === null) {
    skipped.push({ field: 'thumbnail', detail: 'the earlier run had no thumbnail.' });
  } else if (target && target.thumbnailPath !== null) {
    skipped.push({ field: 'thumbnail', detail: `already set — ${target.thumbnailPath}.` });
  } else {
    try {
      // Re-measured, not copied. thumbnailPath points at an external volume, so the meta
      // stored here describes the file AS IT IS NOW; carrying the old measurements would
      // record a size and a shape nobody just verified. A file that has vanished throws,
      // naming the path, and lands in `refused` — never a dead link on the record.
      const { meta, warnings: thumbWarnings } = validateThumbnailFile(source.thumbnailPath);
      // 'manual', whatever it was on the earlier record. Carrying forward happens because
      // the operator CLICKED, so the thumbnail on the new item is his choice however it
      // reached the old one — and marking it 'auto' would let automatic discovery
      // overwrite a decision he just made. See ThumbnailSource.
      patch = {
        ...patch,
        thumbnailPath: source.thumbnailPath,
        thumbnailMeta: meta,
        thumbnailSource: 'manual',
      };
      applied.push({
        field: 'thumbnail',
        detail: `${source.thumbnailPath} (${meta.width}×${meta.height}, ${meta.mime}).`,
      });
      for (const warning of thumbWarnings) warnings.push(`thumbnail: ${warning}`);
    } catch (err: any) {
      refused.push({ field: 'thumbnail', detail: err?.message || String(err) });
    }
  }

  // --------------------------------------------------------------------- isPodcast
  if (source.isPodcast !== true) {
    skipped.push({
      field: 'isPodcast',
      detail: 'the earlier run is not marked a podcast, which is what a new record already says.',
    });
  } else if (target && target.isPodcast === true) {
    skipped.push({ field: 'isPodcast', detail: 'already set — this item is already marked a podcast.' });
  } else {
    try {
      // Through the strict validator like everything else: a hand-edited record holding
      // the STRING "true" is exactly the `_is_compilation` bug, and it must not survive a
      // trip through carry-forward into a fresh record.
      patch = { ...patch, ...applyFieldValidator('isPodcast', source.isPodcast, ctx) };
      applied.push({ field: 'isPodcast', detail: 'marked as a podcast episode.' });
    } catch (err: any) {
      refused.push({ field: 'isPodcast', detail: err?.message || String(err) });
    }
  }

  // ONE write, of everything that passed. The per-field decisions above are reported
  // individually, but the store sees a single atomic update — a half-written record is
  // not one of the outcomes this receipt can describe.
  let selection: ChosenMetadata | null = target;
  if (Object.keys(patch).length > 0) {
    const generated = deps.readGenerated(toItemId);
    if (!generated) {
      throw new Error(
        `No generated metadata for item ${toItemId}; its report cannot be read, so there ` +
        `is nothing to write a publish record against.`
      );
    }
    selection = await deps.store.update(toItemId, generated, patch);
  }

  const accounted = applied.length + skipped.length + refused.length;
  if (accounted !== CARRY_FIELDS.length) {
    // Not defensive decoration: this is the receipt's one invariant, and a field that
    // fell through every branch above would be a field nobody can account for.
    throw new Error(
      `Carry-forward receipt accounts for ${accounted} fields; there are ${CARRY_FIELDS.length}.`
    );
  }

  return { fromItemId, toItemId, applied, skipped, refused, warnings, selection };
}

function requireItemId(value: unknown, name: string): string {
  if (!isItemId(value)) {
    throw new Error(`${name} must be an item id of the form itm-<time>-<random>; got ${JSON.stringify(value)}`);
  }
  return value;
}
