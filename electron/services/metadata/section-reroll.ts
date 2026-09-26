/**
 * Re-roll one section of a finished report — the reports page's per-section buttons (LEDGER #223)
 *
 * WHAT A RE-ROLL IS. The run's OWN prompt for that section, sent again, and the answer put in
 * place of the section. It is "10 more titles" (more-titles.ts, LEDGER #179) for the sections
 * that are not a list to append to: the description (hook and body), the thumbnail text, the
 * pinned comment, and the chapter titles and summaries.
 *
 * REPLAYED, NOT RE-ASSEMBLED, for #179's reason. The prompt a field call sent is a fact the run
 * recorded in `_prompt_trace`, verbatim. Rebuilding it here would rebuild the channel brief, the
 * chapter digest and the transcript from what they say TODAY — a different brief wearing the
 * same name. The stored prompt carries the same inputs the run used, so that is what goes out.
 * An item whose report predates stored prompts is refused in words the page shows; there is no
 * second assembly path. Two things are removed or re-pointed, and both are stated:
 *   - the system turn. Crucible records an upstream (Anthropic) call as `<system>\n\n<prompt>`,
 *     and the door adds the system turn again on the way out, so a replay of that record would
 *     carry it twice. It is taken off when the record starts with it, and only then.
 *   - a chapter's context lines. Each chapter's title call is told the previous chapter's summary
 *     and the last few titles (chaptering/summarize.ts contextLines). Replayed as recorded, those
 *     would name the OLD titles; so the two lines are re-pointed at the titles this re-roll has
 *     just written, rendered by the same function the run used. A prompt that lacks a line the
 *     chain wants is sent as recorded and the result says so.
 *
 * ON THE FIELD'S ROUTED MODEL. The routing table is the only thing that picks a model (LEDGER
 * #204); there is no picker beside these buttons. Description, thumbnail text and pinned comment
 * go to their own rows; the chapter titles to the chapters row, thinking ON (#208's declared
 * default for a title call), on the SAME chapter boundaries: nothing re-finds them.
 *
 * THEN THE SCRUB, as in a run (scrub.ts, #183): the new description and hook, or the new chapter
 * titles, go through the cleanup; thumbnail text and pinned comment are not scrubbed in a run
 * either. A cleanup that fails is recorded like any other (#223) and does not undo the re-roll.
 *
 * THEN, FOR CHAPTERS, THE TAGS AND HASHTAGS, rebuilt in code exactly as the run built them —
 * the same pools from the same chapter list (`chapterPools`), the same assembly
 * (`codeOwnedTagFields`), the channel tags and spacing (`finalizeTagFields`) — because both are
 * derived from the chapter titles. When the transcript the tags are checked against cannot be
 * read, the tags are left as they were and the result says so in words.
 *
 * NOTHING IS LOST. Every replacement pushes the version it replaced onto the item's
 * `reroll_history[<section>]`, newest last, with when, which model and any notes. "Put back"
 * swaps the newest kept version with the one on screen — the one on screen is kept in its place
 * — so pressing it twice returns to where it started and no version ever leaves the record.
 *
 * A FAILED RE-ROLL CHANGES NOTHING. A transport failure, a refusal or an answer that cannot be
 * read throws before anything is written, and the page shows that sentence. The one partial
 * outcome is chapters, which are called one by one as in the run: a chapter whose answer runs
 * out its budget or cannot be read KEEPS ITS CURRENT TITLE and the result names it — the run's
 * own per-chapter policy (Law 3), except that the chapter keeps its title rather than falling
 * to its outline label. If no chapter came back usable, nothing is written.
 *
 * PURE except `rerollFieldText` and `rerollChapterTitles`, which make the calls through the
 * AIManagerService door they are handed.
 */

import log from 'electron-log';

