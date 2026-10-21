/**
 * The arithmetic behind the Analytics page's "Home feed" card, kept pure (no Angular, no
 * imports at runtime) so tools/channel-days-checks.js can transpile and run this exact file.
 *
 * Input rows are ChannelDay (electron/services/analytics/analytics-types.ts), declared here
 * structurally with only the fields the card reads. Day strings are 'YYYY-MM-DD' and compare
 * correctly as strings.
 *
 * null means "not captured" throughout: a window sum that includes a null is null, never a
 * sum of the values that happened to be there, because a partial sum reads as a real drop.
 * A schemaVersion 1 day (extension 0.2.10) has no engaged views or earnings: it reads as null
 * for those, never as zero.
 */

export interface DaySourceLike {
  impressions: number | null;
  impressionsCtr: number | null;
  views: number;
}

interface ChannelDayLikeFields {
  day: string;
  impressions: number | null;
  impressionsCtr: number | null;
  views: number;
  newViewers: number | null;
  subsNetChange: number | null;
  bySource: { browse: DaySourceLike; suggested: DaySourceLike; search: DaySourceLike };
}

export interface ChannelDayLikeV1 extends ChannelDayLikeFields {
  schemaVersion: 1;
}

export interface ChannelDayLikeV2 extends ChannelDayLikeFields {
  schemaVersion: 2;
  engagedViews: number;
  /** USD. */
  estimatedEarnings: number | null;
  byLocation: { browse: { views: number; engagedViews: number } };
}

export type ChannelDayLike = ChannelDayLikeV1 | ChannelDayLikeV2;

/** A day's engaged views; null on a v1 day, which never measured them. */
export function engagedViewsOf(d: ChannelDayLike): number | null {
  return d.schemaVersion === 2 ? d.engagedViews : null;
}

/** A day's estimated earnings (USD); null on a v1 day or a day Studio reported none for. */
export function earningsOf(d: ChannelDayLike): number | null {
  return d.schemaVersion === 2 ? d.estimatedEarnings : null;
}

/** Earnings per 1,000 engaged views (USD); null when either is unknown or there were none. */
export function revenuePerThousandEngaged(earnings: number | null, engagedViews: number | null): number | null {
  if (earnings === null || engagedViews === null || engagedViews === 0) return null;
  return (earnings / engagedViews) * 1000;
}

export interface WindowTotals {
  browseImpressions: number | null;
  browseViews: number;
  /** Impression-weighted CTR over the window, percent. */
  ctr: number | null;
  views: number;
  /** null when any day of the window has none (a v1 day). */
  engagedViews: number | null;
  /** USD; null when any day of the window has none. */
  earnings: number | null;
  /** USD per 1,000 engaged views. */
  revenuePerThousandEngaged: number | null;
}

export interface WindowChange {
  browseImpressions: number | null;
  browseViews: number | null;
  /** CTR change is RELATIVE (percent of the prior CTR), like the others — not points. */
  ctr: number | null;
  views: number | null;
  engagedViews: number | null;
  earnings: number | null;
  revenuePerThousandEngaged: number | null;
}

export type SevenDayComparison =
  | { kind: 'ok'; last: WindowTotals; prior: WindowTotals; change: WindowChange; lastFrom: string; lastTo: string; priorFrom: string; priorTo: string }
  /** `available` = how many of the 14 full days the comparison needs are stored. */
  | { kind: 'insufficient'; available: number; needed: 14 };

export interface DayTableRow {
  day: string;
  /** True for today's row: Studio is still counting it. */
  partial: boolean;
  impressions: number | null;
  ctr: number | null;
  views: number;
  /** null on a v1 day. */
  engagedViews: number | null;
  browseViews: number;
  /** Browse views as a percent of all views; null when the day had no views. */
  browseShare: number | null;
  /** USD; null on a v1 day or when Studio reported none. */
  earnings: number | null;
  suggestedViews: number;
  searchViews: number;
  newViewers: number | null;
  subsNet: number | null;
}

/** 'YYYY-MM-DD' for a local Date — the same calendar the extension's window is cut in. */
export function localDayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** The day `n` calendar days before `day` (n may be negative). Noon avoids DST edges. */
export function shiftDay(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return localDayKey(new Date(y, m - 1, d - n, 12));
}

function sumOrNull(values: Array<number | null>): number | null {
  let total = 0;
  for (const v of values) {
    if (v === null) return null;
    total += v;
  }
  return total;
}

function totalsOf(rows: ChannelDayLike[]): WindowTotals {
  const views = rows.reduce((s, r) => s + r.views, 0);
  const browseViews = rows.reduce((s, r) => s + r.bySource.browse.views, 0);
  const browseImpressions = sumOrNull(rows.map((r) => r.bySource.browse.impressions));

  // Weighted by impressions: a 10-impression day at 20% must not count like a
  // 10,000-impression day. Any day without both numbers makes the window's CTR unknown.
  let impressions = 0;
  let clicks = 0;
  let ctr: number | null = null;
  if (rows.every((r) => r.impressions !== null && r.impressionsCtr !== null)) {
    for (const r of rows) {
      impressions += r.impressions as number;
      clicks += (r.impressions as number) * (r.impressionsCtr as number) / 100;
    }
    ctr = impressions > 0 ? (clicks / impressions) * 100 : null;
  }
  const engagedViews = sumOrNull(rows.map(engagedViewsOf));
  const earnings = sumOrNull(rows.map(earningsOf));
  return {
    browseImpressions, browseViews, ctr, views, engagedViews, earnings,
    revenuePerThousandEngaged: revenuePerThousandEngaged(earnings, engagedViews),
  };
}

