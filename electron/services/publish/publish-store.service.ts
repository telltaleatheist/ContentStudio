/**
 * Publish Store Service
 *
 * Persists the operator's CHOSEN metadata (which 3 titles, plus any description/tags
 * edits) and the link from a generated item to a real YouTube video.
 *
 * Layout, under <userData>/publish/ -- deliberately separate from analytics/:
 *
 *   publish/
 *     selections/items/<itemId>.json   one record, one file
 *     selections/orphaned/             legacy files the migration could not resolve
 *
 * ONE FILE PER ITEM, keyed by the item's permanent id. It used to be one file per JOB,
 * a map keyed by the item's POSITION in items[] -- which meant deleting a mid-job item
 * silently re-pointed every selection above it at the wrong item's titles, and those
 * titles were then served to the extension (ITEM-ID-PLAN.md P4/P5). Under this layout a
 * delete is one unlink and a renumber is not expressible.
 *
 * Kept out of the job's own <jobId>.json on purpose: that file is the raw generator
 * output and should stay pristine, so an item can be regenerated without losing (or
 * silently keeping) a stale selection.
 *
 * All mutations run through a serialized write queue, matching the discipline in
 * OutputHandlerService / AnalyticsStoreService -- the renderer, the IPC layer and the
 * extension's ingest server can all touch this concurrently.
 *
 * NOTHING here recovers from a corrupt record. A selection file that will not parse is
 * the operator's hand-curated A/B choice in an unreadable state; reporting it as "no
 * selection" would look exactly like an item they never opened, and the next write would
 * overwrite it. It throws, naming the file.
 */

import * as fs from 'fs';
import * as path from 'path';
import { AutoConfigResult } from './auto-config';
import { DescriptionSections, composePublishedText } from './publish-types';
import {
  ChosenMetadata,
  ResolvedMetadata,
  PublishStatus,
  TranscriptRef,
  MONETIZATION_ALWAYS_ON,
  emptyChosenMetadata,
  isItemId,
  upgradeStoredMetadata,
  MAX_AB_VARIANTS,
} from './publish-types';

/** The generated values a selection falls back to. Supplied by the caller so this
 *  module never has to import from services/metadata. */
export interface GeneratedFallback {
  /**
   * The run that produced this item. Carried on the generated values because the store
   * records it as a display back-reference, and the reader is the only thing that knows
   * which report file the item came out of.
   */
  jobId: string;
  titles: string[];
  /**
   * The composed description WITH the chapter block, which is what the app has always
   * pushed and still is unless the operator turned chapters off on this item.
   */
  description: string;
  /**
   * The same composition with the chapter block left out.
   *
   * Both are carried rather than one being derived from the other, because deriving means
   * STRIPPING a block back off a finished string, and a strip that matches slightly too
   * much or too little corrupts the description it is editing. The composer is the only
   * thing that knows where the block ends; it produces both.
   */
  descriptionWithoutChapters: string;
  /**
   * The chapter block on its own, '' when the item has no chapters.
   *
   * Read by the panel to decide whether the chapters switch is MEANINGFUL for this item.
   * A switch on an item with no chapters is a control that cannot do anything.
   */
  chapterBlock: string;
  /**
   * The three-section decomposition (2026-08-25): body / chapters / links, the shapes the
   * operator edits and composePublishedText joins. Filled by the reader from the same
   * composer that produces the strings above; carried as data so this module stays free
   * of services/metadata.
   */
  sections: DescriptionSections;
  tags: string;
  /** Basename of the analyzed source file, when the host can determine it. */
  sourceFilename?: string | null;
  /**
   * FULL path to the analyzed source file, when the host can determine it.
   *
   * Distinct from sourceFilename, which is a basename for matching a YouTube title. This
   * is the one thing that can locate the item's week on disk, and therefore the only
   * input the thumbnail proposal has (<week>/complete/<slot> - <label>.mov beside
   * <week>/thumbnails/<slot> - youtube-thumbnail.png). null for a text subject or a
   * compilation, both of which have no single source file and therefore no proposal.
   */
  sourcePath?: string | null;
  /**
   * The prompt set the RUN was generated with, as the job JSON recorded it, or null.
   *
   * Carried for ONE reason: it is the operator's channel choice, made before generation
   * and already written down, and automatic routing is the app reading it back rather
   * than asking him for it again (auto-config.ts). Read off the job, never inferred from
   * anything else — a prompt set guessed from a title or a folder would route a video to
   * a channel nobody chose.
   */
  promptSet?: string | null;
  /** Source duration in seconds, when known. null just means the match is unverified. */
  sourceDurationSec?: number | null;
  /**
   * The editor-story link the RUN honored, read off the item's `content_provenance`, or
   * null when the run was final-export only.
   *
   * This is the seed for `ChosenMetadata.transcriptRef`, and the two are different kinds
   * of fact: the report's ref is the immutable record of what a past run generated from,
   * while the selection's is the operator's durable choice, which he can change and which
   * regeneration carries forward (spec §3.5). Seeding happens ONCE, when the record is
   * created; an existing value is never overwritten from a report.
   *
   * Absent (rather than null) for items written before provenance existed — nothing to
   * seed from, which is not the same as "the run declared final-only".
   */
  transcriptRef?: TranscriptRef | null;
}

