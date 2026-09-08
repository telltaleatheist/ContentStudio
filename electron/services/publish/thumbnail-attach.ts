/**
 * Find, validate, attach — ONE implementation, for the two things that ask for it
 *
 * The automatic pass (auto-config.ts) resolves a thumbnail on every write to a record that has
 * no answer about one yet. That is right for a pass nobody asked for, and it is why an item
 * generated BEFORE its thumbnail was exported sits with none: the operator makes the image after
 * the run, because he needs the generated thumbnail text to make it, and by then the pass that
 * would have found it has already run and found nothing.
 *
 * Two things close that gap, and they are deliberately different asks:
 *
 *   "Look again" (publish-rescan-thumbnail) — ONE item, on a click, and it may REPLACE an
 *   automatically attached path with whatever is on disk now. The click is what authorizes the
 *   replacement.
 *
 *   The sweep (publish-pair-missing-thumbnails) — EVERY item with no thumbnail at all, run when
 *   the operator opens the reports page. It never replaces anything, because nobody clicked on
 *   any particular item (ledger #185).
 *
 * WHAT THEY SHARE IS THIS FILE, and the rescan's own comment is why it exists: "These were two
 * implementations of 'find and validate a thumbnail', and they drifted the moment one of them
 * learned to shrink an oversized export — this button went on refusing files the automatic pass
 * had started accepting, which from the outside was a button that did nothing." A third copy
 * would drift the same way. So the find, the validation, the same-file check, the write and the
 * sentence that reports it live here once, and each caller decides only WHICH ITEMS to hand it.
 *
 * WHAT IS NOT SHARED, on purpose: the FIRST FILL (an item with no publish record at all — the
 * rescan creates one, the sweep does not), and each caller's own policy about which records it
 * is willing to open. Those are the two asks differing, which is the whole reason there are two.
 */

import { AutoDecision } from './auto-config';
import { GeneratedFallback, PublishStoreService } from './publish-store.service';
import { ChosenMetadata } from './publish-types';
import { findUsableThumbnail } from './thumbnail-validate';

/** What one find-validate-attach did, in the automatic pass's own three buckets. */
export interface ThumbnailAttachOutcome {
  bucket: 'applied' | 'skipped' | 'refused';
  /** A whole sentence, in the operator's terms. Always present, including for a no-op. */
  decision: AutoDecision;
  /** The path now on the record, or null when nothing was attached. */
  attachedPath: string | null;
  /** The path this replaced, or null when there was none. */
  replaced: string | null;
}

export interface ThumbnailAttachRequest {
  store: PublishStoreService;
  itemId: string;
  /** The item's generated report — the source path every candidate is derived from. */
  generated: GeneratedFallback;
  /** The record as it stands. The caller has already read it and decided to offer it. */
  record: ChosenMetadata;
}

/**
 * Resolve the exported thumbnail for one item and attach it, or say why not.
 *
 * A MANUAL PICK IS PROTECTED; A MANUAL CLEAR IS NOT, and those are different statements —
 * choosing an image says "use this one" and nothing here may overrule it, while clearing says
 * "not the one you found", which a later explicit click is entitled to undo. That distinction is
 * the RESCAN's, and it is kept here because it is the one that must never be lost. The sweep
 * takes a stricter line of its own before it ever calls this, and refuses to open a record whose
 * source is 'manual' at all: nobody clicked on that item.
 *
 * A 'slot'-only match IS attached, with the caution spelled out in its sentence — the match was
 * on the slot number, a renumbered slot can point at another video's thumbnail, so check the
 * image. That gate was retired 2026-08-25, the day the reports list started showing every row's
 * thumbnail: "if it's wrong, I'll see it and correct it."
 *
 * A file that exists and will not validate comes back REFUSED with the validator's own sentence,
 * never thrown: one 3 MiB image on an external volume is not a reason to fail the call that
 * found it.
 */
export async function findAndAttachThumbnail(
  request: ThumbnailAttachRequest
): Promise<ThumbnailAttachOutcome> {
  const { store, itemId, generated, record } = request;

  if (record.thumbnailSource === 'manual' && record.thumbnailPath) {
    return {
      bucket: 'skipped',
      attachedPath: null,
      replaced: null,
      decision: {
        field: 'thumbnail',
        detail:
          `${record.thumbnailPath} was chosen by hand, and automatic discovery never replaces a ` +
          `manually chosen thumbnail. Clear it in the panel first if you want the exported ` +
          `image instead.`,
      },
    };
  }

  // THE SAME resolver the automatic pass uses — see the header for what happened the last time
  // there were two of these.
  const lookup = findUsableThumbnail(generated.sourcePath ?? null);
  if (!lookup.ok) {
    return {
      bucket: lookup.bucket,
      attachedPath: null,
      replaced: null,
      decision: { field: 'thumbnail', detail: lookup.detail },
    };
  }
  const found = { path: lookup.pick.path, match: lookup.pick.match };
  const validation = { meta: lookup.pick.meta, warnings: lookup.pick.warnings };

  if (record.thumbnailPath === found.path) {
    return {
      bucket: 'skipped',
      attachedPath: found.path,
      replaced: null,
      decision: {
        field: 'thumbnail',
        detail:
          `${found.path} is already attached to this item — the same file was found and the ` +
          `record was left untouched.`,
      },
    };
  }

  const previous = record.thumbnailPath;
  await store.update(itemId, generated, {
    thumbnailPath: found.path,
    thumbnailMeta: validation.meta,
    // 'auto' exactly as the automatic pass writes it, so every rescan and replace rule
    // downstream holds: a path this found is one the operator has not chosen, and the next
    // explicit rescan is free to replace it.
    thumbnailSource: 'auto',
  });

  const notes =
    (validation.warnings.length ? ` ${validation.warnings.join(' ')}` : '') + lookup.pick.note;
  return {
    bucket: 'applied',
    attachedPath: found.path,
    replaced: previous,
    decision: {
      field: 'thumbnail',
      detail:
        `attached ${found.path} — the sibling export of ${generated.sourcePath}, ` +
        `${validation.meta.width}x${validation.meta.height}, ${validation.meta.bytes} bytes` +
        (previous ? `, replacing the automatically attached ${previous}` : '') +
        (found.match === 'slot'
          ? `. The match was on the SLOT NUMBER only (legacy naming) — check the image, ` +
            `a renumbered slot can point at another video's thumbnail`
          : '') +
        `.${notes}`,
    },
  };
}