/** Relative change in percent; null when either side is unknown or the prior is 0. */
export function pctChange(last: number | null, prior: number | null): number | null {
  if (last === null || prior === null || prior === 0) return null;
  return ((last - prior) / prior) * 100;
}

/**
 * The last 7 FULL days against the 7 before them. Today is excluded from both windows
 * (Studio is still counting it). The windows are calendar days, so every one of the 14
 * must be stored: a missing day is not assumed to be zero, and the result then says how
 * many of the 14 are available instead of comparing a 5-day week with a 7-day one.
 */
export function compareSevenDays(days: ChannelDayLike[], today: string): SevenDayComparison {
  const byDay = new Map(days.map((d) => [d.day, d]));
  const lastDays: string[] = [];
  const priorDays: string[] = [];
  for (let i = 1; i <= 7; i++) lastDays.push(shiftDay(today, i));
  for (let i = 8; i <= 14; i++) priorDays.push(shiftDay(today, i));

  const needed = [...lastDays, ...priorDays];
  const available = needed.filter((d) => byDay.has(d)).length;
  if (available < needed.length) return { kind: 'insufficient', available, needed: 14 };

  const last = totalsOf(lastDays.map((d) => byDay.get(d)!));
  const prior = totalsOf(priorDays.map((d) => byDay.get(d)!));
  return {
    kind: 'ok',
    last,
    prior,
    change: {
      browseImpressions: pctChange(last.browseImpressions, prior.browseImpressions),
      browseViews: pctChange(last.browseViews, prior.browseViews),
      ctr: pctChange(last.ctr, prior.ctr),
      views: pctChange(last.views, prior.views),
      engagedViews: pctChange(last.engagedViews, prior.engagedViews),
      earnings: pctChange(last.earnings, prior.earnings),
      revenuePerThousandEngaged: pctChange(last.revenuePerThousandEngaged, prior.revenuePerThousandEngaged),
    },
    lastFrom: lastDays[6],
    lastTo: lastDays[0],
    priorFrom: priorDays[6],
    priorTo: priorDays[0],
  };
}

/** The newest `limit` stored days, newest first, shaped for the card's table. */
export function dayTableRows(days: ChannelDayLike[], today: string, limit: number): DayTableRow[] {
  return [...days]
    .sort((a, b) => b.day.localeCompare(a.day))
    .slice(0, limit)
    .map((d) => ({
      day: d.day,
      partial: d.day === today,
      impressions: d.impressions,
      ctr: d.impressionsCtr,
      views: d.views,
      engagedViews: engagedViewsOf(d),
      browseViews: d.bySource.browse.views,
      browseShare: d.views > 0 ? (d.bySource.browse.views / d.views) * 100 : null,
      earnings: earningsOf(d),
      suggestedViews: d.bySource.suggested.views,
      searchViews: d.bySource.search.views,
      newViewers: d.newViewers,
      subsNet: d.subsNetChange,
    }));
}

export interface WeekRow {
  /** First and last day of the week, 'YYYY-MM-DD'. */
  from: string;
  to: string;
  /** How many of the week's 7 days are stored; every total below is null unless all 7 are. */
  daysStored: number;
  views: number | null;
  engagedViews: number | null;
  browseViews: number | null;
  /** USD. */
  earnings: number | null;
  revenuePerThousandEngaged: number | null;
}

/**
 * The last `weeks` full 7-day weeks, newest first, each ending the day before the next one
 * starts; the newest ends yesterday (today is partial). A week missing any stored day has no
 * totals — it says how many days it has instead — so a gap never reads as a quiet week.
 */
export function weeklyRows(days: ChannelDayLike[], today: string, weeks: number): WeekRow[] {
  const byDay = new Map(days.map((d) => [d.day, d]));
  const out: WeekRow[] = [];
  for (let w = 0; w < weeks; w++) {
    const dayKeys: string[] = [];
    for (let i = 1; i <= 7; i++) dayKeys.push(shiftDay(today, w * 7 + i));
    const rows = dayKeys.map((k) => byDay.get(k)).filter((d): d is ChannelDayLike => d !== undefined);
    const complete = rows.length === 7;
    const engagedViews = complete ? sumOrNull(rows.map(engagedViewsOf)) : null;
    const earnings = complete ? sumOrNull(rows.map(earningsOf)) : null;
    out.push({
      from: dayKeys[6],
      to: dayKeys[0],
      daysStored: rows.length,
      views: complete ? rows.reduce((s, r) => s + r.views, 0) : null,
      engagedViews,
      browseViews: complete ? rows.reduce((s, r) => s + r.bySource.browse.views, 0) : null,
      earnings,
      revenuePerThousandEngaged: revenuePerThousandEngaged(earnings, engagedViews),
    });
  }
  return out;
}
