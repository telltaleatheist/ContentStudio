/**
 * Distilled channel guidelines — the analytics loop's second stage
 *
 * WHAT CHANGED AND WHY (operator, 2026-08-24). The CHANNEL PERFORMANCE DATA block used to
 * ride into every insight-carrying generation call whole: ~6k characters of OTHER videos'
 * literal titles and their numbers. That stretches the generation call's context toward its
 * limit and seeds it with unrelated subjects — the same measured leak risk that keeps the
 * chapter prompt's examples nameless, here multiplied by eight top and five bottom titles a
 * run. His design: "send the titles/other data in as an independent call and have it write a
 * list of things we can learn from the winners and losers, and send those guidelines along
 * in the next actual call."
 *
 * So the flow is now two-stage:
 *
 *   evidence (buildInsightsBlock — the raw render stays as the distiller's input and the
 *   operator's inspection surface; since 2026-10-21 it is dated and carries the last 90
 *   days' uploads and decided A/B tests, none of which reaches generation except through
 *   the lessons)
 *     → ONE plain-text distillation call, per channel, only when the evidence changed
 *     → guidelines.json beside insights.json  { generatedAt, model, sourceHash, lines }
 *     → the COMPACT block generation actually carries: the A/B title rules verbatim (already
 *       distilled, Law-5-sanctioned), the one baselines line, and the lessons.
 *
 * THE CACHE IS THE COMMON PATH. `sourceHash` is the sha256 of the exact rendered evidence the
 * distiller read; at generation time the current render is hashed and compared, and a match
 * uses the stored lines with no call at all. The evidence only moves when the collector or a
 * distillation run rewrites insights.json, so most runs never pay the call.
 *
 * THE TESTED PATTERNS (2026-10-21, Owen: "we create five additional titles that follow test
 * patterns ... like the claim in the title, or dry humor"). From the SAME evidence render, a
 * second distillation call (insights.yml `pattern_distiller`) names exactly TITLE_PATTERN_COUNT
 * title patterns, each a 2-5 word name and one line saying how to write a title in it; the
 * tested-pattern titles call (metadata/pattern-titles.ts) writes one title in each. A second
 * call rather than one call answering both, so the lessons' answer keeps its shape ("- " lines)
 * and each answer has one strict reader. They are cached in the same guidelines.json under
 * `patterns`, with their OWN sourceHash, so lessons and patterns go stale independently; a
 * guidelines.json written before patterns existed has no `patterns` and reads as STALE, so the
 * next real run distills them (a dry run shows the placeholder), never as an empty list.
 * Nothing is hand-coded: LEDGER #319 measured the shape Owen likes at 4 won / 6 lost on
 * Telltale, so the patterns come from the evidence or not at all.
 *
 * WHAT PREPARE RETURNS CROSSES A LAYER. `prepareChannelInsights` runs at the two producer
 * sites (ipc-handlers, the CLI), where the analytics store lives; the resolution — cache hit,
 * dry run, or the one call — runs inside metadata generation, where the routed transports
 * live. The PreparedChannelInsights object is that typed hand-off (law 10), and it carries a
 * `save` closure rather than the store itself so the generation layer never learns the
 * store's shape.
 */

import * as crypto from 'crypto';
import * as log from 'electron-log';
import { ChannelGuidelines, ChannelInsights, CrossChannelInsights } from './analytics-types';
import { TITLE_PATTERN_COUNT, type TitlePattern } from '../metadata/pattern-titles';
import { AnalyticsStoreService } from './analytics-store.service';
import { buildInsightsBlock } from './insights-prompt';
import { renderAbTitleRulesBlock } from './ab-title-rules';
import { promptAssets } from '../metadata/prompt-assets';
import { formatPrompt } from '../metadata/system-prompts';

/** "5.3%" / "n/a" — same rendering the raw block uses, restated here for the one line kept. */
function pct(value: number | null): string {
  return value === null ? 'n/a' : `${Math.round(value * 10) / 10}%`;
}

