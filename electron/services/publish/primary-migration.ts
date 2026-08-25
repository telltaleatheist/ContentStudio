/**
 * Primary Sets — the one-time migration, and the rule it decides by.
 *
 * Every source_key in the app predates the idea of a primary set, and there is no
 * runtime leg that guesses one (primary-set.service.ts: an unrecorded source THROWS).
 * So the answers have to be written down for the reports that already exist, ONCE, with
 * every decision logged — and the rule that writes them has to leave the app publishing
 * exactly what it publishes today.
 *
 * ─── THE RULE ───
 *
 * The primary is the sibling that is FURTHEST ALONG THE PUBLISHING PIPELINE, and where
 * several sit level, the newest of those. In full:
 *
 *   5  the app has actually sent it — pushedAt / uploadReceipt / spreakerPushedAt
 *   4  it is linked to a real video — videoId / filledAt / spreakerEpisodeId
 *   3  it is scheduled — publishAt
 *   2  its A/B titles have been picked — chosenTitles
 *   1  its text has been edited by hand — description / tags / links / title / chapter edits,
 *      or the podcast flag
 *   0  nothing: no record, or a record holding only what the automatic pass put there
 *
 * WHY THIS AND NOT "THE NEWEST", which is what the reports list heads each group with
 * today: the newest is wrong on the real data. Six of the seventeen multi-set sources on
 * this machine carry their YouTube link on an OLDER sibling than the newest run, and one
 * (the live softening case) carries its schedule on the older of two. Making the newest
 * primary would have taken every one of those out of the calendar and out of the
 * extension's reach — silently, because a chip that stops being drawn looks like a chip
 * that was never set.
 *
 * WHY RANK 0 STILL FALLS TO THE NEWEST: when no sibling has been acted on, there is
 * nothing to preserve, and the newest is what the list already heads the group with — so
 * the row the operator has been looking at stays the row he looks at. That is a stated
 * tie-break inside a one-time decision, not a runtime fallback: it is written to disk and
 * logged, and never consulted again.
 *
 * ─── AND AFTERWARDS ───
 *
 * The same sweep runs on every read of the index, but it can only ever CLAIM a source
 * that has no answer at all — which is exactly the "a new set is primary when it is the
 * first one for its source, and is not when siblings already exist" rule. A source whose
 * recorded primary has been DELETED is the one other case it acts on: it re-decides, and
 * says so loudly, because an entry naming an item no report contains would make every
 * consumer of that source refuse.
 */

import { ChosenMetadata } from './publish-types';
import { PrimaryDecidedBy, PrimaryEntry, PrimarySetService } from './primary-set.service';
import { GeneratedItemSummary } from './publish-store.service';

/** How far along the publishing pipeline one set is, and the words for it. */
export interface PublishProgress {
  /** 0-5. Higher wins. See the table at the top of this file. */
  rank: number;
  /** The reason, in the operator's terms, for the log line and the registry file. */
  why: string;
}

/**
 * Read a selection record's progress. Pure, and the only place the ordering is expressed.
 *
 * `channelId` and `thumbnailPath` are deliberately NOT evidence of anything: the automatic
 * pass (auto-config.ts) fills both on the very first write of every record, so every
 * sibling of every source carries them and they distinguish nothing.
 */
export function publishProgressOf(record: ChosenMetadata | null): PublishProgress {
  if (!record) return { rank: 0, why: 'it has no publish record at all' };

  if (record.pushedAt || record.uploadReceipt || record.spreakerPushedAt) {
    return {
      rank: 5,
      why: record.uploadReceipt
        ? 'this app uploaded it'
        : record.pushedAt
          ? `this app pushed it to YouTube on ${record.pushedAt}`
          : `this app pushed it to Spreaker on ${record.spreakerPushedAt}`,
    };
  }
  if (record.videoId || record.filledAt || record.spreakerEpisodeId) {
    return {
      rank: 4,
      why: record.videoId
        ? `it is linked to video ${record.videoId}`
        : record.filledAt
          ? `it was filled into Studio on ${record.filledAt}`
          : `it is linked to Spreaker episode ${record.spreakerEpisodeId}`,
    };
  }
  if (record.publishAt) {
    return { rank: 3, why: `it is scheduled for ${record.publishAt}` };
  }
  if (record.chosenTitles.length > 0) {
    return { rank: 2, why: `its ${record.chosenTitles.length} A/B title(s) have been picked` };
  }

  const edits: string[] = [];
  if (record.descriptionOverride !== null) edits.push('the description');
  if (record.linksOverride !== null) edits.push('the link block');
  if (record.tagsOverride !== null) edits.push('the tags');
  if (Object.keys(record.titleEdits ?? {}).length > 0) edits.push('titles');
  if (Object.keys(record.chapterEdits ?? {}).length > 0) edits.push('chapter titles');
  if ((record.chapterDrops ?? []).length > 0) edits.push('dropped chapters');
  if (record.isPodcast === true) edits.push('the podcast flag');
  if (edits.length > 0) {
    return { rank: 1, why: `the operator has edited ${edits.join(', ')} on it` };
  }

  return { rank: 0, why: 'nothing has been decided about it' };
}

