/**
 * Item identity — the primary key for a generated metadata item.
 *
 * Until now an item was identified by its POSITION in `items[]`, which is not an
 * identity at all: it changes when a sibling is deleted, it is shared by every other
 * array the job carries (`original_inputs`, `input_types`, the publish selections map),
 * and nothing validates it at any boundary. See ITEM-ID-PLAN.md §1-2.
 *
 * `item_id` is minted once, in the main process, at the single point where an item first
 * exists on disk (OutputHandlerService.writeItemToJob), and never changes afterwards.
 * It is NOT derived from content, title, filename or position, so none of those can
 * change it, and two runs over the same source produce two different ids — which is the
 * point: they are two different items. The thing that links them is `source_key`.
 */

import * as crypto from 'crypto';
import * as path from 'path';
import { normalizeForMatch } from '../publish/publish-types';

/**
 * Job files carrying identity are `schema_version: 2`. Files without the key are
 * version 1 (positional) and are migrated by report-migration.ts. There is no
 * dual-path reader: after migration, readers REQUIRE item_id.
 */
export const SCHEMA_VERSION = 2;

/** 8 base36 characters of randomness, matching the job id's shape. */
const RANDOM_CHARS = 8;

/**
 * `itm-<epochMs base36>-<8 base36>`.
 *
 * Filename-safe (passes the `^[A-Za-z0-9._-]+$` guard the publish store applies to ids
 * it turns into paths), time-sortable, and visually attributable to a run.
 */
export function mintItemId(now: number = Date.now()): string {
  if (!Number.isFinite(now) || now <= 0) {
    throw new Error(`mintItemId requires a positive epoch-ms timestamp; got ${now}`);
  }

  // crypto rather than Math.random: ids are the join key for publish state, and a
  // duplicate would silently merge two items' selections.
  let random = '';
  while (random.length < RANDOM_CHARS) {
    random += crypto.randomBytes(8).readBigUInt64BE().toString(36);
  }

  return `itm-${Math.floor(now).toString(36)}-${random.slice(0, RANDOM_CHARS)}`;
}

/** Exact shape check. Anything else crossing an IPC boundary is rejected, not coerced. */
export function isItemId(value: unknown): value is string {
  return typeof value === 'string' && /^itm-[0-9a-z]+-[0-9a-z]{8}$/.test(value);
}

/**
 * The regeneration join key for a FILE input: the normalized basename.
 *
 * Deliberately the same normalization video-matcher already applies to YouTube titles
 * and source filenames, so "the same source" means one thing across the app.
 *
 * Text subjects have no source file and get an explicit null from the caller — never a
 * key derived from the subject text, which would join two unrelated topics that happen
 * to start with the same words.
 */
export function sourceKeyOf(sourcePath: string): string {
  if (typeof sourcePath !== 'string' || !sourcePath.trim()) {
    throw new Error('sourceKeyOf requires a non-empty source path');
  }
  const key = normalizeForMatch(path.basename(sourcePath.trim()));
  if (!key) {
    throw new Error(`Source path normalized to an empty key: ${sourcePath}`);
  }
  return key;
}

/**
 * The identity fields written onto every item in a schema_version 2 job file.
 *
 * `txt_path` is the absolute path of the .txt that was actually written, INCLUDING the
 * de-collision suffix — it is the only record of which file belongs to which item, and
 * without it deleting an item either orphans its text (P1) or deletes a sibling job's
 * text along with it (P2), both of which are live today.
 */
export interface ItemIdentity {
  item_id: string;
  txt_path: string | null;
  source_key: string | null;
  source_path: string | null;
}

/** What the generator knows about an item's source at write time. */
export interface ItemSource {
  /** normalizeForMatch(basename) for file inputs; null for text subjects. */
  source_key: string | null;
  /** The path as the user supplied it, for display; null for text subjects. */
  source_path: string | null;
}