export interface PreparedChannelInsights {
  channelId: string;
  channelName: string;
  /** The FULL evidence render — the distiller's exact input, and what a debug surface shows. */
  rawBlock: string;
  /** sha256 of `rawBlock`; what the cache is keyed to. */
  sourceHash: string;
  /**
   * The stored guidelines, whatever their hashes — staleness is judged at resolution time. Kept
   * current in memory after each save in this run, so a run that refreshes both the lessons and
   * the patterns writes the second without losing the first.
   */
  cached: StoredGuidelines | null;
  /** When true, a matching cache is ignored and the evidence is re-distilled (CLI --recompute-insights). */
  forceRefresh: boolean;
  /** The compact block's fixed parts, rendered once here so resolution needs no insights object. */
  videoCount: number;
  baselinesLine: string;
  abRulesBlock: string;
  /** Writes the fresh guidelines beside insights.json. A closure so generation never sees the store. */
  save: (guidelines: StoredGuidelines) => Promise<void>;
}

/** The cached patterns, keyed to the evidence they were distilled from exactly as the lessons are. */
export interface ChannelTitlePatterns {
  generatedAt: string;
  model: string;
  /** sha256 of the evidence render the pattern distiller read. */
  sourceHash: string;
  patterns: TitlePattern[];
}

/**
 * guidelines.json as this module reads and writes it: the lessons record, plus `patterns` once
 * they have been distilled. Absent `patterns` is a file from before they existed, and reads as
 * stale (resolveTitlePatterns), never as an empty list.
 */
export interface StoredGuidelines extends ChannelGuidelines {
  patterns?: ChannelTitlePatterns;
}

/**
 * Everything the generation layer needs to carry channel evidence into a run, or null when
 * the loop has nothing to add (no channel maps to this prompt set, or no computed insights)
 * — null is the same expected state resolveInsightsBlockForPromptSet always had.
 */
export function prepareChannelInsights(
  store: AnalyticsStoreService,
  promptSetName: string,
  options?: { forceRefresh?: boolean }
): PreparedChannelInsights | null {
  const channel = store.listChannels().find((c) => c.promptSets.includes(promptSetName));
  if (!channel) return null;
  const insights = store.loadChannelInsights(channel.channelId);
  if (!insights) return null;
  log.info(`[InsightsGuidelines] prepared channel "${channel.name}" for prompt set "${promptSetName}"`);
  return prepareChannelInsightsFromData(
    store,
    { channelId: channel.channelId, name: channel.name },
    insights,
    store.loadCrossChannelInsights(),
    Boolean(options?.forceRefresh)
  );
}

/**
 * The same preparation from in-memory data — the CLI's --recompute-insights path derives
 * insights fresh without touching the stored insights.json, and prepares from that. The
 * guidelines CACHE is still read and written against the store: a distillation forced from
 * recomputed evidence keys its result to that evidence's hash, and the next ordinary run
 * re-distills only if the stored evidence renders differently. That asymmetry is logged at
 * distillation time via the hash line, not hidden.
 */
export function prepareChannelInsightsFromData(
  store: AnalyticsStoreService,
  channel: { channelId: string; name: string },
  insights: ChannelInsights,
  cross: CrossChannelInsights | null,
  forceRefresh: boolean
): PreparedChannelInsights {
  const rawBlock = buildInsightsBlock(insights, cross, store.loadAbTests(channel.channelId));
  const sourceHash = crypto.createHash('sha256').update(rawBlock, 'utf8').digest('hex');
  const b = insights.baselines;
  log.info(
    `[InsightsGuidelines] evidence for "${channel.name}": ${rawBlock.length} chars, hash ${sourceHash.slice(0, 12)}…`
  );
  return {
    channelId: channel.channelId,
    channelName: channel.name,
    rawBlock,
    sourceHash,
    cached: store.loadChannelGuidelines(channel.channelId),
    forceRefresh,
    videoCount: insights.videoCount,
    baselinesLine:
      `Channel baselines (first-week medians): CTR ${pct(b.medianCtrFirstWeek)} | ` +
      `avg % viewed ${pct(b.medianAvgPctViewed)} | 30s retention ${pct(b.medianRetention30s)} | ` +
      `views ${b.medianFirstWeekViews === null ? 'n/a' : Math.round(b.medianFirstWeekViews).toLocaleString('en-US')}`,
    abRulesBlock: renderAbTitleRulesBlock(insights.abTitleRules, { exemplars: false }),
    save: (guidelines) => store.saveChannelGuidelines(channel.channelId, guidelines),
  };
}

