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
 */

export interface DaySourceLike {
  impressions: number | null;
  impressionsCtr: number | null;
  views: number;
}

export interface ChannelDayLike {
  day: string;
  impressions: number | null;
  impressionsCtr: number | null;
  views: number;
  newViewers: number | null;
  subsNetChange: number | null;
  bySource: { browse: DaySourceLike; suggested: DaySourceLike; search: DaySourceLike };
}

export interface WindowTotals {
  browseImpressions: number | null;
  browseViews: number;
  /** Impression-weighted CTR over the window, percent. */
  ctr: number | null;
  views: number;
}

export interface WindowChange {
  browseImpressions: number | null;
  browseViews: number | null;
  /** CTR change is RELATIVE (percent of the prior CTR), like the others — not points. */
  ctr: number | null;
  views: number | null;
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
  browseViews: number;
  /** Browse views as a percent of all views; null when the day had no views. */
  browseShare: number | null;
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
  return { browseImpressions, browseViews, ctr, views };
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
      browseViews: d.bySource.browse.views,
      browseShare: d.views > 0 ? (d.bySource.browse.views / d.views) * 100 : null,
      suggestedViews: d.bySource.suggested.views,
      searchViews: d.bySource.search.views,
      newViewers: d.newViewers,
      subsNet: d.subsNetChange,
    }));
}
