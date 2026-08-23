/**
 * Publish Bridge
 *
 * What the companion extension talks to. Exposed over the existing localhost ingest
 * server (127.0.0.1:43117) rather than a second server, so there's still only one port
 * to configure -- but the server only knows a structural interface, so analytics/ and
 * publish/ stay decoupled in both directions.
 *
 * All the matching intelligence lives HERE, not in the extension. The extension reports
 * only what it can see on the page (the videoId from the URL, the original filename from
 * the Studio sidebar) and this decides which generated item that is. That keeps the
 * fragile, hard-to-update half thin and the tested half in the app.
 *
 * Two reader functions are INJECTED by the host rather than imported:
 *   readGenerated  -- one item's generated titles/description/tags
 *   listGenerated  -- an index of every generated item, newest first
 * That is what keeps this directory free of any services/metadata dependency, so the
 * whole publish feature can be lifted into another host (the planned AutoCutStudio
 * merge) by supplying two functions.
 */

import {
  PublishStoreService,
  GeneratedFallback,
  GeneratedIndex,
  GeneratedItemSummary,
  resolveChosenMetadata,
} from './publish-store.service';
import {
  ChosenMetadata,
  MAX_AB_VARIANTS,
  MAX_TITLE_LENGTH,
  PublishStatus,
  emptyChosenMetadata,
  normalizeForMatch,
  validateChosenTitles,
} from './publish-types';

/** One item the extension can fill, with everything it needs to do it. */
export interface PendingFillItem {
  /** The item's permanent id — what every call back into ContentStudio names. */
  itemId: string;
  /** Display back-reference to the run that produced it. Never a lookup key. */
  jobId: string;
  /** Ordered. titles[0] is the main title AND A/B variant 1. */
  titles: string[];
  description: string;
  tags: string;
  sourceFilename: string | null;
  channelId: string | null;
  videoId: string | null;
  status: string;
  /**
   * The operator's monetization intent, three-valued: true = turn it on, false = turn it
   * off, null = no decision recorded, leave Studio's control alone. The Data API cannot
   * write this field at all, which is why it travels to the extension.
   */
  monetize: boolean | null;
  /** Display label for the extension's list. */
  label: string;
}

export interface ResolveOutcome {
  item: PendingFillItem | null;
  reason: string;
  /** True when the item was already explicitly linked to this videoId. */
  linked: boolean;
  /**
   * Set when a report matched but has no titles picked yet, so the shelf knows to open
   * its picker instead of offering a fill it can't perform properly.
   */
  needsTitles: boolean;
}

/**
 * One row in the shelf's report browser.
 *
 * `status: 'none'` is distinct from `'selecting'`: 'none' means no selection record
 * exists at all, 'selecting' means one exists with an empty title set. Collapsing them
 * would hide the difference between "never opened" and "deliberately cleared".
 */
export interface BrowseRow {
  /** The item's permanent id — what opening this row sends back. */
  itemId: string;
  /** Display back-reference to the run that produced it. Never a lookup key. */
  jobId: string;
  label: string;
  createdAt: string;
  promptSet: string | null;
  /** How many titles the generator produced for this item. */
  titleCount: number;
  /** How many the operator has picked. */
  chosenCount: number;
  status: PublishStatus | 'none';
  videoId: string | null;
}

export interface BrowsePage {
  rows: BrowseRow[];
  /** Total matching the query, so the shelf can size its scrollbar without fetching all. */
  total: number;
  offset: number;
  /**
   * Report files that could not be read at all. Reported rather than hidden -- a
   * silently shorter list looks like a complete list.
   */
  unreadable: number;
}

/** Everything the shelf needs to pick titles for one item. */
export interface ItemDetail {
  /** The item's permanent id — what saving titles for it names. */
  itemId: string;
  /** Display back-reference to the run that produced it. Never a lookup key. */
  jobId: string;
  label: string;
  createdAt: string;
  /** EVERY generated title, not just the chosen ones -- this is the picker's source. */
  generatedTitles: string[];
  /** Ordered chosen subset. Empty when nothing is picked yet. */
  chosenTitles: string[];
  description: string;
  tags: string;
  sourceFilename: string | null;
  status: PublishStatus | 'none';
  videoId: string | null;
  /** Monetization intent. null (including "no record at all") means: do not touch it. */
  monetize: boolean | null;
  /** Sent along so the shelf never hard-codes YouTube's limits. */
  maxVariants: number;
  maxTitleLength: number;
}