import type { AIManagerService, PlainCallShape } from './ai-manager.service';
import { isCrucibleCallError } from '../../crucible/errors';
import { contextLines, TITLE_MAX_TOKENS } from './chaptering/summarize';
import { loadContextFor } from './context-sizing';
import {
  CALL_TIMEOUT_MS as DESCRIPTION_TIMEOUT_MS,
  HOOK_MAX_CHARS,
  NUM_PREDICT as DESCRIPTION_NUM_PREDICT,
} from './description-unit';
import { LOCAL_FIELD_NUM_PREDICT, LOCAL_FIELD_TIMEOUT_MS } from './metadata-tasks';
import type { MetadataRoutingOption, MetadataRoutingTaskId } from './metadata-routing';
import { parseLeadBody, parseLines, parseTitleDetail } from './plain-call';
import {
  chapterPools,
  codeOwnedTagFields,
  ENTITY_POOL_SIZE,
  PHRASE_POOL_SIZE,
} from './tags-hashtags';
import { stripSpeakerPrefixes } from './transcript-import.service';

// ---------------------------------------------------------------------------
// The sections
// ---------------------------------------------------------------------------

export const REROLL_FIELDS = ['description', 'thumbnail_text', 'pinned_comment', 'chapters'] as const;
export type RerollField = (typeof REROLL_FIELDS)[number];

export function isRerollField(value: unknown): value is RerollField {
  return typeof value === 'string' && (REROLL_FIELDS as readonly string[]).includes(value);
}

/** The routing row each section's re-roll runs on. The table is the only model picker. */
export const REROLL_ROUTING_TASK: Record<RerollField, MetadataRoutingTaskId> = {
  description: 'description',
  thumbnail_text: 'thumbnail_text',
  pinned_comment: 'pinned_comment',
  chapters: 'chapters',
};

/** How the page and the log name each section. */
export const REROLL_FIELD_NAMES: Record<RerollField, string> = {
  description: 'description',
  thumbnail_text: 'thumbnail text',
  pinned_comment: 'pinned comment',
  chapters: 'chapter titles',
};

// ---------------------------------------------------------------------------
// Versions: what a section holds, and the history of what it held
// ---------------------------------------------------------------------------

/** The description as a re-roll replaces it: the body with its link block, and the hook. */
export interface DescriptionSnapshot {
  description: string;
  description_hook: string | null;
}

/**
 * The chapters as a re-roll replaces them: every title and summary by position, and the tags
 * and hashtags that were built from them. Timestamps are not in it — a re-roll never moves one.
 */
export interface ChaptersSnapshot {
  titles: string[];
  details: Array<string | null>;
  tags: string | null;
  hashtags: string | null;
}

export type RerollSnapshot = DescriptionSnapshot | string[] | ChaptersSnapshot;

/** One replacement of a section, and the version it replaced. */
export interface RerollHistoryEntry {
  /** When the replacement was written. */
  at: string;
  /** A re-roll, or the operator putting back a kept version. */
  kind: 're-roll' | 'put back';
  /** The model a re-roll ran on; null for a put-back. */
  model: string | null;
  /** The version this replacement took off the section — kept here so it is never lost. */
  previous: RerollSnapshot;
  /** Everything the replacement did differently from the plan, in plain words. */
  notes: string[];
}

function stringList(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`This report has no ${what} to re-roll.`);
  }
  return (value as string[]).slice();
}

/** What the section holds now, in the shape the history keeps. Throws when the item has none. */
export function snapshotOf(item: any, field: RerollField): RerollSnapshot {
  if (field === 'description') {
    if (typeof item?.description !== 'string' || item.description.trim().length === 0) {
      throw new Error('This report has no description to re-roll.');
    }
    return {
      description: item.description,
      description_hook: typeof item.description_hook === 'string' ? item.description_hook : null,
    };
  }
  if (field === 'thumbnail_text') return stringList(item?.thumbnail_text, 'thumbnail text');
  if (field === 'pinned_comment') return stringList(item?.pinned_comment, 'pinned comment');
  const chapters = item?.chapters;
  if (!Array.isArray(chapters) || chapters.length === 0) {
    throw new Error('This report has no chapters to re-roll.');
  }
  return {
    titles: chapters.map((c: any) => String(c?.title ?? '')),
    details: chapters.map((c: any) => (typeof c?.detail === 'string' ? c.detail : null)),
    tags: typeof item.tags === 'string' ? item.tags : null,
    hashtags: typeof item.hashtags === 'string' ? item.hashtags : null,
  };
}