/**
 * What a NEW selection record is created from.
 *
 * Structurally a subset of GeneratedFallback, so every caller can simply pass the
 * generated item it already had to read. It replaces the bare `jobId` argument
 * deliberately: creation is the only moment `transcriptRef` may be seeded, and a
 * signature that took just the id let every caller create records that silently missed
 * the seed. Now a caller cannot supply the id without being in a position to supply
 * the rest.
 */
export interface SelectionSeed {
  jobId: string;
  transcriptRef?: TranscriptRef | null;
  /**
   * The two facts automatic configuration reads (auto-config.ts). Optional here for the
   * same reason the rest of GeneratedFallback's optional fields are: a caller that cannot
   * determine them passes nothing, and the auto pass says so in its log line rather than
   * inventing either.
   */
  promptSet?: string | null;
  sourcePath?: string | null;
}

/**
 * The automatic pass over a record — auto-config.autoConfigure, injected.
 *
 * INJECTED, not imported, and the reason is the channel registry: routing needs
 * channels.json, which lives in services/analytics, and this store has no business
 * reaching for it. The host binds the registry reader into this function once (see
 * ipc-handlers.ts) and the store simply calls it, exactly as publish-ipc receives
 * `readGenerated` rather than importing the report reader.
 */
export type AutoConfigure = (input: {
  record: ChosenMetadata;
  promptSet: string | null;
  sourcePath: string | null;
}) => AutoConfigResult;

/**
 * One entry in the host's index of generated items -- enough to list and search without
 * loading the full metadata for every report. Cheap fields only.
 */
export interface GeneratedItemSummary {
  /** The item's permanent id. The only field here that is an identity. */
  itemId: string;
  /** Display back-reference to the run that produced it. Never a lookup key. */
  jobId: string;
  /** What the operator recognises it by: source filename, else job name, else title. */
  label: string;
  /** ISO. The job's creation time, so the index can be sorted newest-first. */
  createdAt: string;
  promptSet: string | null;
  /** Basename of the analyzed source file, used for filename matching. */
  sourceFilename: string | null;
  /**
   * The regeneration join key: `normalizeForMatch(basename)` of the source file, recorded
   * by the RUN (item-identity.ts §sourceKeyOf), or null for a text subject or a
   * compilation — inputs that have no single source file.
   *
   * Carried on the summary because it is what tells two items apart from two runs of the
   * same video, and carry-forward.ts is the only thing that needs it. Never derived here:
   * a key computed on read would disagree with the one the run recorded the moment the
   * normalization changed, and the join would quietly stop matching.
   *
   * null NEVER matches null. Every text subject in the app records null, and treating
   * that as equality would join all of them to each other.
   */
  sourceKey: string | null;
  /** How many titles the generator produced. */
  titleCount: number;
}

