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

import { ChannelInsights, CrossChannelInsights, VideoVerdictSummary } from './analytics-types';
import { AnalyticsStoreService } from './analytics-store.service';

/** "5.3%" / "n/a" for possibly-missing percent metrics. */
function pct(value: number | null): string {
  return value === null ? 'n/a' : `${Math.round(value * 10) / 10}%`;
}

/** "p87" / "n/a" for possibly-missing percentiles. */
function pctl(value: number | null): string {
  return value === null ? 'n/a' : `p${Math.round(value)}`;
}

function summaryLine(item: VideoVerdictSummary): string {
  return `- "${item.title}" — CTR ${pct(item.ctr)} (${pctl(item.ctrPercentile)}), 30s retention ${pct(item.retention30s)}, ${item.views.toLocaleString('en-US')} views`;
}

/**
 * Build the "CHANNEL PERFORMANCE DATA" prompt block from a channel's insights
 * (required) and cross-channel insights (optional — section omitted when null).
 */
export function buildInsightsBlock(
  channelInsights: ChannelInsights,
  crossChannelInsights: CrossChannelInsights | null
): string {
  const lines: string[] = [];
  lines.push('CHANNEL PERFORMANCE DATA');
  lines.push(`(Real audience data for this channel, ${channelInsights.videoCount} videos analyzed. Emulate the framing patterns of overperformers; avoid patterns of underperformers; this data outranks generic best practices.)`);
  lines.push('');

  const b = channelInsights.baselines;
  lines.push('Channel baselines (first-week medians):');
  lines.push(`- CTR ${pct(b.medianCtrFirstWeek)} | avg % viewed ${pct(b.medianAvgPctViewed)} | 30s retention ${pct(b.medianRetention30s)} | views ${b.medianFirstWeekViews === null ? 'n/a' : Math.round(b.medianFirstWeekViews).toLocaleString('en-US')}`);

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

  if (channelInsights.abLearnings.length > 0) {
    lines.push('');
    lines.push('Title A/B test learnings:');
    for (const ab of channelInsights.abLearnings) {
      const losers = ab.variants.filter((v) => v !== ab.winner);
      lines.push(`- Winner: "${ab.winner}" (+${Math.round(ab.liftPct * 10) / 10}% lift) over ${losers.map((l) => `"${l}"`).join(', ')}`);
    }
  }

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
        lines.push(`- "${op.title}" — packaging score ${Math.round(op.packagingScore)}, ${op.views.toLocaleString('en-US')} views`);
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
  return buildInsightsBlock(channelInsights, crossChannelInsights);
}