/** The distiller's whole prompt: the asset around the exact evidence render. */
export function distillerPromptFor(prepared: PreparedChannelInsights): string {
  return formatPrompt(promptAssets().pipeline('insights.yml', 'guidelines_distiller'), {
    performance_data: prepared.rawBlock,
  });
}

/**
 * Read the distiller's plain-line answer into normalized "- " lessons.
 *
 * Numbering and bullet variants are normalization, not repair; an answer without enough
 * usable lines THROWS naming what came back — the caller's one-re-ask policy is the
 * recovery, per the same contract every plain parser in this codebase states.
 */
export function parseGuidelineLines(text: string, what: string): string[] {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => `- ${line.replace(/^(?:[-*•]|\d+[.)])\s*/, '')}`);
  if (lines.length < 3 || lines.length > 14) {
    throw new Error(
      `The answer to ${what} holds ${lines.length} usable line(s) where 5-10 lessons were asked for ` +
        `(got: "${text.slice(0, 160)}")`
    );
  }
  return lines;
}

/** The compact block generation carries — evidence-derived, subject-free, well under 1500 chars. */
export function buildCompactInsightsBlock(prepared: PreparedChannelInsights, lines: string[]): string {
  return [
    'CHANNEL PERFORMANCE DATA',
    `(Distilled from this channel's real audience data, ${prepared.videoCount} videos analyzed; it outranks generic best practices.)`,
    '',
    prepared.baselinesLine,
    '',
    prepared.abRulesBlock,
    '',
    "LEARNED FROM THIS CHANNEL'S PERFORMANCE:",
    ...lines,
  ].join('\n');
}

/**
 * The one placeholder state: a dry run (show-prompts) on a channel whose guidelines were
 * never distilled, or whose evidence moved since. A DECLARED MODE, not a fallback — a dry
 * run exists to cost nothing, so it must never spend the distillation call; the line below
 * appears in the dumped prompt exactly where the lessons will, saying what a real run does.
 */
export const GUIDELINES_PLACEHOLDER =
  "- [guidelines not yet distilled for this channel's current evidence — a real run makes the one distillation call and caches it]";

export interface ResolveGuidelinesOptions {
  /** True on show-prompts flows: never call a model; cached lines or the placeholder. */
  dryRun: boolean;
  /** The model `distill` talks to (the titles field's resolved model), recorded in the cache. */
  model: string;
  /**
   * ONE plain-text call on the titles field's resolved transport, or null for an unusable
   * answer (the caller of THIS function retries once via the same fn; transport errors throw
   * through untouched and fail the run loudly — nothing substitutes for evidence).
   */
  distill: (prompt: string, what: string) => Promise<string | null>;
}

/**
 * The compact insights block for this run: cache hit (the common path), dry-run placeholder,
 * or the one distillation call — asked at most twice, then a loud throw.
 */