/** Put a version onto the section. Chapters go back BY POSITION onto the item's own chapters. */
export function applySnapshot(item: any, field: RerollField, snapshot: RerollSnapshot): void {
  if (field === 'description') {
    const s = snapshot as DescriptionSnapshot;
    item.description = s.description;
    if (s.description_hook === null) delete item.description_hook;
    else item.description_hook = s.description_hook;
    return;
  }
  if (field === 'thumbnail_text' || field === 'pinned_comment') {
    item[field] = (snapshot as string[]).slice();
    return;
  }
  const s = snapshot as ChaptersSnapshot;
  const chapters = item.chapters;
  if (!Array.isArray(chapters) || chapters.length !== s.titles.length || s.details.length !== s.titles.length) {
    throw new Error(
      `The chapter version holds ${s.titles.length} title(s) and the item has ` +
        `${Array.isArray(chapters) ? chapters.length : 'no'} chapter(s). Titles go back by position, ` +
        `so nothing was written.`
    );
  }
  item.chapters = chapters.map((chapter: any, index: number) => {
    const next = { ...chapter, title: s.titles[index] };
    if (s.details[index] === null) delete next.detail;
    else next.detail = s.details[index];
    return next;
  });
  if (s.tags === null) delete item.tags;
  else item.tags = s.tags;
  if (s.hashtags === null) delete item.hashtags;
  else item.hashtags = s.hashtags;
}

