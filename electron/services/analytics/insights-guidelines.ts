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
 *   evidence (buildInsightsBlock, UNCHANGED — the raw render stays as the distiller's input
 *   and the operator's inspection surface)
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
  /** The stored guidelines, whatever their hash — staleness is judged at resolution time. */
  cached: ChannelGuidelines | null;
  /** When true, a matching cache is ignored and the evidence is re-distilled (CLI --recompute-insights). */
  forceRefresh: boolean;
  /** The compact block's fixed parts, rendered once here so resolution needs no insights object. */
  videoCount: number;
  baselinesLine: string;
  abRulesBlock: string;
  /** Writes the fresh guidelines beside insights.json. A closure so generation never sees the store. */
  save: (guidelines: ChannelGuidelines) => Promise<void>;
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
  const rawBlock = buildInsightsBlock(insights, cross);
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

  const guidelines: ChannelGuidelines = {
    generatedAt: new Date().toISOString(),
    model: options.model,
    sourceHash: prepared.sourceHash,
    lines,
  };
  await prepared.save(guidelines);
  log.info(
    `[InsightsGuidelines] distilled and cached ${lines.length} lesson(s) for "${prepared.channelName}"`
  );
  return buildCompactInsightsBlock(prepared, lines);
}
