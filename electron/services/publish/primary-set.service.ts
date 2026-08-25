/**
 * Primary Set Registry — WHICH generated set is the definitive one for a source.
 *
 * A video can have more than one metadata set. Re-running metadata mints a new item under
 * the same `source_key` (item-identity.ts: two runs over one source are two items, joined
 * by that key), and so does a softening pass. Until now every one of those sets was
 * equally live: the calendar drew a chip for whichever of them carried a schedule, the
 * extension's filename match picked the newest, and nothing in the app could say which set
 * the operator actually meant.
 *
 * This file is that statement. ONE ITEM PER `source_key`, chosen by the operator on the
 * item's own page ("Set as primary"), and it is the set every publishing surface uses.
 *
 * ─── WHY IT IS A FILE OF ITS OWN, AND NOT A FLAG ON THE SELECTION RECORD ───
 *
 * "Primary" is a fact about a SOURCE, not about an item. A boolean on
 * selections/items/<itemId>.json can be true on two siblings at once, and nothing on disk
 * would say which of them was wrong — the invariant "exactly one per source_key" is not
 * expressible there. Here it is the shape of the data: one key, one value.
 *
 * It sits under publish/ beside selections/ for the reason selections do: it is an
 * operator decision about publishing, and the generator's own job records and `.txt` files
 * stay pristine as operator-edit surfaces (LEDGER: report files are never rewritten to
 * carry app state).
 *
 * ─── WHY THE WRITES ARE SYNCHRONOUS, WHERE SELECTIONS' ARE QUEUED ───
 *
 * PublishStoreService serializes its writes through a promise queue because a selection
 * write is a read-modify-write spanning several `await`s (the automatic pass runs inside
 * it), so two of them really can interleave. Every mutation here is one synchronous
 * read-modify-write with no await in it, and Node cannot interleave those. A queue would
 * add a window rather than close one.
 *
 * ─── NO FALLBACK, EVER ───
 *
 * There is no "if no primary is recorded, use the newest" path. A source_key that reaches
 * a consumer without an entry is a fault and `requireEntry` says so, naming the key. What
 * fills the file is an explicit pass over the index (primary-migration.ts) that RECORDS a
 * decision and logs it — writing a decision down is the opposite of substituting one at
 * read time.
 */

import * as fs from 'fs';
import * as path from 'path';
import { isItemId } from './publish-types';

/** How a primary came to be recorded. Carried so the log line and the file agree. */
export type PrimaryDecidedBy =
  /** The operator pressed "Set as primary" on the item's page. */
  | 'operator'
  /** The one-time pass over pre-existing reports (primary-migration.ts). */
  | 'migration'
  /** The first set to exist for a source becomes its primary the moment it is indexed. */
  | 'creation';

/** One source's answer. */
export interface PrimaryEntry {
  /** The join key — `normalizeForMatch(basename)` as the RUN recorded it. */
  sourceKey: string;
  /** The item that is the definitive set for it. */
  itemId: string;
  /** ISO. When this answer was written. */
  decidedAt: string;
  decidedBy: PrimaryDecidedBy;
  /** The sentence the log printed, kept so the file can be read without the log. */
  reason: string;
}

/** What a promotion replaced, so the caller can report it rather than announce a no-op. */
export interface PrimaryChange {
  entry: PrimaryEntry;
  /** The item that was primary before, or null when this source had no answer yet. */
  previousItemId: string | null;
}

const FILE_VERSION = 1;

interface PrimaryFileShape {
  version: number;
  /** ISO of the one-time migration pass, or null when it has never run. */
  migratedAt: string | null;
  entries: Record<string, { itemId: string; decidedAt: string; decidedBy: PrimaryDecidedBy; reason: string }>;
}

export class PrimarySetService {
  private readonly file: string;

  constructor(baseDir: string) {
    if (typeof baseDir !== 'string' || !baseDir.trim()) {
      throw new Error(`PrimarySetService requires a base directory; got ${JSON.stringify(baseDir)}`);
    }
    if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
    this.file = path.join(baseDir, 'primary-sets.json');
  }

  /** Where the answers live, so a refusal can name the file. */
  get filePath(): string {
    return this.file;
  }

  // ------------------------------------------------------------------- io