/**
 * The full index, newest first.
 *
 * `unreadable` is a COUNT, not a silent omission: a browse list that is quietly short
 * looks exactly like a complete one, so the number of reports that failed to parse
 * travels with the data and gets shown.
 */
export interface GeneratedIndex {
  items: GeneratedItemSummary[];
  unreadable: number;
}

/**
 * One row of the HOST's report index: the summary above plus the facts a browse list
 * needs — which file the item lives in, where in it, and what to print.
 *
 * Declared here, beside GeneratedItemSummary, for the reason that type is here: the
 * report FORMAT is the host's business (services/metadata/report-index.ts), and publish/
 * receives the result through an injected function rather than importing the reader. The
 * host's row satisfies this structurally.
 */
export interface HostReportRow extends GeneratedItemSummary {
  /** Absolute path of the job JSON this item lives in. */
  jobPath: string;
  jobSizeBytes: number;
  /** Position within items[] — for reading the array, never an identity. */
  itemIndex: number;
  /** What the list prints for this item. */
  displayTitle: string;
  txtFolder: string | null;
  txtFilePath: string | null;
  /** ISO. What the list sorts and prints by. */
  dateIso: string;
}

/** The host's whole report index, with the files it could not read named. */
export interface HostReportIndex {
  rows: HostReportRow[];
  problems: Array<{ file: string; message: string }>;
  directoryMissing: boolean;
  directory: string;
}

/** What clearing a whole job's selections actually did. */
export interface JobSelectionClear {
  /** Files unlinked. */
  removed: number;
  /**
   * Files that could not be read, and were therefore LEFT: a record we cannot attribute
   * to a job is not a record to delete on that job's behalf. Named, never counted away.
   */
  unreadable: string[];
}

export class PublishStoreService {
  private readonly baseDir: string;
  private readonly selectionsDir: string;
  private readonly itemsDir: string;
  private readonly autoConfigure: AutoConfigure;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(baseDir: string, autoConfigure: AutoConfigure) {
    if (typeof autoConfigure !== 'function') {
      throw new Error(
        'PublishStoreService requires an autoConfigure function. Every write is the moment ' +
        'a record can be routed to its prompt set\'s channel and given its exported ' +
        'thumbnail; a store constructed without it would write records that are silently ' +
        'never auto-configured, and nothing downstream could tell that apart from an item ' +
        'whose prompt set no channel claims.'
      );
    }
    this.autoConfigure = autoConfigure;
    this.baseDir = baseDir;
    this.selectionsDir = path.join(baseDir, 'selections');
    this.itemsDir = path.join(this.selectionsDir, 'items');
    if (!fs.existsSync(this.itemsDir)) {
      fs.mkdirSync(this.itemsDir, { recursive: true });
    }
    console.log('[PublishStore] Initialized:', this.baseDir);
  }

  /** Where the per-item records live. The migration writes into this same directory. */
  get selectionsItemsDir(): string {
    return this.itemsDir;
  }

  // ---------------------------------------------------------------- paths / io

  private itemPath(itemId: string): string {
    // Item ids are app-minted, but they reach us over IPC and over the extension's HTTP
    // routes, and they are turned into filenames. An id that is not exactly the minted
    // shape is refused rather than sanitized -- a coerced id names a different record.
    if (!isItemId(itemId)) {
      throw new Error(`Invalid item id: ${JSON.stringify(itemId)}`);
    }
    return path.join(this.itemsDir, `${itemId}.json`);
  }