/** Two versions, compared the only way that matters: the same text or not. */
export function sameSnapshot(a: RerollSnapshot, b: RerollSnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The kept versions of one section, oldest first. Empty when it was never replaced. */
export function historyOf(item: any, field: RerollField): RerollHistoryEntry[] {
  const all = item?.reroll_history;
  const list = all && typeof all === 'object' ? all[field] : undefined;
  return Array.isArray(list) ? list : [];
}

/**
 * Replace a section, keeping the version it replaces.
 *
 * The version on the item is pushed onto `reroll_history[field]` FIRST, then the new one is put
 * in place — so a replacement that throws while being applied (a chapter count that moved)
 * leaves the pushed entry on a copy nobody writes, never on the record.
 */
export function recordReplacement(
  item: any,
  field: RerollField,
  next: RerollSnapshot,
  meta: { at: string; kind: RerollHistoryEntry['kind']; model: string | null; notes: string[] }
): RerollHistoryEntry {
  const entry: RerollHistoryEntry = { ...meta, previous: snapshotOf(item, field) };
  applySnapshot(item, field, next);
  const all = item.reroll_history && typeof item.reroll_history === 'object' ? item.reroll_history : {};
  all[field] = [...historyOf(item, field), entry];
  item.reroll_history = all;
  return entry;
}

/**
 * "Put back": the newest kept version goes back on the section, and the one on screen is kept
 * in its place. The count of kept versions does not change, and nothing leaves the record.
 */
export function putBackPrevious(item: any, field: RerollField, at: string): RerollHistoryEntry {
  const list = historyOf(item, field);
  if (list.length === 0) {
    throw new Error(`There is no earlier ${REROLL_FIELD_NAMES[field]} on this report to put back.`);
  }
  const last = list[list.length - 1];
  item.reroll_history[field] = list.slice(0, -1);
  return recordReplacement(item, field, last.previous, {
    at,
    kind: 'put back',
    model: null,
    notes: [
      `Put back the ${REROLL_FIELD_NAMES[field]} that was replaced on ${last.at}. The version it ` +
        `replaced is kept, and "Put back" again returns to it.`,
    ],
  });
}

// ---------------------------------------------------------------------------
// The stored calls
// ---------------------------------------------------------------------------

/** How the run named each field's call in `_prompt_trace` (metadata-tasks, description-unit). */
export const FIELD_CALL_PREFIX: Record<Exclude<RerollField, 'chapters'>, string> = {
  description: 'the description primary description for ',
  thumbnail_text: 'the thumbnail_text call for ',
  pinned_comment: 'the pinned_comment call for ',
};

export interface StoredCall {
  /** The prompt as the model read it, the recorded system turn taken off (see the header). */
  prompt: string;
  /** The model the run used, as recorded. The re-roll uses the routed one, not this. */
  model: string;
  /** How the run named the video. */
  sourceLabel: string;
  /** True when the record started with the system turn and it was taken off. */
  systemTurnRemoved: boolean;
}

/** A recorded prompt without the system turn Crucible records in front of an upstream call. */
export function withoutSystemTurn(prompt: string, systemTurn: string): { prompt: string; removed: boolean } {
  const head = `${systemTurn}\n\n`;
  if (systemTurn.length > 0 && prompt.startsWith(head)) {
    return { prompt: prompt.slice(head.length), removed: true };
  }
  return { prompt, removed: false };
}

interface TraceEntry {
  what?: unknown;
  model?: unknown;
  prompt?: unknown;
}

function traceOf(item: any): TraceEntry[] {
  return Array.isArray(item?._prompt_trace) ? item._prompt_trace : [];
}

/**
 * The run's own call for one field, or null when this report predates stored prompts. The LAST
 * matching entry wins, for more-titles' reason; a re-roll's own calls are named differently, so
 * a second re-roll replays the run's brief again, not the first re-roll's.
 */
export function findStoredFieldCall(
  item: unknown,
  field: Exclude<RerollField, 'chapters'>,
  systemTurn: string
): StoredCall | null {
  const prefix = FIELD_CALL_PREFIX[field];
  let found: StoredCall | null = null;
  for (const entry of traceOf(item)) {
    if (typeof entry?.what !== 'string' || !entry.what.startsWith(prefix)) continue;
    if (typeof entry.prompt !== 'string' || entry.prompt.length === 0) continue;
    if (typeof entry.model !== 'string' || entry.model.length === 0) continue;
    const bare = withoutSystemTurn(entry.prompt, systemTurn);
    found = {
      prompt: bare.prompt,
      model: entry.model,
      sourceLabel: entry.what.slice(prefix.length),
      systemTurnRemoved: bare.removed,
    };
  }
  return found;
}

/** The refusal for a report with no stored brief for this section, in the page's words. */
export function noStoredCallSentence(field: RerollField): string {
  return (
    `This report does not hold the prompt its ${REROLL_FIELD_NAMES[field]} was written from ` +
    `(it was made before ContentStudio kept them, or by an older way of writing it), so there is ` +
    `nothing to send again. Regenerate the item to give it one.`
  );
}

/** The `what` a re-roll call is logged and traced under — never a run's own name. */
export function rerollWhat(field: string, sourceLabel: string): string {
  return `re-roll button: ${field} for ${sourceLabel} (operator request)`;
}

/** The call's shape: the field call's own, as the run sent it (thinking off). */
export function fieldRerollShape(
  field: Exclude<RerollField, 'chapters'>,
  option: MetadataRoutingOption,
  promptLength: number
): PlainCallShape {
  if (option.kind !== 'local') return { thinking: false };
  const budget = field === 'description' ? DESCRIPTION_NUM_PREDICT : LOCAL_FIELD_NUM_PREDICT;
  return {
    thinking: false,
    maxTokens: budget,
    loadContext: loadContextFor(promptLength, budget),
    timeoutMs: field === 'description' ? DESCRIPTION_TIMEOUT_MS : LOCAL_FIELD_TIMEOUT_MS,
  };
}

/**
 * The answer, read by the field's own reader into the version that replaces the section.
 *
 * The description: one paragraph, the hook measured off its first sentence (parseLeadBody, as
 * the run reads it); the item's own link block is put back beneath the new body, byte for byte.
 * Thumbnail text and pinned comment: one option per line; a count other than the channel's is
 * a note, and every line is kept.
 */
export function readFieldRerollAnswer(
  field: Exclude<RerollField, 'chapters'>,
  text: string,
  what: string,
  model: string,
  context: { linkSuffix: string; expectedCount: number | null }
): { next: RerollSnapshot; notes: string[] } {
  if (field === 'description') {
    const { hook, body } = parseLeadBody(text, what, HOOK_MAX_CHARS + 40);
    return { next: { description: `${body}${context.linkSuffix}`, description_hook: hook }, notes: [] };
  }
  const lines = parseLines(text, what);
  const notes: string[] = [];
  if (context.expectedCount !== null && lines.length !== context.expectedCount) {
    notes.push(
      `The model (${model}) wrote ${lines.length} ${REROLL_FIELD_NAMES[field]} option(s) where the ` +
        `channel asks for ${context.expectedCount}; all ${lines.length} are kept as written.`
    );
  }
  return { next: lines, notes };
}

/** Send one field's stored prompt on the routed model and read it. Throws when unusable. */
export async function rerollFieldText(
  field: Exclude<RerollField, 'chapters'>,
  stored: StoredCall,
  option: MetadataRoutingOption,
  aiManager: AIManagerService,
  context: { linkSuffix: string; expectedCount: number | null }
): Promise<{ next: RerollSnapshot; notes: string[] }> {
  const what = rerollWhat(REROLL_FIELD_NAMES[field], stored.sourceLabel);
  const answer = await aiManager.runPlainRequest(
    stored.prompt,
    option.model,
    what,
    fieldRerollShape(field, option, stored.prompt.length)
  );
  if (!answer) throw new Error(`The model (${option.model}) sent back nothing for the ${REROLL_FIELD_NAMES[field]}.`);
  const read = readFieldRerollAnswer(field, answer, what, option.model, context);
  if (stored.systemTurnRemoved) {
    log.info(`[Reroll] ${what}: the recorded prompt carried the system turn in front; it was sent once, not twice`);
  }
  return read;
}

// ---------------------------------------------------------------------------
// Chapters
// ---------------------------------------------------------------------------

/** One chapter's recorded title call (chaptering/summarize.ts names them). */
export interface StoredChapterCall {
  number: number;
  total: number;
  /** `M:SS-M:SS`, formatClock of the chapter's start and end — the same text as its timestamps. */
  clock: string;
  prompt: string;
  model: string;
  /** How many parts a long chapter was read in; null when one call read it whole. */
  parts: number | null;
  systemTurnRemoved: boolean;
}

/**
 * `chapter 3/26 (4:10-9:55)` or `chapter 3/26 (4:10-9:55) from its 2 parts`. A part's own call
 * (`… part 1/2 (…)`) does not match: a long chapter is re-titled from the parts the run already
 * read, by its combining call.
 */
const CHAPTER_CALL = /^chapter (\d+)\/(\d+) \(([^()]*)\)(?: from its (\d+) parts)?$/;

export function findStoredChapterCalls(item: unknown, systemTurn: string): StoredChapterCall[] {
  const byNumber = new Map<number, StoredChapterCall>();
  for (const entry of traceOf(item)) {
    if (typeof entry?.what !== 'string') continue;
    const m = CHAPTER_CALL.exec(entry.what);
    if (!m) continue;
    if (typeof entry.prompt !== 'string' || entry.prompt.length === 0) continue;
    if (typeof entry.model !== 'string' || entry.model.length === 0) continue;
    const bare = withoutSystemTurn(entry.prompt, systemTurn);
    byNumber.set(Number(m[1]), {
      number: Number(m[1]),
      total: Number(m[2]),
      clock: m[3],
      prompt: bare.prompt,
      model: entry.model,
      parts: m[4] === undefined ? null : Number(m[4]),
      systemTurnRemoved: bare.removed,
    });
  }
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

/**
 * The two context lines of a recorded chapter prompt, pointed at the chain as it stands now.
 * Rendered by the run's own `contextLines`, so the words are the run's.
 */
export function repointChapterContext(
  prompt: string,
  previousDetail: string,
  previousTitles: readonly string[]
): { prompt: string; notes: string[] } {
  const PREVIOUS = 'Previous chapter: "';
  const JUST_BEFORE = 'The chapters just before this one are titled ';
  const wanted = contextLines(undefined, previousDetail, previousTitles)
    .split('\n')
    .filter((line) => line.length > 0);
  const notes: string[] = [];
  const lines = prompt.split('\n');
  for (const prefix of [PREVIOUS, JUST_BEFORE]) {
    const want = wanted.find((line) => line.startsWith(prefix));
    const at = lines.findIndex((line) => line.startsWith(prefix));
    if (at >= 0 && want !== undefined) {
      lines[at] = want;
    } else if (at >= 0 && want === undefined) {
      lines.splice(at, 1);
    } else if (at < 0 && want !== undefined) {
      notes.push(
        prefix === PREVIOUS
          ? 'its recorded prompt had no previous-chapter line, so it was sent without one'
          : 'its recorded prompt did not list the titles before it, so it was sent without them'
      );
    }
  }
  return { prompt: lines.join('\n'), notes };
}

/** One chapter of the video in order, and what the re-roll does with it. */
export interface ChapterRerollStep {
  number: number;
  clock: string;
  /** Its index in `item.chapters`, or null when it is not published (an excluded plug). */
  publishedIndex: number | null;
  /** The recorded call, or null when the run recorded none for this chapter. */
  stored: StoredChapterCall | null;
  /** The chapter's title and summary as the item holds them now (excluded ones included). */
  current: { title: string; detail: string };
}

function clockKey(chapter: any): string | null {
  return typeof chapter?.timestamp === 'string' && typeof chapter?.endTimestamp === 'string'
    ? `${chapter.timestamp}-${chapter.endTimestamp}`
    : null;
}

/**
 * The chain of chapters the run titled, matched to the item's chapters by their times (the
 * recorded clock is formatClock of the same seconds the timestamps were written from), with
 * the published ones re-rolled and the excluded ones carried as context. Throws, in the page's
 * words, when there is nothing to send.
 */
export function planChapterReroll(
  item: any,
  calls: StoredChapterCall[]
): { steps: ChapterRerollStep[]; notes: string[] } {
  if (calls.length === 0) throw new Error(noStoredCallSentence('chapters'));
  const totals = new Set(calls.map((c) => c.total));
  if (totals.size !== 1) {
    throw new Error(
      `This report records chapter title calls for ${[...totals].join(' and ')} chapters at once, so ` +
        `it cannot say which list its chapters came from. Nothing was sent.`
    );
  }
  const total = calls[0].total;
  const published: any[] = Array.isArray(item?.chapters) ? item.chapters : [];
  const excluded: any[] = Array.isArray(item?.excludedChapters) ? item.excludedChapters : [];
  const byNumber = new Map(calls.map((c) => [c.number, c]));
  const notes: string[] = [];
  const steps: ChapterRerollStep[] = [];
  const matched = new Set<number>();

  // The chain runs over every chapter the run titled, 1..total. A chapter with no recorded call
  // is still placed in it by its times when the item has it, so its title stays context.
  const allByClock = new Map<string, { index: number | null; chapter: any }>();
  published.forEach((chapter, index) => {
    const key = clockKey(chapter);
    if (key !== null) allByClock.set(key, { index, chapter });
  });
  excluded.forEach((chapter) => {
    const key = clockKey(chapter);
    if (key !== null && !allByClock.has(key)) allByClock.set(key, { index: null, chapter });
  });

  for (let number = 1; number <= total; number++) {
    const stored = byNumber.get(number) ?? null;
    if (stored === null) continue;
    const found = allByClock.get(stored.clock);
    if (!found) {
      notes.push(
        `Chapter ${number} of the run (${stored.clock}) is not on this report any more, so it was left out.`
      );
      continue;
    }
    if (found.index !== null) matched.add(found.index);
    steps.push({
      number,
      clock: stored.clock,
      publishedIndex: found.index,
      stored,
      current: {
        title: String(found.chapter?.title ?? ''),
        detail: typeof found.chapter?.detail === 'string' ? found.chapter.detail : '',
      },
    });
  }

  published.forEach((chapter, index) => {
    if (!matched.has(index)) {
      notes.push(
        `The chapter at ${chapter?.timestamp ?? '?'} has no recorded title prompt, so it keeps its title.`
      );
    }
  });
  if (matched.size === 0) throw new Error(noStoredCallSentence('chapters'));
  return { steps, notes };
}

/** What the chapter re-roll produced, before the scrub and the tags. */
export interface ChapterRerollResult {
  titles: string[];
  details: Array<string | null>;
  /** How many chapters came back with a new title. */
  rerolled: number;
  notes: string[];
}

/**
 * The published chapters re-titled on the chapters row, one call each in time order, each call's
 * context pointed at the titles just written. See the header for what a failure costs.
 */
export async function rerollChapterTitles(
  item: any,
  steps: ChapterRerollStep[],
  option: MetadataRoutingOption,
  aiManager: AIManagerService,
  context: { sourceLabel: string; thinking: boolean }
): Promise<ChapterRerollResult> {
  const published: any[] = item.chapters;
  const titles = published.map((c) => String(c?.title ?? ''));
  const details: Array<string | null> = published.map((c) => (typeof c?.detail === 'string' ? c.detail : null));
  const notes: string[] = [];
  const chain: Array<{ title: string; detail: string }> = [];
  let rerolled = 0;

  for (const step of steps) {
    let value = step.current;
    if (step.publishedIndex !== null && step.stored !== null) {
      const previous = chain[chain.length - 1];
      const previousDetail = previous ? previous.detail || previous.title : '';
      const previousTitles = chain.slice(-3).map((c) => c.title).filter((t) => t.length > 0);
      const repointed = repointChapterContext(step.stored.prompt, previousDetail, previousTitles);
      for (const note of repointed.notes) notes.push(`Chapter at ${step.clock}: ${note}.`);
      const what = rerollWhat(`chapter ${step.number}/${step.stored.total} (${step.clock})`, context.sourceLabel);
      const prompt = repointed.prompt;
      let answer: string | null = null;
      let kept: string | null = null;
      try {
        answer = await aiManager.runPlainRequest(
          prompt,
          option.model,
          what,
          option.kind === 'local'
            ? {
                thinking: context.thinking,
                maxTokens: TITLE_MAX_TOKENS,
                loadContext: loadContextFor(prompt.length, TITLE_MAX_TOKENS),
              }
            : { thinking: context.thinking }
        );
      } catch (error) {
        // The run's declared reading: a title that runs out its budget costs that one chapter
        // (summarize.ts titleCall). Every other refusal stops the whole re-roll.
        if (!isCrucibleCallError(error, 'truncated')) throw error;
        kept = 'the model ran out of room before it answered';
      }
      if (kept === null && answer === null) kept = 'the model sent back nothing';
      if (kept === null && answer !== null) {
        try {
          const read = parseTitleDetail(answer, `${what} (chapters)`);
          if (read.title.trim().length === 0) throw new Error('the answer had no title line');
          titles[step.publishedIndex] = read.title;
          if (read.detail.length > 0) {
            details[step.publishedIndex] = read.detail;
          } else {
            notes.push(`Chapter at ${step.clock} got a new title but no summary, so it keeps its old summary.`);
          }
          value = { title: read.title, detail: read.detail || step.current.detail };
          rerolled++;
        } catch (error) {
          const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
          kept = `its answer could not be read (${reason})`;
        }
      }
      if (kept !== null) notes.push(`Chapter at ${step.clock} kept its title: ${kept}.`);
    }
    chain.push(value);
  }

  if (rerolled === 0) {
    throw new Error(
      `No chapter came back with a usable title, so nothing was changed. ${notes.join(' ')}`.trim()
    );
  }
  return { titles, details, rerolled, notes };
}

// ---------------------------------------------------------------------------
// Tags and hashtags, rebuilt from the chapter list
// ---------------------------------------------------------------------------

/**
 * The code-owned tag fields for an item whose chapters were just re-rolled — the run's pools
 * (`chapterPools`, same sizes) and the run's assembly (`codeOwnedTagFields`). Whether each field
 * is built is the CHANNEL's statement (its field list), as it is in the run. The channel tags and
 * the spacing are the caller's `finalizeTagFields`.
 */
export function rederiveTagFields(
  item: any,
  contentText: string,
  channelFields: readonly string[],
  brandTag: string | undefined
): { tags?: string; hashtags?: string } {
  const chapters: any[] = Array.isArray(item?.chapters) ? item.chapters : [];
  const text = stripSpeakerPrefixes(contentText);
  const pools = chapterPools({
    subjects: chapters.map((c) => String(c?.title ?? '')),
    details: chapters.map((c) => (typeof c?.detail === 'string' ? c.detail : '')),
    contentText: text,
    entityLimit: ENTITY_POOL_SIZE,
    phraseLimit: PHRASE_POOL_SIZE,
  });
  const titles = Array.isArray(item?.titles) ? item.titles : [];
  const built = codeOwnedTagFields({
    entities: pools.entities,
    phrases: pools.phrases,
    contentText: text,
    firstTitle: typeof titles[0] === 'string' ? titles[0] : undefined,
    videoTitle: typeof item?._title === 'string' ? item._title : '',
    brandTag,
    assembleTags: channelFields.includes('tags') && chapters.length > 0,
    assembleHashtags: channelFields.includes('hashtags'),
  });
  return {
    ...(built.tags === undefined ? {} : { tags: built.tags }),
    ...(built.hashtags === undefined ? {} : { hashtags: built.hashtags }),
  };
}
