/**
 * Publish Auto-Configuration
 *
 * The two facts about a publish record that the operator has ALREADY STATED somewhere
 * else, filled in from where he stated them instead of being asked for a second time:
 *
 *   channelId      <- the prompt set he picked before generating (job `prompt_set`),
 *                     routed through channels.json.
 *   thumbnailPath  <- the image he exported beside the video, found by the export
 *                     layout's own naming convention.
 *
 * Neither of these is a guess. Both are LOOKUPS IN A DECLARED TABLE — the channel
 * registry and the export layout — and that is the line this module is built along. A
 * fallback is an unexpected code path; a documented convention applied deliberately and
 * announced out loud is a feature. So every decision here, including every decision NOT
 * to act, comes back as a sentence the caller logs. Nothing this module does is silent.
 *
 * ── The three buckets ────────────────────────────────────────────────────────────────
 *
 * Deliberately the same three carry-forward.ts uses, for the same reason: a field that
 * appeared in none of them would be a field nobody can account for afterwards.
 *
 *   applied  — a value was decided, and the patch carries it.
 *   skipped  — nothing to do, with the reason. The MAJORITY outcome and a normal state:
 *              a record that already has a channel, an item with no exported thumbnail,
 *              a prompt set no channel claims.
 *   refused  — something WAS there and could not be used, with the validator's own
 *              message. A thumbnail file that exists but is 3 MiB, or is a renamed
 *              .webp. This is a declared degradation, not a failure of the write that
 *              triggered it: refusing to save a title because an unrelated image on
 *              Callisto is malformed would be a worse bug than the malformed image.
 *
 * ── What it will not do ──────────────────────────────────────────────────────────────
 *
 * It never OVERWRITES. A channel already on the record is the operator's routing (or an
 * earlier auto-route he has since kept), and a thumbnail decision already recorded — even
 * the decision "none", see ThumbnailSource — is his. Auto-configuration only ever fills a
 * field that nobody has answered yet, which is what makes a manual choice permanent
 * without needing a lock.
 *
 * It is called from exactly one place: PublishStoreService.update, i.e. every write to
 * every record, from the reports page, the extension's shelf and carry-forward alike.
 * One caller means an item cannot end up auto-configured through one door and not
 * another — and it means the fill lands on the SAME atomic write as whatever the operator
 * was actually doing, rather than a second write that could half-succeed.
 *
 * AMBIGUOUS ROUTING THROWS, and that throw propagates out of the write. Two channels
 * claiming one prompt set is a contradiction in channels.json that only the operator can
 * resolve (see channel-routing.ts), and the alternative — catching it and carrying on —
 * would hide the contradiction behind every item generated with that prompt set, forever.
 * The error names both channels and the file to fix.
 */

import * as fs from 'fs';
import * as path from 'path';
import { isSpreakerAudioExtension } from './audio-validate';
import { RoutableChannel, resolveChannelForPromptSet } from './channel-routing';
import { FieldPatch } from './field-validators';
import { ChosenMetadata } from './publish-types';
import { findUsableThumbnail } from './thumbnail-validate';

/** What one automatic pass is asked to decide about. */
export interface AutoConfigInput {
  /**
   * The record as it will stand AFTER the caller's own patch — not before.
   *
   * That order matters: a write that sets the channel explicitly must not then be
   * auto-routed on top of itself, and reading the post-patch record is what makes
   * "only fill what is still unanswered" true of the write as a whole rather than of the
   * record it started from.
   */
  record: ChosenMetadata;
  /** The prompt set the RUN recorded, or null when the report has none. */
  promptSet: string | null;
  /** The item's final-export path, or null (a text subject, a compilation). */
  sourcePath: string | null;
  /** The channel registry, read fresh by the caller. */
  channels: RoutableChannel[];
}

/** One decision, in the operator's terms. `detail` is a whole sentence. */
export interface AutoDecision {
  field: 'channelId' | 'thumbnail' | 'isPodcast';
  detail: string;
}

export interface AutoConfigResult {
  /** The fields to merge. Empty when nothing was decided, which is the common case. */
  patch: FieldPatch;
  applied: AutoDecision[];
  skipped: AutoDecision[];
  refused: AutoDecision[];
}

/**
 * Decide everything that can be decided automatically about one record.
 *
 * Touches the disk (thumbnail existence and validation) and nothing else — no writes, no
 * network, no store. The caller merges `patch` and logs the three lists.
 */