/** One sibling as the decision needs it. */
export interface PrimaryCandidate {
  itemId: string;
  /** ISO. The job's creation time — the tie-break, and what the list already sorts by. */
  createdAt: string;
}

export interface PrimaryDecision {
  itemId: string;
  progress: PublishProgress;
  /** The whole sentence, ready for the log and for the registry file. */
  reason: string;
  /**
   * The other candidates that tied with the winner at the top rank, if any.
   *
   * Reported rather than swallowed: a tie means the decision was made by date and the
   * operator may disagree, and a migration that quietly picked one of two equals is
   * exactly the kind of thing nobody can find afterwards.
   */
  tiedWith: string[];
}

/**
 * Pick the primary among siblings. PURE — the caller supplies the records.
 *
 * `candidates` need not be sorted; this sorts newest-first itself (job creation time, then
 * item id, which is time-sortable — the same order carry-forward and the reports list use)
 * so the tie-break cannot depend on the order a directory happened to be read in.
 */
export function decidePrimary(
  sourceKey: string,
  candidates: PrimaryCandidate[],
  progressOf: (itemId: string) => PublishProgress
): PrimaryDecision {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error(
      `decidePrimary was given no candidates for source ${JSON.stringify(sourceKey)}; a ` +
        `source with no items has nothing to be primary.`
    );
  }

  const ranked = [...candidates]
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '') || b.itemId.localeCompare(a.itemId))
    .map((candidate) => ({ candidate, progress: progressOf(candidate.itemId) }));

  const top = Math.max(...ranked.map((r) => r.progress.rank));
  const tied = ranked.filter((r) => r.progress.rank === top);
  const winner = tied[0]!; // newest-first, so this is the newest of the leaders

  const others = tied.slice(1).map((r) => r.candidate.itemId);
  const reason =
    top === 0
      ? candidates.length === 1
        ? `the only set for this source`
        : `the newest of ${candidates.length} sets, none of which has been acted on`
      : others.length > 0
        ? `the newest of ${tied.length} sets level at the front — ${winner.progress.why}`
        : `${winner.progress.why}` +
          (candidates.length > 1 ? ` (${candidates.length} sets exist for this source)` : '');

  return { itemId: winner.candidate.itemId, progress: winner.progress, reason, tiedWith: others };
}

/** One line of what the sweep did. Every source it touched produces exactly one. */
export interface PrimarySweepEntry {
  sourceKey: string;
  itemId: string;
  previousItemId: string | null;
  decidedBy: PrimaryDecidedBy;
  reason: string;
  tiedWith: string[];
  /** True when the entry that was there named an item no report contains any more. */
  replacedDeletedItem: boolean;
}

export interface PrimarySweepReceipt {
  /** True on the run that wrote the migration stamp, i.e. the one-time pass. */
  migrated: boolean;
  /** Sources that got an answer on this run. Empty on every steady-state call. */
  decided: PrimarySweepEntry[];
  /** Sources that already had an answer and kept it. A count; they are not interesting. */
  unchanged: number;
  /** Items with a null source_key. Always their own primary; never written to the file. */
  ownPrimary: number;
}