export async function resolveGuidelinesBlock(
  prepared: PreparedChannelInsights,
  options: ResolveGuidelinesOptions
): Promise<string> {
  const fresh = prepared.cached !== null && prepared.cached.sourceHash === prepared.sourceHash;

  if (fresh && !prepared.forceRefresh) {
    log.info(
      `[InsightsGuidelines] cache hit for "${prepared.channelName}": ${prepared.cached!.lines.length} ` +
        `lesson(s) distilled ${prepared.cached!.generatedAt} by ${prepared.cached!.model} — no call`
    );
    return buildCompactInsightsBlock(prepared, prepared.cached!.lines);
  }

  if (options.dryRun) {
    log.info(
      `[InsightsGuidelines] dry run with ${prepared.cached ? 'a STALE' : 'no'} guidelines cache for ` +
        `"${prepared.channelName}" — the placeholder line stands in; no model is called from a dry run`
    );
    return buildCompactInsightsBlock(prepared, [GUIDELINES_PLACEHOLDER]);
  }

  const what = `the distilled title guidelines for channel "${prepared.channelName}"`;
  const prompt = distillerPromptFor(prepared);
  const reason = prepared.forceRefresh
    ? 'refresh forced (--recompute-insights)'
    : prepared.cached
      ? `evidence moved (stored hash ${prepared.cached.sourceHash.slice(0, 12)}…, current ${prepared.sourceHash.slice(0, 12)}…)`
      : 'no guidelines were ever distilled for this channel';
  log.info(`[InsightsGuidelines] distilling "${prepared.channelName}": ${reason}`);

  let lines: string[] | null = null;
  for (const attempt of ['', ', second attempt'] as const) {
    const answer = await options.distill(prompt, `${what}${attempt}`);
    if (answer === null) continue;
    try {
      lines = parseGuidelineLines(answer, `${what}${attempt}`);
      break;
    } catch (error) {
      log.warn(`[InsightsGuidelines] ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!lines) {
    throw new Error(
      `${what} could not be distilled: both asks returned no usable lesson list (the answers are in ` +
        `the log). Nothing is substituted — the raw evidence block deliberately does not ride into ` +
        `generation any more, so this run cannot proceed with insights it does not have. Re-run, or ` +
        `run without insights.`
    );
  }

  const guidelines: StoredGuidelines = {
    generatedAt: new Date().toISOString(),
    model: options.model,
    sourceHash: prepared.sourceHash,
    lines,
    // The patterns ride along untouched: they are judged stale or fresh by their own hash.
    ...(prepared.cached?.patterns === undefined ? {} : { patterns: prepared.cached.patterns }),
  };
  await prepared.save(guidelines);
  prepared.cached = guidelines;
  log.info(
    `[InsightsGuidelines] distilled and cached ${lines.length} lesson(s) for "${prepared.channelName}"`
  );
  return buildCompactInsightsBlock(prepared, lines);
}

// ---------------------------------------------------------------------------
// The tested patterns (the header's last section has the design)
// ---------------------------------------------------------------------------

/** The pattern distiller's whole prompt: the asset around the same evidence render the lessons read. */
export function patternDistillerPromptFor(prepared: PreparedChannelInsights): string {
  return formatPrompt(promptAssets().pipeline('insights.yml', 'pattern_distiller'), {
    pattern_count: TITLE_PATTERN_COUNT,
    performance_data: prepared.rawBlock,
  });
}

/** A pattern's name, as Owen reads it beside the title: 2 to 5 words, and short enough to sit on one row. */
const PATTERN_NAME_WORDS: [number, number] = [2, 5];
const PATTERN_NAME_MAX_CHARS = 48;

/** One pattern, or the reason it is not one. Shared by the answer reader and the cache reader. */
function patternFault(pattern: { name: unknown; how: unknown }): string | null {
  if (typeof pattern.name !== 'string' || typeof pattern.how !== 'string') return 'is not a name and a line of text';
  const words = pattern.name.trim().split(/\s+/).filter((w) => w.length > 0).length;
  if (words < PATTERN_NAME_WORDS[0] || words > PATTERN_NAME_WORDS[1]) {
    return `has a name of ${words} word(s) ("${pattern.name}") where ${PATTERN_NAME_WORDS[0]}-${PATTERN_NAME_WORDS[1]} were asked for`;
  }
  if (pattern.name.trim().length > PATTERN_NAME_MAX_CHARS) {
    return `has a name of ${pattern.name.trim().length} characters ("${pattern.name}"), over ${PATTERN_NAME_MAX_CHARS}`;
  }
  if (pattern.how.trim().split(/\s+/).length < 4) return `says too little about how to write it ("${pattern.how}")`;
  return null;
}

function duplicateNames(patterns: TitlePattern[]): string[] {
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const p of patterns) {
    const key = p.name.toLowerCase();
    if (seen.has(key)) dupes.push(p.name);
    seen.add(key);
  }
  return dupes;
}

/**
 * Read the pattern distiller's answer: exactly TITLE_PATTERN_COUNT lines of `name: how`.
 *
 * Bullets and numbering are normalization, as in parseGuidelineLines; everything else is
 * strict, because each pattern is shown to Owen by its name and handed to the title call by
 * its line, and a line that is not one pattern cannot be either. A wrong count, a line with no
 * `name:`, a name outside 2-5 words, a near-empty instruction or two patterns with one name all
 * THROW naming what came back — the caller's one-re-ask policy (the lessons' own) is the
 * recovery, then a loud failure.
 */
export function parseTitlePatterns(text: string, what: string): TitlePattern[] {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^(?:[-*•]|\d+[.)])\s*/, ''));
  if (lines.length !== TITLE_PATTERN_COUNT) {
    throw new Error(
      `The answer to ${what} holds ${lines.length} line(s) where exactly ${TITLE_PATTERN_COUNT} patterns were asked for ` +
        `(got: "${text.slice(0, 200)}")`
    );
  }
  const patterns: TitlePattern[] = lines.map((line, i) => {
    const colon = line.indexOf(':');
    if (colon <= 0) {
      throw new Error(`The answer to ${what}: line ${i + 1} is not "name: how to write it" (got: "${line.slice(0, 160)}")`);
    }
    const pattern = { name: line.slice(0, colon).trim(), how: line.slice(colon + 1).trim() };
    const fault = patternFault(pattern);
    if (fault) throw new Error(`The answer to ${what}: pattern ${i + 1} ${fault}`);
    return pattern;
  });
  const dupes = duplicateNames(patterns);
  if (dupes.length > 0) {
    throw new Error(`The answer to ${what} names the same pattern twice: ${dupes.map((d) => `"${d}"`).join(', ')}`);
  }
  return patterns;
}

/**
 * A stored `patterns` record, checked before it is used: guidelines.json is a file on disk and
 * can be edited by hand. A record that is present and malformed THROWS naming the channel; it is
 * never read as stale (that would quietly spend a call over a broken file), nor trimmed.
 */
function checkedStoredPatterns(stored: ChannelTitlePatterns, channelName: string): ChannelTitlePatterns {
  const where = `the stored tested patterns for channel "${channelName}" (guidelines.json)`;
  const again = 'delete the "patterns" key to have them distilled again';
  if (!stored || typeof stored.sourceHash !== 'string' || !Array.isArray(stored.patterns)) {
    throw new Error(`${where} are not { generatedAt, model, sourceHash, patterns: [...] }; ${again}`);
  }
  if (stored.patterns.length !== TITLE_PATTERN_COUNT) {
    throw new Error(`${where} hold ${stored.patterns.length} pattern(s), not ${TITLE_PATTERN_COUNT}; ${again}`);
  }
  stored.patterns.forEach((p, i) => {
    const fault = patternFault(p);
    if (fault) throw new Error(`${where}: pattern ${i + 1} ${fault}; ${again}`);
  });
  const dupes = duplicateNames(stored.patterns);
  if (dupes.length > 0) throw new Error(`${where} name the same pattern twice (${dupes.join(', ')}); ${again}`);
  return stored;
}

/**
 * The dry-run stand-in, by the GUIDELINES_PLACEHOLDER convention: a show-prompts flow on a
 * channel whose patterns were never distilled for its current evidence shows this line where the
 * five patterns will be, and spends nothing.
 */
export const PATTERNS_PLACEHOLDER =
  "[tested patterns not yet distilled for this channel's current evidence — a real run makes the one pattern distillation call and caches it]";

/** What the tested-pattern titles call is given: the patterns, or (dry runs only) the placeholder. */
export type ResolvedTitlePatterns =
  | { kind: 'patterns'; patterns: TitlePattern[]; sourceHash: string }
  | { kind: 'placeholder'; text: string };

/**
 * This run's tested patterns: cache hit (the common path), dry-run placeholder, or the one
 * pattern distillation call — asked at most twice, then a loud throw. Called after
 * resolveGuidelinesBlock, whose save it builds on (`prepared.cached` is current by then).
 */
export async function resolveTitlePatterns(
  prepared: PreparedChannelInsights,
  options: ResolveGuidelinesOptions
): Promise<ResolvedTitlePatterns> {
  const stored =
    prepared.cached?.patterns === undefined ? null : checkedStoredPatterns(prepared.cached.patterns, prepared.channelName);

  if (stored !== null && stored.sourceHash === prepared.sourceHash && !prepared.forceRefresh) {
    log.info(
      `[InsightsGuidelines] tested patterns cache hit for "${prepared.channelName}": distilled ${stored.generatedAt} ` +
        `by ${stored.model} — no call (${stored.patterns.map((p) => p.name).join(' | ')})`
    );
    return { kind: 'patterns', patterns: stored.patterns, sourceHash: stored.sourceHash };
  }

  const reason = prepared.forceRefresh
    ? 'refresh forced (--recompute-insights)'
    : stored !== null
      ? `evidence moved (stored hash ${stored.sourceHash.slice(0, 12)}…, current ${prepared.sourceHash.slice(0, 12)}…)`
      : prepared.cached === null
        ? 'no guidelines were ever distilled for this channel'
        : 'this guidelines.json predates tested patterns';

  if (options.dryRun) {
    log.info(
      `[InsightsGuidelines] dry run, tested patterns for "${prepared.channelName}" are not current (${reason}) — ` +
        `the placeholder stands in; no model is called from a dry run`
    );
    return { kind: 'placeholder', text: PATTERNS_PLACEHOLDER };
  }

  if (prepared.cached === null) {
    throw new Error(
      `The tested patterns for channel "${prepared.channelName}" were asked for before its lessons were resolved; ` +
        `resolveGuidelinesBlock runs first and writes guidelines.json, so this is an ordering fault in the caller`
    );
  }

  const what = `the tested title patterns for channel "${prepared.channelName}"`;
  const prompt = patternDistillerPromptFor(prepared);
  log.info(`[InsightsGuidelines] distilling tested patterns for "${prepared.channelName}": ${reason}`);

  let patterns: TitlePattern[] | null = null;
  for (const attempt of ['', ', second attempt'] as const) {
    const answer = await options.distill(prompt, `${what}${attempt}`);
    if (answer === null) continue;
    try {
      patterns = parseTitlePatterns(answer, `${what}${attempt}`);
      break;
    } catch (error) {
      log.warn(`[InsightsGuidelines] ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!patterns) {
    throw new Error(
      `${what} could not be distilled: both asks returned no usable list of ${TITLE_PATTERN_COUNT} patterns (the ` +
        `answers are in the log). Nothing is substituted — a pattern nobody distilled from the evidence would be a ` +
        `hand-coded shape. Re-run, or run without insights.`
    );
  }

  const record: ChannelTitlePatterns = {
    generatedAt: new Date().toISOString(),
    model: options.model,
    sourceHash: prepared.sourceHash,
    patterns,
  };
  const next: StoredGuidelines = { ...prepared.cached, patterns: record };
  await prepared.save(next);
  prepared.cached = next;
  log.info(
    `[InsightsGuidelines] distilled and cached ${patterns.length} tested pattern(s) for "${prepared.channelName}": ` +
      patterns.map((p) => p.name).join(' | ')
  );
  return { kind: 'patterns', patterns, sourceHash: prepared.sourceHash };
}
