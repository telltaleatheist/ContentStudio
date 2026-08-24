/**
 * Publish Field Validators
 *
 * The per-field validator table for a stored publish record, and the two entry points
 * that run it: `buildFieldPatch` (a whole publish-set-fields call) and
 * `applyFieldValidator` (one field, which is what carry-forward needs).
 *
 * ITS OWN MODULE so there is exactly ONE definition of "what may be written to this
 * field". It used to live inside publish-ipc.ts, which was fine while the IPC handler was
 * the only writer; carry-forward.ts is a second writer, and a second writer with its own
 * idea of a valid channelId is how a value nobody would accept over IPC ends up on a
 * record anyway. Importing publish-ipc.ts to reach the table was not an option — that
 * module pulls in `electron`, and the dependency would have pointed backwards.
 */

import { RoutableChannel, findChannelById } from './channel-routing';
import { ChosenMetadata, MAX_TITLE_LENGTH, validatePublishAt } from './publish-types';

/** A short, safe rendering of whatever the caller actually sent. */
export function describeValue(value: unknown): string {
  if (typeof value === 'string') {
    return value.length > 60 ? `${JSON.stringify(value.slice(0, 60))}… (${value.length} chars)` : JSON.stringify(value);
  }
  if (value === null) return 'null';
  if (Array.isArray(value)) return `an array of ${value.length}`;
  if (typeof value === 'object') return 'an object';
  return `${typeof value} ${JSON.stringify(value)}`;
}

/** What a field validator may write. Never the identity fields. */
export type FieldPatch = Partial<Omit<ChosenMetadata, 'itemId' | 'jobId'>>;

/** What a validator is allowed to consult beyond the value itself. */
export interface FieldContext {
  /** The channel registry, read at validation time. */
  listChannels: () => RoutableChannel[];
  /** "Now" for the time-relative rules, so they are testable. */
  now: Date;
}

/**
 * The per-field validator table — Q7, and the reason PR 2 exists as much as the new
 * fields do.
 *
 * What was here before was a loop over a whitelist of key names that copied whatever
 * arrived as long as it was a string or null. That accepted `channelId: "UCnonsense"`,
 * and it would have accepted `publishAt: "next tuesday"` and `isPodcast: "false"` the
 * moment those fields existed — the last of which is truthy, which is exactly the
 * `_is_compilation` bug in a new place.
 *
 * Each entry OWNS its field: it decides the type, the rule, the message, AND what the
 * patch actually contains — which is why publishAt's entry can write two keys. A key
 * with no entry here is REFUSED rather than ignored, because a caller sending a field
 * this doesn't know is a caller whose write is not going to happen, and finding that out
 * silently is worse than being told.
 *
 * Every message names the offending value and the rule it broke. "Invalid field" would
 * be a bug report with no information in it.
 */
