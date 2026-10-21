/**
 * Insights Prompt Block
 *
 * Renders distilled analytics into a compact plain-text block (< 1000 tokens)
 * that gets appended to the AI metadata-generation prompt when the active
 * prompt set maps to a registered channel with computed insights.
 *
 * buildInsightsBlock is PURE (data in, string out) so it is unit-testable
 * without a store or Electron runtime.
 */

import { AbTestResult, ChannelInsights, CrossChannelInsights, VideoVerdictSummary } from './analytics-types';
import { AnalyticsStoreService } from './analytics-store.service';
import { renderAbTitleRulesBlock, renderRecentAbTests } from './ab-title-rules';

/** The "recent" window both recent sections cover; the distiller prompt names the same 90 days. */
const RECENT_WINDOW_DAYS = 90;

/** Most recent-upload lines rendered; the newest are kept and the cut is stated. */
const RECENT_UPLOADS_CAP = 40;

/** "5.3%" / "n/a" for possibly-missing percent metrics. */
function pct(value: number | null): string {
  return value === null ? 'n/a' : `${Math.round(value * 10) / 10}%`;
}

/** "p87" / "n/a" for possibly-missing percentiles. */
function pctl(value: number | null): string {
  return value === null ? 'n/a' : `p${Math.round(value)}`;
}

/**
 * "12,345 engaged views" / "engaged views not measured". Every view count the render compares
 * is engaged views (see VIEWS_MEASURE_LINE); a summary without one says so rather than
 * showing raw views, which doubled from 2026-08-27 and would read as a jump in performance.
 */
export function engagedViewsText(value: number | null | undefined, what: string): string {
  if (value === undefined) {
    throw new Error(`[InsightsPrompt] ${what} has no engagedViews field (insights from before engaged views); re-run distillation`);
  }
  return value === null ? 'engaged views not measured' : `${Math.round(value).toLocaleString('en-US')} engaged views`;
}

/** Stated once, under the heading, so every number below reads as what it is. */
export const VIEWS_MEASURE_LINE =
  '(Every view count below is ENGAGED views. From 2026-08-27 YouTube also counts Home-feed autoplay previews as views, ' +
  'which roughly doubled raw views on every channel; engaged views leave those out and compare across that date.)';

function summaryLine(item: VideoVerdictSummary): string {
  return `- "${item.title}" — published ${item.publishedAt.slice(0, 10)}, CTR ${pct(item.ctr)} (${pctl(item.ctrPercentile)}), 30s retention ${pct(item.retention30s)}, ${engagedViewsText(item.engagedViews, `"${item.title}"`)} (lifetime)`;
}

function recentLine(item: VideoVerdictSummary): string {
  const basis = item.basis === 'first-week' ? 'first 7 days' : 'lifetime';
  return `- "${item.title}" — published ${item.publishedAt.slice(0, 10)}, CTR ${pct(item.ctr)} (${pctl(item.ctrPercentile)}), avg % viewed ${pct(item.avgPctViewed)}, ${engagedViewsText(item.engagedViews, `"${item.title}"`)} (${basis})`;
}

/** The baselines' views part, shared with the compact block generation carries. */
export function baselineEngagedViewsText(baselines: ChannelInsights['baselines'], channelId: string): string {
  if (baselines.medianFirstWeekEngagedViews === undefined) {
    throw new Error(`[InsightsPrompt] channel ${channelId} has insights from before engaged views; re-run distillation`);
  }
  const v = baselines.medianFirstWeekEngagedViews;
  return `engaged views in the first 7 days ${v === null ? 'n/a' : Math.round(v).toLocaleString('en-US')}`;
}

/**
 * Build the "CHANNEL PERFORMANCE DATA" prompt block from a channel's insights
 * (required), its decided A/B test records (the recent-tests section is rendered from
 * them, dated against the insights' computedAt) and cross-channel insights (optional —
 * section omitted when null).
 *
 * The whole render is dated ("as of" computedAt) and carries two dated recent sections, so
 * the distiller can tell what the channel does NOW from what used to work; its prompt says
 * recent evidence outranks old.
 */