export function autoConfigure(input: AutoConfigInput): AutoConfigResult {
  const applied: AutoDecision[] = [];
  const skipped: AutoDecision[] = [];
  const refused: AutoDecision[] = [];
  let patch: FieldPatch = {};

  // Destination BEFORE channel, because it is the coarser question: which service takes
  // this file at all. The channel is then which YouTube channel, and a podcast keeps one
  // anyway so it can be routed back.
  const destination = autoDestination(input);
  if (destination.patch) patch = { ...patch, ...destination.patch };
  pushInto(destination.decision, destination.bucket, applied, skipped, refused);

  const channel = autoChannel(input);
  if (channel.patch) patch = { ...patch, ...channel.patch };
  pushInto(channel.decision, channel.bucket, applied, skipped, refused);

  const thumbnail = autoThumbnail(input);
  if (thumbnail.patch) patch = { ...patch, ...thumbnail.patch };
  pushInto(thumbnail.decision, thumbnail.bucket, applied, skipped, refused);

  return { patch, applied, skipped, refused };
}

/**
 * The destination, from what the source file IS.
 *
 * The two services take disjoint formats and that decides the routing on its own:
 * Spreaker takes audio and not video, YouTube takes video and not an mp3. So a source
 * whose extension Spreaker accepts is a podcast episode, and everything else is a video.
 * The operator stated the rule in exactly those terms, and it beats asking him to restate
 * it per item.
 *
 * Acts ONLY while the record is still unrouted, which is the same marker the channel uses
 * and in practice means the first write — the moment the record is born. `isPodcast` is a
 * strict boolean with no "nobody has decided" value, so an unrouted record is the only
 * honest opportunity to answer it without overwriting somebody.
 *
 * Announced, never silent: it appears in `applied` like every other decision, so a wrong
 * guess is a line the operator can read rather than a destination that changed by itself.
 * Correcting it is the destination picker, and a corrected record is routed, so this never
 * runs on it again.
 *
 * The converse is deliberately NOT enforced. A video source already means YouTube, since
 * that is what `isPodcast: false` says, and flipping a podcast flag OFF because the file
 * is a .mov would overrule an operator who set it for a reason this function cannot see.
 */
function autoDestination(input: AutoConfigInput): FieldOutcome {
  const { record, sourcePath } = input;

  if (record.channelId !== null) {
    return {
      patch: null,
      bucket: 'skipped',
      decision: {
        field: 'isPodcast',
        detail: 'This item is already routed, so its destination is the operator\'s to change.',
      },
    };
  }
  if (sourcePath === null) {
    return {
      patch: null,
      bucket: 'skipped',
      decision: {
        field: 'isPodcast',
        detail: 'This item has no source file, so nothing about it says which service takes it.',
      },
    };
  }
  if (record.isPodcast) {
    return {
      patch: null,
      bucket: 'skipped',
      decision: { field: 'isPodcast', detail: 'Already marked as a podcast episode.' },
    };
  }

  const extension = path.extname(sourcePath).toLowerCase();
  if (!isSpreakerAudioExtension(extension)) {
    return {
      patch: null,
      bucket: 'skipped',
      decision: {
        field: 'isPodcast',
        detail: `The source is a ${extension || 'file with no extension'}, which Spreaker does ` +
          `not take, so this stays a video.`,
      },
    };
  }

  return {
    patch: { isPodcast: true },
    bucket: 'applied',
    decision: {
      field: 'isPodcast',
      detail: `The source is a ${extension}, which YouTube does not take and Spreaker does. ` +
        `Routed to Spreaker as a podcast episode.`,
    },
  };
}

/** One field's answer: the patch it decided (or none), and which bucket to say it in. */
interface FieldOutcome {
  patch: FieldPatch | null;
  bucket: 'applied' | 'skipped' | 'refused';
  decision: AutoDecision;
}

function pushInto(
  decision: AutoDecision,
  bucket: FieldOutcome['bucket'],
  applied: AutoDecision[],
  skipped: AutoDecision[],
  refused: AutoDecision[]
): void {
  if (bucket === 'applied') applied.push(decision);
  else if (bucket === 'refused') refused.push(decision);
  else skipped.push(decision);
}

/**
 * The channel, from the prompt set the item was generated with.
 *
 * This is the answer to "why should the operator pick a channel at all?" — he picked the
 * prompt set before generating, channels.json says which channel that prompt set feeds,
 * and asking again on the publish side is asking him to restate a decision the app
 * already wrote down. The picker stays, because an override is a real thing to want; the
 * blank it used to start from does not.
 *
 * The channelId validator is NOT run over the result. resolveChannelForPromptSet returns
 * an entry OUT OF the registry the validator would check membership against, so the check
 * would be asking the same list whether it contains something it just handed over.
 */