/**
 * Validation failures are an expected outcome of a shelf click, not an exception --
 * the operator gets the reason in the shelf rather than a 500.
 */
export type SetTitlesResult =
  | { ok: true; item: ItemDetail }
  | { ok: false; errors: string[] };

const MAX_BROWSE_LIMIT = 200;

export class PublishBridge {
  constructor(
    private store: PublishStoreService,
    private readGenerated: (itemId: string) => GeneratedFallback | null,
    private listGenerated: () => GeneratedIndex
  ) {}

  private toPending(itemId: string): PendingFillItem | null {
    const generated = this.readGenerated(itemId);
    if (!generated) return null;

    const chosen = this.store.get(itemId);
    if (!chosen) return null;

    const r = resolveChosenMetadata(chosen, generated);
    return {
      itemId: r.itemId,
      jobId: r.jobId,
      titles: r.titles,
      description: r.description,
      tags: r.tags,
      sourceFilename: r.sourceFilename,
      channelId: r.channelId,
      videoId: r.videoId,
      status: r.status,
      monetize: r.monetize,
      label: r.sourceFilename || r.titles[0] || itemId,
    };
  }

  /** Everything with titles picked that hasn't been published yet. */
  async listPending(): Promise<PendingFillItem[]> {
    const out: PendingFillItem[] = [];
    for (const sel of this.store.listActionable()) {
      const item = this.toPending(sel.itemId);
      if (item) out.push(item);
    }
    return out;
  }

  /**
   * A page of the full report index, so the shelf can reach ANY generated item rather
   * than only the ones already picked. Newest first -- the operator is almost always
   * after something recent, and older pages load as they scroll.
   */
  async listReports(offset: number, limit: number, query: string): Promise<BrowsePage> {
    const index = this.listGenerated();

    const needle = query.trim().toLowerCase();
    const matching = needle
      ? index.items.filter((i) => i.label.toLowerCase().includes(needle))
      : index.items;

    const safeOffset = Math.max(0, Math.floor(offset));
    const safeLimit = Math.min(Math.max(1, Math.floor(limit)), MAX_BROWSE_LIMIT);
    const slice = matching.slice(safeOffset, safeOffset + safeLimit);

    // Only the requested page touches the selection store, so browsing 1,000 reports
    // doesn't mean 1,000 file reads.
    const rows: BrowseRow[] = slice.map((i) => {
      const chosen = this.store.get(i.itemId);
      return {
        itemId: i.itemId,
        jobId: i.jobId,
        label: i.label,
        createdAt: i.createdAt,
        promptSet: i.promptSet,
        titleCount: i.titleCount,
        chosenCount: chosen ? chosen.chosenTitles.length : 0,
        status: chosen ? chosen.status : 'none',
        videoId: chosen ? chosen.videoId : null,
      };
    });

    return { rows, total: matching.length, offset: safeOffset, unreadable: index.unreadable };
  }

  /**
   * Full detail for one item: every generated title plus whatever is already picked.
   * Returns null when the item no longer exists on disk.
   */
  async getItem(itemId: string): Promise<ItemDetail | null> {
    const generated = this.readGenerated(itemId);
    if (!generated) return null;

    const chosen = this.store.get(itemId);
    const summary = this.listGenerated().items.find((i) => i.itemId === itemId);

    const sourceFilename = chosen?.sourceFilename ?? generated.sourceFilename ?? null;
    const generatedTitles = generated.titles ?? [];

    return {
      itemId,
      jobId: generated.jobId,
      label: summary?.label ?? sourceFilename ?? generatedTitles[0] ?? itemId,
      createdAt: summary?.createdAt ?? '',
      generatedTitles,
      chosenTitles: chosen?.chosenTitles ?? [],
      // Same three-input rule resolveChosenMetadata applies, and it has to be the same
      // rule: this is what the browser extension types into Studio, and a description the
      // extension fills that differs from the one the API would push is the exact bug the
      // single-composition-site rule exists to prevent. A record that does not exist yet
      // has made no decision, and the app's decision has always been to include chapters.
      description:
        chosen?.descriptionOverride ??
        (chosen === undefined || chosen === null || chosen.chaptersInDescription
          ? generated.description
          : generated.descriptionWithoutChapters) ??
        '',
      tags: chosen?.tagsOverride ?? generated.tags ?? '',
      sourceFilename,
      status: chosen ? chosen.status : 'none',
      videoId: chosen ? chosen.videoId : null,
      // No selection record means no decision has been made, which is exactly null.
      monetize: chosen ? chosen.monetize : null,
      maxVariants: MAX_AB_VARIANTS,
      maxTitleLength: MAX_TITLE_LENGTH,
    };
  }