export function buildInsightsBlock(
  channelInsights: ChannelInsights,
  crossChannelInsights: CrossChannelInsights | null,
  abTests: AbTestResult[]
): string {
  if (!channelInsights.recentUploads) {
    // A ChannelInsights written before recent uploads were recorded. Without them the render
    // has no dated view of the channel now, and its summaries carry no publish dates either.
    throw new Error(
      `[InsightsPrompt] channel ${channelInsights.channelId} has insights from before recent-upload ` +
      `tracking (computed ${channelInsights.computedAt}); re-run distillation`
    );
  }
  const asOf = new Date(channelInsights.computedAt);
  if (Number.isNaN(asOf.getTime())) {
    throw new Error(
      `[InsightsPrompt] channel ${channelInsights.channelId} has computedAt "${channelInsights.computedAt}", not a date`
    );
  }

  const lines: string[] = [];
  lines.push(`CHANNEL PERFORMANCE DATA (as of ${channelInsights.computedAt.slice(0, 10)})`);
  lines.push(`(Real audience data for this channel, ${channelInsights.videoCount} videos analyzed. Emulate the framing patterns of overperformers; avoid patterns of underperformers; this data outranks generic best practices.)`);
  lines.push(VIEWS_MEASURE_LINE);
  lines.push('');

  const b = channelInsights.baselines;
  lines.push('Channel baselines (first-week medians):');
  lines.push(`- CTR ${pct(b.medianCtrFirstWeek)} | avg % viewed ${pct(b.medianAvgPctViewed)} | 30s retention ${pct(b.medianRetention30s)} | ${baselineEngagedViewsText(b, channelInsights.channelId)}`);

  if (channelInsights.topPackaging.length > 0) {
    lines.push('');
    lines.push('Top-performing titles (best packaging):');
    for (const item of channelInsights.topPackaging) {
      lines.push(summaryLine(item));
    }
  }

  if (channelInsights.bottomPackaging.length > 0) {
    lines.push('');
    lines.push('Worst-performing titles (avoid these patterns):');
    for (const item of channelInsights.bottomPackaging) {
      lines.push(summaryLine(item));
    }
  }

  lines.push('');
  lines.push(`Recent uploads (last ${RECENT_WINDOW_DAYS} days, newest first):`);
  if (channelInsights.recentUploads.length === 0) {
    lines.push(`None: no long or live video was published in the last ${RECENT_WINDOW_DAYS} days.`);
  }
  for (const item of channelInsights.recentUploads.slice(0, RECENT_UPLOADS_CAP)) {
    lines.push(recentLine(item));
  }
  const cut = channelInsights.recentUploads.length - RECENT_UPLOADS_CAP;
  if (cut > 0) {
    lines.push(`(${cut} older upload(s) from the window not shown; the newest ${RECENT_UPLOADS_CAP} are listed.)`);
  }

  lines.push('');
  lines.push(renderRecentAbTests(abTests, {
    channelId: channelInsights.channelId,
    asOf,
    windowDays: RECENT_WINDOW_DAYS,
  }));

  // Derived A/B title evidence: threshold-clearing rules WITH their provenance, plus a
  // capped exemplar list. This replaced an unbounded per-test dump that grew one line per
  // decided test forever and said nothing about how much evidence stood behind any of it.
  // The block is always rendered, including when it derives nothing — see
  // renderAbTitleRulesBlock.
  if (!channelInsights.abTitleRules) {
    // A ChannelInsights written before this field existed. Rendering the rest of the block
    // without it would quietly ship a prompt with no title evidence in it at all.
    throw new Error(
      `[InsightsPrompt] channel ${channelInsights.channelId} has insights from before A/B title-rule ` +
      `derivation (computed ${channelInsights.computedAt}); re-run distillation`
    );
  }
  lines.push('');
  lines.push(renderAbTitleRulesBlock(channelInsights.abTitleRules));

  if (channelInsights.topSearchTerms.length > 0) {
    lines.push('');
    lines.push('Top search terms driving views: ' + channelInsights.topSearchTerms.map((t) => `${t.term} (${t.views.toLocaleString('en-US')})`).join(', '));
  }

  if (crossChannelInsights) {
    if (crossChannelInsights.risingSearchTerms.length > 0) {
      lines.push('');
      lines.push('Rising search terms (last 90 days, across channels): ' + crossChannelInsights.risingSearchTerms.map((t) =>
        t.trendVsPriorPeriod === -1
          ? `${t.term} (new, ${t.views.toLocaleString('en-US')} views)`
          : `${t.term} (${t.trendVsPriorPeriod}x prior period)`
      ).join(', '));
    }
    if (crossChannelInsights.recentOverperformers.length > 0) {
      lines.push('');
      lines.push('Recent overperformers across all channels (last 90 days):');
      for (const op of crossChannelInsights.recentOverperformers) {
        lines.push(`- "${op.title}" — packaging score ${Math.round(op.packagingScore)}, ${engagedViewsText(op.engagedViews, `"${op.title}"`)} (lifetime)`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Resolve the insights block for a prompt set, or null when the feedback loop
 * has nothing to add (no channel maps to this prompt set, or the channel has
 * no computed insights yet). Null is an EXPECTED state, not an error — the
 * caller simply omits the block.
 */
export function resolveInsightsBlockForPromptSet(
  store: AnalyticsStoreService,
  promptSetName: string
): string | null {
  const channel = store.listChannels().find((c) => c.promptSets.includes(promptSetName));
  if (!channel) {
    return null;
  }
  const channelInsights = store.loadChannelInsights(channel.channelId);
  if (!channelInsights) {
    return null;
  }
  const crossChannelInsights = store.loadCrossChannelInsights();
  console.log(`[InsightsPrompt] Injecting performance data for channel "${channel.name}" (prompt set: ${promptSetName})`);
  return buildInsightsBlock(channelInsights, crossChannelInsights, store.loadAbTests(channel.channelId));
}