const FIELD_VALIDATORS: Record<string, (value: unknown, ctx: FieldContext) => FieldPatch> = {
  /**
   * The whole title-edit map, replaced atomically: generated text -> edited text. An
   * empty object means nothing is edited. Values are trimmed and held to YouTube's
   * title limit here for the same reason chosenTitles are — an over-long edit stored
   * silently would surface as an API refusal weeks later.
   */
  titleEdits(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(
        `titleEdits must be an object mapping generated title text to its edited ` +
        `replacement ({} clears every edit); got ${describeValue(value)}.`
      );
    }
    const cleaned: Record<string, string> = {};
    for (const [original, edited] of Object.entries(value as Record<string, unknown>)) {
      if (!original.trim()) {
        throw new Error('titleEdits keys must be the generated title text; got an empty key.');
      }
      if (typeof edited !== 'string' || !edited.trim()) {
        throw new Error(
          `titleEdits[${JSON.stringify(original)}] must be non-empty replacement text; ` +
          `got ${describeValue(edited)}.`
        );
      }
      const trimmed = edited.trim();
      if (trimmed.length > MAX_TITLE_LENGTH) {
        throw new Error(
          `titleEdits[${JSON.stringify(original)}] is ${trimmed.length} characters; ` +
          `YouTube's title limit is ${MAX_TITLE_LENGTH}.`
        );
      }
      cleaned[original] = trimmed;
    }
    return { titleEdits: cleaned };
  },

  /** null clears the override, restoring the generated description. */
  descriptionOverride(value) {
    if (value !== null && typeof value !== 'string') {
      throw new Error(
        `descriptionOverride must be a string or null (null clears the override and ` +
        `restores the generated description); got ${describeValue(value)}.`
      );
    }
    return { descriptionOverride: value };
  },

  /**
   * Whether the chapter block goes into the composed description. Strict boolean, no null:
   * this field has no "undecided" state — the description either carries the chapters or
   * it does not, and every record has an answer (see ChosenMetadata.chaptersInDescription).
   */
  chaptersInDescription(value) {
    if (typeof value !== 'boolean') {
      throw new Error(
        `chaptersInDescription must be true or false — the chapter block is either in the ` +
        `composed description or it is not, and there is no third state; got ${describeValue(value)}.`
      );
    }
    return { chaptersInDescription: value };
  },

  /** Comma-separated, matching MetadataResult.tags. null clears. */
  tagsOverride(value) {
    if (value !== null && typeof value !== 'string') {
      throw new Error(
        `tagsOverride must be a comma-separated string or null (null clears the override ` +
        `and restores the generated tags); got ${describeValue(value)}.`
      );
    }
    return { tagsOverride: value };
  },

  /**
   * Must be a channel that actually exists in the registry.
   *
   * The check is membership, not shape: "looks like a UC… id" would pass a channel Owen
   * does not own, and the whole point of the field is that a non-null channelId can be
   * handed to the API without a second look. null is legal and means "not routed yet".
   */
  channelId(value, ctx) {
    if (value === null) return { channelId: null };
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(
        `channelId must be a registered channel id or null; got ${describeValue(value)}.`
      );
    }
    const channels = ctx.listChannels();
    if (!findChannelById(value, channels)) {
      const known = channels.length
        ? channels.map((c) => `${c.name} (${c.channelId})`).join(', ')
        : 'none are registered';
      throw new Error(
        `channelId ${JSON.stringify(value)} is not a registered channel. Known channels: ${known}.`
      );
    }
    return { channelId: value };
  },

  /**
   * A schedule, or null to clear it. See validatePublishAt for the four rules.
   *
   * Writes publishAtSetAt ON EVERY SET, INCLUDING THE CLEAR. "When did this stop being
   * scheduled" is as much a question as "when was it scheduled", and a provenance stamp
   * that only exists on one branch answers neither reliably.
   */
  publishAt(value, ctx) {
    const setAt = ctx.now.toISOString();
    if (value === null) return { publishAt: null, publishAtSetAt: setAt };
    if (typeof value !== 'string') {
      throw new Error(
        `publishAt must be an ISO-8601 timestamp with an explicit zone, or null to clear ` +
        `the schedule; got ${describeValue(value)}.`
      );
    }
    const error = validatePublishAt(value, ctx.now);
    if (error) throw new Error(error);
    return { publishAt: value.trim(), publishAtSetAt: setAt };
  },

  /**
   * Strictly boolean. Not truthy, not "true", not 1.
   *
   * A coerced flag is how `_is_compilation` came to mean different things in different
   * readers, and this one decides whether an item is treated as a podcast episode.
   */
  isPodcast(value) {
    if (typeof value !== 'boolean') {
      throw new Error(
        `isPodcast must be exactly true or false; got ${describeValue(value)}. ` +
        `It is never absent and never coerced.`
      );
    }
    return { isPodcast: value };
  },

  /**
   * Monetization: exactly `true`, and nothing else.
   *
   * This entry used to take three values (on / off / undecided) because monetization was
   * a per-item question. It is not one — every video on all three channels is monetized
   * (MONETIZATION_ALWAYS_ON) — so `false` and `null` are refused rather than stored.
   *
   * The entry is KEPT rather than deleted for the sake of the message. Deleting it would
   * make an old caller's `monetize: false` come back as buildFieldPatch's generic "cannot
   * write this field", which reads like a bug in the field table; this says what actually
   * changed and that there is nothing to switch off.
   */
  monetize(value) {
    if (value !== true) {
      throw new Error(
        `monetize can only be true: monetization is on for every video and is no longer a ` +
        `per-item choice, so there is nothing to record. Got ${describeValue(value)}.`
      );
    }
    return { monetize: true };
  },
};

/**
 * Turn a fields object into a patch, or throw naming the field and the rule.
 *
 * Exported for the same reason the validators are a table: this is testable without an
 * ipcMain, and it is the single place a set-fields write is decided.
 */
export function buildFieldPatch(fields: Record<string, unknown>, ctx: FieldContext): FieldPatch {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error(`fields must be an object of field names to values; got ${describeValue(fields)}.`);
  }

  const known = Object.keys(FIELD_VALIDATORS);
  const patch: FieldPatch = {};

  for (const key of Object.keys(fields)) {
    const validator = FIELD_VALIDATORS[key];
    if (!validator) {
      // Not skipped. A field this handler cannot write is a write that is not going to
      // happen, and the caller has to hear that rather than watch a success come back.
      throw new Error(
        `publish-set-fields cannot write ${JSON.stringify(key)}. It accepts: ${known.join(', ')}. ` +
        `(thumbnailPath has its own channel, publish-set-thumbnail, and spreakerAudioPath has ` +
        `publish-set-audio, because both are validated against the file on disk — a path is ` +
        `only half of either value. thumbnailSource is written BY those actions and by ` +
        `automatic discovery, never typed: it records who set the thumbnail, and a caller ` +
        `who could set it separately could claim a hand-picked image was found automatically. ` +
        `spreakerEpisodeId / spreakerPushedAt / spreakerReceipt are ` +
        `written by the upload itself and are not the operator's to type, exactly like ` +
        `pushedAt / pushReceipt.)`
      );
    }
    Object.assign(patch, validator(fields[key], ctx));
  }

  if (Object.keys(patch).length === 0) {
    throw new Error(`nothing to update: fields was empty. It accepts: ${known.join(', ')}.`);
  }
  return patch;
}

/**
 * Run ONE field's validator and return the patch it decides.
 *
 * The single-field door into the same table `buildFieldPatch` walks, for the caller that
 * has one value and needs to know whether it may be written — carry-forward, which reads
 * a field off an EARLIER record and must put it through exactly what a fresh write would
 * face. A record written weeks ago is not evidence about a registry, a file or a schema
 * as they are now.
 *
 * Throws on an unknown field for the same reason buildFieldPatch does: a field this table
 * cannot write is a write that is not going to happen.
 */
export function applyFieldValidator(field: string, value: unknown, ctx: FieldContext): FieldPatch {
  const validator = FIELD_VALIDATORS[field];
  if (!validator) {
    throw new Error(
      `No validator for field ${JSON.stringify(field)}. This table validates: ` +
      `${Object.keys(FIELD_VALIDATORS).join(', ')}.`
    );
  }
  return validator(value, ctx);
}