  /**
   * Set the chosen title set from the shelf. Order is preserved exactly as sent, because
   * index 0 becomes the video's main title and the variant YouTube keeps if the test is
   * inconclusive.
   *
   * The same validation the reports page goes through -- the shelf is a second entry
   * point to one store, not a second set of rules.
   */
  async setTitles(itemId: string, titles: string[]): Promise<SetTitlesResult> {
    const generated = this.readGenerated(itemId);
    if (!generated) {
      return { ok: false, errors: [`No generated item ${itemId} on disk.`] };
    }

    const cleaned = titles.map((t) => t.trim()).filter(Boolean);
    // An empty set is legal: it's how the operator deselects everything.
    if (cleaned.length > 0) {
      const errors = validateChosenTitles(cleaned);
      if (errors.length) return { ok: false, errors };
    }

    await this.store.update(itemId, generated, {
      chosenTitles: cleaned,
      // Capture the source filename at selection time -- the job's input path may be
      // gone by the time this is filled.
      ...(generated.sourceFilename ? { sourceFilename: generated.sourceFilename } : {}),
    });

    const item = await this.getItem(itemId);
    if (!item) {
      // Cannot happen: readGenerated just succeeded above. Loud rather than a silent null.
      throw new Error(`Saved titles for ${itemId} but could not read it back.`);
    }
    return { ok: true, item };
  }

  /**
   * Given what the extension sees on a Studio details page, decide which item it is.
   *
   * Resolution order, most to least trustworthy:
   *   1. an explicit link to this exact videoId (the operator already confirmed it)
   *   2. an exact normalized-filename match against the Studio sidebar filename
   *   3. nothing -- the shelf shows its report browser rather than guessing
   *
   * Step 1 searches EVERY selection on disk, not just the `ready|linked|filled` ones the
   * pending endpoint serves: an item can be linked to a video while still sitting in
   * `selecting`, and filtering it out made the operator's own confirmed link invisible.
   *
   * Step 2 searches EVERY generated report, not just ones with titles picked: a fresh
   * report whose filename matches is exactly the case where the operator still needs to
   * pick, and refusing to find it would defeat the point.
   *
   * When several reports share the filename -- which regenerating an item guarantees,
   * since every run mints a new item id against the same source_path -- this DISAMBIGUATES
   * rather than refusing (see `disambiguate`), and the reason it returns says which rule
   * fired and how many other reports were in the running. That is a stated decision the
   * operator can see and override from the Reports tab, not a silent guess: nothing is
   * written and nothing is typed into Studio until they click.
   */
  async resolveForPage(videoId: string, filename: string | null): Promise<ResolveOutcome> {
    // Every selection, plus the ones that would not parse. A corrupt file could be the
    // very record linked to this video, so it is named in the reason rather than counted
    // as "nothing matched".
    const { records, faults } = this.store.listAllRecords();
    const notes: string[] = [];
    if (faults.length) {
      notes.push(
        `${faults.length} selection file(s) could not be read (${faults.map((f) => f.itemId).join(', ')})`
      );
    }
    const suffixOf = () => (notes.length ? ` — ${notes.join('; ')}` : '');

    const links = records.filter((r) => r.videoId === videoId);
    if (links.length) {
      // Nothing stops two records naming the same video. The operator's most recent
      // decision stands, and the count travels in the reason.
      const best = [...links].sort(byNewestSelection)[0]!;
      const item = this.toPending(best.itemId);
      if (item) {
        return {
          item,
          reason:
            links.length > 1
              ? `Already linked to this video (${links.length} records name it; showing the most recently updated).${suffixOf()}`
              : `Already linked to this video.${suffixOf()}`,
          linked: true,
          // A linked item with nothing picked still needs picking. Reporting false here
          // is what let the shelf offer a fill that would have typed the generator's
          // top 3 in as if they had been chosen.
          needsTitles: best.chosenTitles.length === 0,
        };
      }
      // The link is real but its report is gone from disk. Say so, then carry on to the
      // filename match -- a regenerated report for the same source is very often exactly
      // what the operator is looking at, and it is named in the reason when it is found.
      notes.push(`the record linked to this video (${best.itemId}) has no report on disk`);
    }

    if (!filename) {
      return {
        item: null,
        reason: `No filename on this page.${suffixOf()}`,
        linked: false,
        needsTitles: false,
      };
    }

    const wanted = normalizeForMatch(filename);
    const byItemId = new Map(records.map((r) => [r.itemId, r]));
    const hits: FilenameCandidate[] = this.listGenerated()
      .items.filter((i) => i.sourceFilename && normalizeForMatch(i.sourceFilename) === wanted)
      .map((summary) => ({ summary, chosen: byItemId.get(summary.itemId) ?? null }));

    if (!hits.length) {
      return {
        item: null,
        reason: `No report matches "${filename}".${suffixOf()}`,
        linked: false,
        needsTitles: false,
      };
    }

    const picked =
      hits.length === 1
        ? { candidate: hits[0]!, why: `Matched "${filename}".` }
        : disambiguate(hits, videoId, filename);

    if (!picked.candidate) {
      return {
        item: null,
        reason: `${picked.why}${suffixOf()}`,
        linked: false,
        needsTitles: false,
      };
    }

    const item = this.toPendingFromGenerated(picked.candidate.summary.itemId);
    if (!item) {
      return {
        item: null,
        reason: `Matched "${filename}" but the report could not be read.${suffixOf()}`,
        linked: false,
        needsTitles: false,
      };
    }

    const chosenCount = picked.candidate.chosen?.chosenTitles.length ?? 0;
    return {
      item,
      reason: `${picked.why}${suffixOf()}`,
      linked: false,
      needsTitles: chosenCount === 0,
    };
  }