function autoChannel(input: AutoConfigInput): FieldOutcome {
  const { record, promptSet, channels } = input;

  if (record.channelId !== null) {
    return {
      patch: null,
      bucket: 'skipped',
      decision: {
        field: 'channelId',
        detail: `already routed to ${record.channelId}; automatic routing does not overwrite it.`,
      },
    };
  }

  if (typeof promptSet !== 'string' || !promptSet.trim()) {
    return {
      patch: null,
      bucket: 'skipped',
      decision: {
        field: 'channelId',
        detail:
          `the run that generated this item recorded no prompt set, so there is nothing ` +
          `to route from. Pick a channel by hand.`,
      },
    };
  }

  // Throws on an ambiguous registry, deliberately — see the module note.
  const resolution = resolveChannelForPromptSet(promptSet, channels);
  if (resolution.channelId === null) {
    return {
      patch: null,
      bucket: 'skipped',
      decision: { field: 'channelId', detail: resolution.reason },
    };
  }

  return {
    patch: { channelId: resolution.channelId },
    bucket: 'applied',
    decision: {
      field: 'channelId',
      detail: `${resolution.reason} Routed automatically to ${resolution.channelId}.`,
    },
  };
}

/**
 * The thumbnail, from the image exported beside the video.
 *
 * `thumbnailSource === null` — nobody has decided — is the only state this acts on. A
 * 'manual' source is the operator's, INCLUDING a manual clear, which is the case that
 * makes the field worth having: without it, removing a wrong thumbnail and then saving
 * anything else would bring the wrong thumbnail straight back.
 *
 * BOTH candidate forms attach (see ThumbnailCandidate). 'basename' matches are the safe
 * case — the filename carries the export's own label, so a slot renumber makes it miss
 * rather than mis-hit. 'slot' matches used to stop at the proposal panel because a
 * renumber can aim them at another video's image; the operator retired that gate
 * 2026-08-25, the day the reports list started SHOWING every row's thumbnail: "if it's
 * wrong, I'll see it and correct it." The attach sentence still says when the match was
 * slot-only, so the log answers how a wrong image got there.
 *
 * A file that exists and does not validate is REFUSED with the validator's message, not
 * thrown: the write that triggered this pass is almost always about something else
 * entirely, and a 3 MiB image on an external volume is not a reason to refuse to save a
 * title. The record keeps `thumbnailSource: null`, so fixing the file and saving again
 * picks it up.
 */
function autoThumbnail(input: AutoConfigInput): FieldOutcome {
  const { record, sourcePath } = input;

  if (record.thumbnailSource !== null) {
    const detail =
      record.thumbnailSource === 'manual'
        ? record.thumbnailPath
          ? `${record.thumbnailPath} was chosen by hand; automatic discovery does not overwrite it.`
          : `the thumbnail was cleared by hand, so automatic discovery leaves this item without one.`
        : `already attached automatically (${record.thumbnailPath}).`;
    return { patch: null, bucket: 'skipped', decision: { field: 'thumbnail', detail } };
  }

  const lookup = findUsableThumbnail(sourcePath);
  if (!lookup.ok) {
    return {
      patch: null,
      bucket: lookup.bucket,
      decision: { field: 'thumbnail', detail: lookup.detail },
    };
  }
  const found = { path: lookup.pick.path, match: lookup.pick.match };
  const validation = { meta: lookup.pick.meta, warnings: lookup.pick.warnings };
  const shrunkNote = lookup.pick.note;

  const notes =
    (validation.warnings.length ? ` ${validation.warnings.join(' ')}` : '') + shrunkNote;
  return {
    patch: {
      thumbnailPath: found.path,
      thumbnailMeta: validation.meta,
      thumbnailSource: 'auto',
    },
    bucket: 'applied',
    decision: {
      field: 'thumbnail',
      detail:
        `attached ${found.path} automatically — it is the sibling export of ` +
        `${sourcePath}, ${validation.meta.width}x${validation.meta.height}, ` +
        `${validation.meta.bytes} bytes.` +
        (found.match === 'slot'
          ? ` The match was on the SLOT NUMBER only (legacy naming), so check the row's ` +
            `thumbnail — a renumbered slot can point at another video's image.`
          : '') +
        `${notes}`,
    },
  };
}