  /**
   * The file as it stands, or the empty file when it has never been written.
   *
   * A file that will not parse THROWS naming itself. It holds the operator's statement
   * about which set of every video is the real one; reading it as "nothing is primary"
   * would look exactly like a fresh install and the next write would overwrite it.
   */
  private read(): PrimaryFileShape {
    if (!fs.existsSync(this.file)) {
      return { version: FILE_VERSION, migratedAt: null, entries: {} };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      throw new Error(
        `${this.file} could not be read: ${err instanceof Error ? err.message : String(err)}. ` +
          `It records which metadata set is primary for every source, so nothing may act ` +
          `until it is readable.`
      );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${this.file} does not contain a primary-set registry.`);
    }
    const file = parsed as Partial<PrimaryFileShape>;
    if (file.version !== FILE_VERSION) {
      throw new Error(
        `${this.file} is version ${JSON.stringify(file.version)}; this build reads version ` +
          `${FILE_VERSION}. Nothing was read.`
      );
    }
    if (!file.entries || typeof file.entries !== 'object' || Array.isArray(file.entries)) {
      throw new Error(`${this.file} has no entries object.`);
    }
    for (const [key, entry] of Object.entries(file.entries)) {
      if (!entry || typeof entry !== 'object' || !isItemId((entry as any).itemId)) {
        throw new Error(
          `${this.file} records ${JSON.stringify((entry as any)?.itemId)} as the primary set ` +
            `for source ${JSON.stringify(key)}, which is not an item id.`
        );
      }
    }
    return {
      version: FILE_VERSION,
      migratedAt: typeof file.migratedAt === 'string' ? file.migratedAt : null,
      entries: file.entries as PrimaryFileShape['entries'],
    };
  }

  private write(next: PrimaryFileShape): void {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, this.file); // never leave a half-written registry
  }

  // -------------------------------------------------------------- reading

  /** This source's answer, or null when nothing has decided it yet. */
  get(sourceKey: string): PrimaryEntry | null {
    const entry = this.read().entries[sourceKey];
    return entry ? { sourceKey, ...entry } : null;
  }

  /**
   * This source's answer, or a throw naming the key.
   *
   * For the consumers that must not proceed on a guess. There is deliberately no "newest
   * wins" leg: an unrecorded source means the pass that records them has not run, and
   * publishing the wrong one of six sets is worse than refusing to publish any.
   */
  requireEntry(sourceKey: string): PrimaryEntry {
    const entry = this.get(sourceKey);
    if (!entry) {
      throw new Error(
        `No primary metadata set is recorded for source ${JSON.stringify(sourceKey)} in ` +
          `${this.file}. Open the item and press "Set as primary" to say which set is the ` +
          `real one.`
      );
    }
    return entry;
  }

  /** Every answer, keyed by source. */
  all(): Map<string, PrimaryEntry> {
    const file = this.read();
    const out = new Map<string, PrimaryEntry>();
    for (const [sourceKey, entry] of Object.entries(file.entries)) {
      out.set(sourceKey, { sourceKey, ...entry });
    }
    return out;
  }

  /** Has the one-time pass over pre-existing reports run? */
  migratedAt(): string | null {
    return this.read().migratedAt;
  }

  /**
   * Is this item the primary set for its source?
   *
   * `sourceKey === null` is TRUE BY DEFINITION, not by fallback: a text subject and a
   * compilation have no single source file, so `source_key` is null (item-identity.ts),
   * null never joins to null, and an item that cannot have a sibling is the only set there
   * is for what it came from.
   */
  isPrimary(sourceKey: string | null, itemId: string): boolean {
    if (!isItemId(itemId)) {
      throw new Error(`isPrimary needs an item id; got ${JSON.stringify(itemId)}`);
    }
    if (sourceKey === null) return true;
    return this.requireEntry(sourceKey).itemId === itemId;
  }

  // -------------------------------------------------------------- writing

  /**
   * Record an answer, replacing whatever was there. The operator's promotion, and the
   * migration's decision, both come through here.
   */
  set(sourceKey: string, itemId: string, decidedBy: PrimaryDecidedBy, reason: string): PrimaryChange {
    requireSourceKey(sourceKey);
    if (!isItemId(itemId)) {
      throw new Error(`A primary set must be named by an item id; got ${JSON.stringify(itemId)}`);
    }
    const file = this.read();
    const previousItemId = file.entries[sourceKey]?.itemId ?? null;
    const entry = { itemId, decidedAt: new Date().toISOString(), decidedBy, reason };
    file.entries[sourceKey] = entry;
    this.write(file);
    return { entry: { sourceKey, ...entry }, previousItemId };
  }

  /**
   * Record an answer ONLY when the source has none.
   *
   * This is the "a new set becomes primary when it is the first one for its source" rule,
   * and the "and does NOT when siblings already exist" rule, in one call: a source that
   * already has an answer keeps it, and the newcomer stays non-primary until someone
   * promotes it. Returns null when nothing was written, so the caller can log the
   * difference rather than announce a write that did not happen.
   */
  claim(sourceKey: string, itemId: string, decidedBy: PrimaryDecidedBy, reason: string): PrimaryChange | null {
    requireSourceKey(sourceKey);
    if (this.get(sourceKey)) return null;
    return this.set(sourceKey, itemId, decidedBy, reason);
  }

  /** Stamp the one-time pass as done. Separate from the entries so it is auditable. */
  markMigrated(at: string = new Date().toISOString()): void {
    const file = this.read();
    file.migratedAt = at;
    this.write(file);
  }

  /**
   * Forget a source's answer.
   *
   * Used when the item that WAS primary has been deleted — the entry then names an item
   * that is not in any report, and leaving it would make every consumer of that source
   * refuse. The caller re-decides immediately; this is not a delete the operator can reach.
   */
  forget(sourceKey: string): boolean {
    requireSourceKey(sourceKey);
    const file = this.read();
    if (!(sourceKey in file.entries)) return false;
    delete file.entries[sourceKey];
    this.write(file);
    return true;
  }
}

function requireSourceKey(sourceKey: unknown): string {
  if (typeof sourceKey !== 'string' || !sourceKey.trim()) {
    throw new Error(
      `A primary set is recorded against a source_key; got ${JSON.stringify(sourceKey)}. An ` +
        `item with a null source_key (a text subject or a compilation) has no siblings and ` +
        `is its own primary by definition — it is never written here.`
    );
  }
  return sourceKey;
}