  /**
   * Like toPending but works for an item with NO selection record yet, which is what a
   * fresh filename match usually is. Titles fall back to the generator's top 3 exactly
   * as resolveChosenMetadata does, so the shelf shows the same defaults the reports page
   * would.
   */
  private toPendingFromGenerated(itemId: string): PendingFillItem | null {
    const generated = this.readGenerated(itemId);
    if (!generated) return null;

    const chosen =
      this.store.get(itemId) ??
      // No record yet: resolve against a blank one so the fallback rules stay in one place.
      emptyChosenMetadata(itemId, generated.jobId);

    const r = resolveChosenMetadata(chosen, generated);
    return {
      itemId: r.itemId,
      jobId: r.jobId,
      titles: r.titles,
      description: r.description,
      tags: r.tags,
      sourceFilename: r.sourceFilename,
      channelId: r.channelId,
      videoId: r.videoId,
      status: r.status,
      monetize: r.monetize,
      label: r.sourceFilename || r.titles[0] || itemId,
    };
  }

  /**
   * Record that the extension filled Studio fields for an item.
   *
   * Deliberately NOT 'published': filling only puts text in the form. The operator
   * still has to press Save/Publish in Studio, and we can't observe that from here.
   */
  async markFilled(itemId: string, videoId: string): Promise<void> {
    const generated = this.readGenerated(itemId);
    if (!generated) {
      // The extension just filled a Studio form for an item that is not on disk. Saying
      // so is the only useful thing left: writing a record against an item that does not
      // exist would produce a selection nothing could ever reach.
      throw new Error(`Cannot record a fill for ${itemId}: no such generated item.`);
    }
    await this.store.update(itemId, generated, {
      videoId,
      status: 'filled',
      filledAt: new Date().toISOString(),
    });
  }
}

/**
 * One report whose filename matches the Studio page, paired with its selection record
 * (null when the operator has never opened it). The pair is what every disambiguation
 * rule below reads: the report says what was generated, the selection says what the
 * operator decided about it.
 */
interface FilenameCandidate {
  summary: GeneratedItemSummary;
  chosen: ChosenMetadata | null;
}

/**
 * Either a decision plus the sentence that explains it, or a refusal plus the sentence
 * that names the candidates. `why` is never empty — it is what the shelf puts on screen.
 */
type Disambiguation =
  | { candidate: FilenameCandidate; why: string }
  | { candidate: null; why: string };