  private readItemFile(itemId: string): ChosenMetadata | null {
    const file = this.itemPath(itemId);
    if (!fs.existsSync(file)) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(
        `Selection file ${file} could not be read: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Selection file ${file} does not contain a selection record.`);
    }
    const record = parsed as ChosenMetadata;
    if (record.itemId !== itemId) {
      // The filename and the record disagree about which item this is. One of them is
      // wrong and there is no way to tell which, so neither is used.
      throw new Error(
        `Selection file ${file} records item ${JSON.stringify(record.itemId)} — the file name and its contents disagree.`
      );
    }
    // Fields added after this record was written get the value they would have been born
    // with. See upgradeStoredMetadata: a one-way schema upgrade, not a repair — anything
    // present is returned exactly as stored.
    return upgradeStoredMetadata(record);
  }

  private writeItemFile(record: ChosenMetadata): void {
    const file = this.itemPath(record.itemId);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
    fs.renameSync(tmp, file);  // atomic-ish: never leave a half-written selection file
  }

  /** Every item id with a record on disk. */
  private listItemIds(): string[] {
    return fs
      .readdirSync(this.itemsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''));
  }

  // ------------------------------------------------------------------- reading

  /** One item's selection, or null when the operator has never touched it. */
  get(itemId: string): ChosenMetadata | null {
    return this.readItemFile(itemId);
  }

  /**
   * Every selection that is far enough along for the extension to act on.
   * This is what backs the extension's pending-work endpoint.
   */
  listActionable(): ChosenMetadata[] {
    const actionable: PublishStatus[] = ['ready', 'linked', 'filled'];
    const out: ChosenMetadata[] = [];
    for (const itemId of this.listItemIds()) {
      // Not caught: an unreadable selection is a fault to report, not a row to drop.
      // A silently short pending list is indistinguishable from an empty in-tray.
      const record = this.readItemFile(itemId);
      if (record && actionable.includes(record.status)) out.push(record);
    }
    return out;
  }

  /**
   * EVERY selection on disk, plus the ones that could not be read.
   *
   * The calendar's source. Deliberately not `listActionable()`, which filters to
   * `ready|linked|filled` for the extension's pending-work endpoint: the calendar's whole
   * left rail is the items the operator has NOT finished with, and those sit in
   * `selecting`. Filtering them out would have made the unscheduled tray permanently
   * empty and the omission invisible.
   *
   * A record that will not parse is returned as a FAULT, named, rather than thrown or
   * skipped. Throwing would blank a calendar of forty rows because one file is corrupt;
   * skipping would show thirty-nine rows that look like all of them. The caller renders
   * the fault beside the grid.
   */
  listAllRecords(): { records: ChosenMetadata[]; faults: Array<{ itemId: string; message: string }> } {
    const records: ChosenMetadata[] = [];
    const faults: Array<{ itemId: string; message: string }> = [];
    for (const itemId of this.listItemIds()) {
      let record: ChosenMetadata | null;
      try {
        record = this.readItemFile(itemId);
      } catch (err) {
        faults.push({ itemId, message: err instanceof Error ? err.message : String(err) });
        continue;
      }
      if (record) records.push(record);
    }
    return { records, faults };
  }

  // ------------------------------------------------------------------- writing

  /**
   * Read-modify-write a single selection, serialized against every other mutation.
   * Creates the record if it doesn't exist yet.
   *
   * `seed` matters for the create case only -- its `jobId` is the record's display
   * back-reference and its `transcriptRef` is the Phase-2 choice this item's run already
   * made. It is the generated item the caller just read, so it is always the job the
   * item actually came from.
   *
   * SEEDING HAPPENS ONCE. On an existing record the seed's transcriptRef is ignored
   * entirely: the stored value is the operator's, and a later read of the report must not
   * be able to reinstate a link he has since changed or cleared.
   *
   * EVERY WRITE ALSO RUNS THE AUTOMATIC PASS (auto-config.ts), and it runs here rather
   * than at each of the six call sites for two reasons. The first is that there is then
   * one door: an item cannot be auto-routed when the reports page saves it and left
   * unrouted when the extension's shelf does. The second is atomicity — the channel and
   * the thumbnail land on the SAME file write as whatever the operator was actually
   * doing, instead of a second write that could half-succeed and leave a record claiming
   * a channel nobody's action put there.
   *
   * The pass runs AFTER the caller's patch is merged and can only fill fields that are
   * still unanswered, so an explicit write always wins over the automatic one — including
   * an explicit write of null. It is not run on a read, ever: reads do not write, and an
   * item nobody has touched is meant to look untouched.
   */
  update(
    itemId: string,
    seed: SelectionSeed,
    patch: Partial<Omit<ChosenMetadata, 'itemId' | 'jobId'>>
  ): Promise<ChosenMetadata> {
    const run = this.writeQueue.then(() => {
      if (!seed || typeof seed !== 'object' || typeof seed.jobId !== 'string' || !seed.jobId.trim()) {
        throw new Error(
          `update requires the item's generated record as its seed ({ jobId, transcriptRef }); ` +
          `got ${JSON.stringify(seed)}`
        );
      }
      const jobId = seed.jobId;

      const existing = this.readItemFile(itemId) ?? this.createRecord(itemId, seed);

      const merged: ChosenMetadata = {
        ...existing,
        ...patch,
        itemId,
        jobId,
        updatedAt: new Date().toISOString(),
      };

      const auto = this.autoConfigure({
        record: merged,
        promptSet: seed.promptSet ?? null,
        sourcePath: seed.sourcePath ?? null,
      });
      // Every branch is announced, applied or not. An automatic decision nobody can find
      // afterwards is the thing this codebase refuses to ship: "why is this on Fireside?"
      // has to have an answer in the log, and so does "why did it not pick up my image?".
      for (const d of auto.applied) console.log(`[PublishStore] ${itemId} ${d.field}: ${d.detail}`);
      for (const d of auto.refused) console.error(`[PublishStore] ${itemId} ${d.field} REFUSED: ${d.detail}`);
      for (const d of auto.skipped) console.log(`[PublishStore] ${itemId} ${d.field} not set: ${d.detail}`);

      const next: ChosenMetadata = { ...merged, ...auto.patch };

      if (next.chosenTitles.length > MAX_AB_VARIANTS) {
        throw new Error(
          `Cannot store ${next.chosenTitles.length} titles; YouTube allows ${MAX_AB_VARIANTS} A/B variants.`
        );
      }

      // Status is derived unless the caller set it explicitly: picking titles makes an
      // item 'ready', clearing them drops it back to 'selecting'. Never downgrade a
      // linked/filled/published record just because titles were edited.
      if (patch.status === undefined) {
        const terminal: PublishStatus[] = ['linked', 'filled', 'published'];
        if (!terminal.includes(next.status)) {
          next.status = next.chosenTitles.length > 0 ? 'ready' : 'selecting';
        }
      }

      this.writeItemFile(next);
      return next;
    });

    // Keep the chain alive on failure so one bad write doesn't poison later ones.
    this.writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * The blank record for an item that has none yet, with the one field the RUN already
   * decided filled in.
   *
   * `transcriptRef` starts as the link that generated this item, because that is the
   * operator's most recent statement about it -- he made it on the Inputs page minutes
   * ago -- and a publish panel that showed "not linked" for an item whose words came from
   * an editor story would be showing him a contradiction. `undefined` in the seed (an
   * item written before provenance existed) leaves the null emptyChosenMetadata wrote.
   */
  private createRecord(itemId: string, seed: SelectionSeed): ChosenMetadata {
    const record = emptyChosenMetadata(itemId, seed.jobId);
    if (seed.transcriptRef) {
      record.transcriptRef = seed.transcriptRef;
    }
    return record;
  }

  /**
   * Forget one item's selection: one unlink.
   *
   * This replaces `clear(jobId, itemIndex)` AND the `removeIndexAndShift` bridge that
   * PR A needed while selections were still index-keyed. There is no shift, because
   * there is no longer anything a sibling's deletion could move.
   */
  clearItem(itemId: string): Promise<{ removed: boolean }> {
    const run = this.writeQueue.then(() => {
      const file = this.itemPath(itemId);
      if (!fs.existsSync(file)) return { removed: false };
      fs.unlinkSync(file);
      return { removed: true };
    });
    this.writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Forget every selection belonging to a job (used when a job is deleted from history).
   *
   * The job is no longer a directory entry, so this is a scan-and-match over the records'
   * `jobId` back-reference rather than a single unlink. A record that cannot be read is
   * LEFT and NAMED: it might belong to this job or to another one, and deleting a file we
   * could not attribute is exactly the class of bug this whole layout exists to end.
   */
  clearItemsOfJob(jobId: string): Promise<JobSelectionClear> {
    const run = this.writeQueue.then(() => {
      if (typeof jobId !== 'string' || !jobId.trim()) {
        throw new Error(`clearItemsOfJob requires a non-empty jobId; got ${JSON.stringify(jobId)}`);
      }

      const result: JobSelectionClear = { removed: 0, unreadable: [] };
      for (const itemId of this.listItemIds()) {
        let record: ChosenMetadata | null;
        try {
          record = this.readItemFile(itemId);
        } catch (err) {
          result.unreadable.push(
            `${itemId}.json (${err instanceof Error ? err.message : String(err)})`
          );
          continue;
        }
        if (!record || record.jobId !== jobId) continue;
        fs.unlinkSync(this.itemPath(itemId));
        result.removed++;
      }
      return result;
    });
    this.writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }
}

/**
 * Merge a stored selection with the generated values it falls back to.
 *
 * `descriptionOverride` / `tagsOverride` of null mean "the operator didn't edit this",
 * so the current generated value wins -- that way regenerating an item flows through
 * instead of silently serving a stale copy.
 *
 * Pure function, and it takes the generated values as an argument rather than importing
 * them, which is what keeps this module independent of services/metadata.
 */
export function resolveChosenMetadata(
  chosen: ChosenMetadata,
  generated: GeneratedFallback
): ResolvedMetadata {
  // Fall back to the generator's top-3 when the operator hasn't picked yet -- the
  // prompts already order titles with the first three intended as A/B variants.
  const titles = chosen.chosenTitles.length
    ? chosen.chosenTitles
    : (generated.titles || []).slice(0, MAX_AB_VARIANTS);

  return {
    itemId: chosen.itemId,
    jobId: chosen.jobId,
    channelId: chosen.channelId,
    videoId: chosen.videoId,
    titles,
    // THREE inputs, in a fixed order of authority:
    //   1. the operator's edited text, which wins over composition entirely;
    //   2. otherwise the composed description, chapters included;
    //   3. unless the operator switched chapters off for this item.
    // An override is deliberately NOT re-composed: it is the literal string the operator
    // saved, and quietly re-prefixing it would either duplicate a chapter block it already
    // contains or reinstate one they deleted by hand.
    // The three-section composition (2026-08-25): the record's section edits — body
    // override, chapter renames/deletes, links override, the chapters switch — applied to
    // the generated sections by the ONE join in publish-types.
    description: composePublishedText(generated.sections, chosen),
    // Raw generated sections, edits not applied — the reports page renders its three
    // editors from these plus the record it already holds.
    sections: generated.sections,
    tags: chosen.tagsOverride ?? generated.tags ?? '',
    // Stored value wins (it was captured at selection time); otherwise fall back to
    // whatever the host can still determine from the job.
    sourceFilename: chosen.sourceFilename ?? generated.sourceFilename ?? null,
    sourceDurationSec: chosen.sourceDurationSec ?? generated.sourceDurationSec ?? null,
    status: chosen.status,
    // WHETHER, not where. The extension is the consumer and cannot open a file on
    // Callisto; it asks the app for the bytes when this is true.
    hasThumbnail: chosen.thumbnailPath !== null,
    // The constant, not the record's copy of it. Monetization is not a per-item decision
    // any more (MONETIZATION_ALWAYS_ON), and reading it off a record would be the one
    // place a legacy `false` could still escape to the extension.
    monetize: MONETIZATION_ALWAYS_ON,
  };
}