export interface PrimarySweepDeps {
  registry: PrimarySetService;
  /** Every generated item, as the host's index reports it. */
  items: GeneratedItemSummary[];
  /** One item's selection record, or null. Throws are the caller's to handle. */
  readRecord: (itemId: string) => ChosenMetadata | null;
  /** Where the decisions go. Injected so this module never imports electron-log. */
  log: (message: string) => void;
}

/**
 * Give every source_key in the index a primary, and leave the ones that have one alone.
 *
 * Cheap when there is nothing to do — a map lookup per source — which is why it can sit
 * on the read path of the index rather than behind a once-per-session gate. A gate would
 * mean a source generated after the gate ran had no answer until the next launch, and
 * every consumer of it would refuse in the meantime.
 *
 * A RECORD THAT WILL NOT PARSE IS NOT A RANK OF ZERO. `readRecord` throwing means the
 * operator's A/B choice is in an unreadable state, and treating that as "nothing has been
 * decided about it" is how a linked set loses primacy to an empty one. It is re-thrown
 * with the source named.
 */
export function ensurePrimarySets(deps: PrimarySweepDeps): PrimarySweepReceipt {
  const { registry, items, readRecord, log } = deps;

  const bySource = new Map<string, PrimaryCandidate[]>();
  let ownPrimary = 0;
  for (const item of items) {
    if (item.sourceKey === null) {
      ownPrimary++;
      continue;
    }
    const bucket = bySource.get(item.sourceKey);
    const candidate = { itemId: item.itemId, createdAt: item.createdAt };
    if (bucket) bucket.push(candidate);
    else bySource.set(item.sourceKey, [candidate]);
  }

  const firstRun = registry.migratedAt() === null;
  const existing = registry.all();
  const decided: PrimarySweepEntry[] = [];
  let unchanged = 0;

  for (const [sourceKey, candidates] of bySource) {
    const current = existing.get(sourceKey) ?? null;
    const stillThere = current !== null && candidates.some((c) => c.itemId === current.itemId);
    if (stillThere) {
      unchanged++;
      continue;
    }

    const progressOf = (itemId: string): PublishProgress => {
      try {
        return publishProgressOf(readRecord(itemId));
      } catch (error) {
        throw new Error(
          `Cannot decide the primary set for source ${JSON.stringify(sourceKey)}: the publish ` +
            `record of ${itemId} could not be read — ` +
            `${error instanceof Error ? error.message : String(error)}`
        );
      }
    };

    const decision = decidePrimary(sourceKey, candidates, progressOf);
    // 'creation' is reserved for what it says: a source appearing in the index for the
    // first time, in steady state, which is a set that has just been generated. The
    // one-time pass and a re-decision after a deletion are both 'migration'.
    const decidedBy: PrimaryDecidedBy = firstRun || current !== null ? 'migration' : 'creation';

    if (current !== null) {
      // The recorded primary is gone from every report. Say it before replacing it.
      log(
        `[Primary] the set recorded as primary for "${sourceKey}" (${current.itemId}) is in no ` +
          `report any more; re-deciding.`
      );
      registry.forget(sourceKey);
    }

    registry.set(sourceKey, decision.itemId, decidedBy, decision.reason);
    decided.push({
      sourceKey,
      itemId: decision.itemId,
      previousItemId: current?.itemId ?? null,
      decidedBy,
      reason: decision.reason,
      tiedWith: decision.tiedWith,
      replacedDeletedItem: current !== null,
    });

    log(
      `[Primary] "${sourceKey}" → ${decision.itemId} (${decidedBy}): ${decision.reason}` +
        (decision.tiedWith.length > 0
          ? ` — tied with ${decision.tiedWith.join(', ')}, broken by generation date`
          : '')
    );
  }

  // Sources the registry knows that the index no longer contains at all (every item of
  // them deleted). Named once, and left: the entry is harmless and the operator may be
  // mid-restore of an output volume.
  for (const [sourceKey] of existing) {
    if (!bySource.has(sourceKey)) {
      log(`[Primary] "${sourceKey}" has a recorded primary but no items in the index.`);
    }
  }

  if (firstRun) {
    registry.markMigrated();
    log(
      `[Primary] one-time migration complete: ${decided.length} source(s) given a primary ` +
        `set, ${ownPrimary} item(s) with no source_key are their own primary by definition.`
    );
  }

  return { migrated: firstRun, decided, unchanged, ownPrimary };
}