/**
 * Choose between reports that share one filename.
 *
 * This case is the NORM, not an edge: regenerating an item writes a new report against
 * the same `source_path` and mints a new item id, so a video the operator has re-run four
 * times has four reports with identical filenames. Refusing to choose (the old behaviour)
 * meant the shelf found nothing for exactly the videos that had been worked on most.
 *
 * Refusing is still right when the matcher picks a YOUTUBE VIDEO (video-matcher.ts):
 * writing to the wrong video is destructive. It is wrong here, because picking the wrong
 * REPORT costs a glance — the shelf shows the label, the reason and every title, and
 * nothing reaches Studio until the operator clicks Fill. So this decides, states which
 * rule fired, and leaves the Reports tab as the override.
 *
 * The rules, in order:
 *   1. Drop reports already linked to a DIFFERENT video. They are that video's record.
 *   2. Drop reports that generated NO titles, as long as that leaves something. A report
 *      with an empty titles[] (the per-field CLI runs write these) has nothing to fill.
 *   3. Prefer a report with titles PICKED. Picks do not carry across a regeneration
 *      (carry-forward.ts is explicit about why), so the report holding them is the one
 *      the operator actually worked on. Several picked: the most recently updated.
 *   4. Otherwise the newest report by createdAt.
 *
 * A tie the rules cannot break (identical timestamps) is a refusal naming the candidates,
 * because at that point there is genuinely nothing to choose on.
 */
function disambiguate(
  hits: FilenameCandidate[],
  videoId: string,
  filename: string
): Disambiguation {
  const total = hits.length;
  const shared = `${total} reports share the filename "${filename}"`;

  const elsewhere = hits.filter((h) => h.chosen?.videoId && h.chosen.videoId !== videoId);
  let live = hits.filter((h) => !(h.chosen?.videoId && h.chosen.videoId !== videoId));
  if (!live.length) {
    return {
      candidate: null,
      why: `${shared}, and every one is already linked to a different video (${labelsOf(elsewhere)}).`,
    };
  }

  const titled = live.filter((h) => h.summary.titleCount > 0);
  if (titled.length) live = titled;

  const withPicks = live.filter((h) => (h.chosen?.chosenTitles.length ?? 0) > 0);
  if (withPicks.length === 1) {
    return {
      candidate: withPicks[0]!,
      why: `Matched the one of ${total} reports with this filename that has titles picked.`,
    };
  }
  if (withPicks.length > 1) {
    const newest = onlyNewest(withPicks, (h) => h.chosen!.updatedAt);
    if (!newest) {
      return {
        candidate: null,
        why: `${shared} and ${withPicks.length} were picked at the same moment — open the one you want from Reports (${labelsOf(withPicks)}).`,
      };
    }
    return {
      candidate: newest,
      why: `Matched the most recently picked of ${withPicks.length} reports with picked titles (${total} share this filename).`,
    };
  }

  const newest = onlyNewest(live, (h) => h.summary.createdAt);
  if (!newest) {
    return {
      candidate: null,
      why: `${shared} and carry no date to order them by — open the one you want from Reports (${labelsOf(live)}).`,
    };
  }
  return { candidate: newest, why: `Matched the newest of ${total} reports sharing this filename.` };
}

/**
 * The single newest candidate by `stamp`, or null when the top two are indistinguishable.
 *
 * Null is the point of it: an ISO timestamp two candidates share (or that neither has) is
 * not a tie-break, and treating the array order as one would make the answer depend on
 * readdir. The caller refuses instead.
 */
function onlyNewest<T>(items: T[], stamp: (item: T) => string): T | null {
  const sorted = [...items].sort((a, b) => stamp(b).localeCompare(stamp(a)));
  const best = sorted[0];
  if (!best || !stamp(best)) return null;
  if (sorted.length > 1 && stamp(sorted[1]!) === stamp(best)) return null;
  return best;
}

/** Selection records, most recently updated first. */
function byNewestSelection(a: ChosenMetadata, b: ChosenMetadata): number {
  return (b.updatedAt || '').localeCompare(a.updatedAt || '');
}

/**
 * Candidates as the operator can tell them apart. The label is the same filename on every
 * one of them, so the date and the item id are the only distinguishing facts there are.
 */
function labelsOf(candidates: FilenameCandidate[]): string {
  return candidates
    .map((c) => `${c.summary.itemId} of ${c.summary.createdAt.slice(0, 10) || 'unknown date'}`)
    .join(', ');
}
