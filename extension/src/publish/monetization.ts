// Studio's monetization control: finding it, and deciding what to do with it.
//
// WHY THIS IS THE EXTENSION'S JOB AT ALL: the YouTube Data API cannot set monetization.
// There is no `monetizationDetails` write in videos.update, and the Content Owner API
// that can is not available to a single-channel creator. So the ONLY way this pipeline
// can act on the operator's monetization decision is by filling Studio's own control —
// which is exactly what PUBLISH-PIPELINE-PLAN Phase 5 says the extension is for.
//
// STRUCTURE: everything above the `--- DOM ---` line is PURE and takes facts as input.
// The DOM half only reads elements into those facts and clicks what the pure half names.
// That split exists because Studio's markup cannot be tested from a checkout and its
// decision rules can, so the rules are not allowed to hide inside a querySelector.
//
// WHAT IT ANCHORS TO, and why (this is the section to read when it breaks):
//
//   Studio's monetization step offers a two-way choice, rendered as Polymer radio
//   buttons inside a `tp-yt-paper-radio-group` — the same component the details form
//   uses for "Altered content" and "Paid promotion" (see fillers.ts, whose radios are
//   verified live). This module therefore looks for a radio GROUP, and identifies the
//   monetization one by the two answers it must contain:
//
//     1. the locale-independent `name` attribute, preferred: Studio names its radios in
//        SCREAMING_SNAKE (VIDEO_HAS_ALTERED_CONTENT_NO, VIDEO_PAID_PRODUCT_PLACEMENT_NO),
//        so an On/Off pair ends in `ON` / `OFF`.
//     2. the visible label, second: the buttons read "On" and "Off". THIS IS ENGLISH and
//        would not match a Studio in another language, which is why it is second and
//        never used when the names disagree.
//
//   A group qualifies ONLY when it contains exactly one "on" answer AND exactly one
//   "off" answer. One without the other is a group this code does not understand, and a
//   half-understood radio group is the one thing that could make this click the wrong
//   button — so it refuses instead. Same for two qualifying groups on one page.
//
// NOT VERIFIED AGAINST LIVE STUDIO. Unlike the details-form selectors, nobody has run
// this against the real monetization tab yet. That is precisely why every miss returns a
// REASON THAT DUMPS WHAT IT ACTUALLY FOUND (name + label of every radio in every group):
// the first operator to hit a breakage gets the real markup in the shelf, which is what
// makes the fix a one-line selector change rather than an investigation.

import { visibleAll } from './dom';

/** What the pure decision needs to know about one radio button. */
export interface RadioFacts {
  /** The `name` attribute, or null when Studio rendered none. Locale-independent. */
  name: string | null;
  /** The visible label, whitespace-collapsed. LOCALIZED — see the header. */
  label: string;
  /** Whether it is currently the selected answer. */
  checked: boolean;
}

/**
 * `name` endings for the two answers, e.g. MONETIZATION_ON / MONETIZATION_OFF.
 * Anchored at the end so a name like VIDEO_HAS_ALTERED_CONTENT_NO cannot match either.
 */
const ON_NAME = /(^|_)ON$/i;
const OFF_NAME = /(^|_)OFF$/i;

/**
 * Label fallbacks: the label STARTS WITH the word On / Off.
 *
 * `\b` rather than `$` because Studio decorates these ("On", "Off", sometimes with a
 * trailing hint), and the word boundary is what keeps "Once…" from reading as "On".
 */
const ON_LABEL = /^on\b/i;
const OFF_LABEL = /^off\b/i;

/** A short dump of a group, for failure messages. This is the diagnostic payload. */
export function describeRadios(radios: RadioFacts[]): string {
  if (!radios.length) return '(no radios)';
  return radios
    .map((r) => `{name=${r.name === null ? 'none' : r.name}, label=${JSON.stringify(r.label)}}`)
    .join(', ');
}

/** Indices matching a predicate. */
function indicesWhere(radios: RadioFacts[], pick: (r: RadioFacts) => boolean): number[] {
  const out: number[] = [];
  radios.forEach((r, i) => {
    if (pick(r)) out.push(i);
  });
  return out;
}

/** Which radios in one group are the On and Off answers, and how that was decided. */
export type PairMatch =
  | { matched: true; onIndex: number; offIndex: number; matchedBy: 'name' | 'label' }
  | { matched: false; reason: string };

/**
 * Identify the On/Off pair inside ONE radio group.
 *
 * Names first, labels only when the group carries NO name-based evidence at all. A group
 * where the names half-match (one "on" and no "off", or two "on"s) is refused rather than
 * retried against the labels: the names are the authoritative signal, and disagreeing
 * with them by falling through to English text is how the wrong button gets clicked.
 */
export function matchOnOffPair(radios: RadioFacts[]): PairMatch {
  const byName = {
    on: indicesWhere(radios, (r) => !!r.name && ON_NAME.test(r.name)),
    off: indicesWhere(radios, (r) => !!r.name && OFF_NAME.test(r.name)),
  };

  if (byName.on.length === 1 && byName.off.length === 1) {
    return { matched: true, onIndex: byName.on[0]!, offIndex: byName.off[0]!, matchedBy: 'name' };
  }
  if (byName.on.length > 0 || byName.off.length > 0) {
    return {
      matched: false,
      reason:
        `radio names identify ${byName.on.length} "on" and ${byName.off.length} "off" ` +
        `answers, which is not a pair: ${describeRadios(radios)}`,
    };
  }

  const byLabel = {
    on: indicesWhere(radios, (r) => ON_LABEL.test(r.label)),
    off: indicesWhere(radios, (r) => OFF_LABEL.test(r.label)),
  };
  if (byLabel.on.length === 1 && byLabel.off.length === 1) {
    return { matched: true, onIndex: byLabel.on[0]!, offIndex: byLabel.off[0]!, matchedBy: 'label' };
  }

  return {
    matched: false,
    reason:
      `no On/Off pair here — names carry no ON/OFF ending and labels give ` +
      `${byLabel.on.length} "on" / ${byLabel.off.length} "off": ${describeRadios(radios)}`,
  };
}

/** Which of the page's radio groups is the monetization one. */
export type GroupChoice =
  | { found: true; index: number; pair: PairMatch & { matched: true } }
  | { found: false; reason: string };

/**
 * Pick the ONE monetization group out of every radio group on the page.
 *
 * Zero qualifying groups and two qualifying groups are both refusals, and both name what
 * was seen. Two is the dangerous one: picking either would be a coin flip over which
 * control gets clicked, and the loser is a setting the operator never touched.
 */
export function pickMonetizationGroup(groups: RadioFacts[][]): GroupChoice {
  const qualifying: Array<{ index: number; pair: PairMatch & { matched: true } }> = [];
  const rejected: string[] = [];

  groups.forEach((radios, index) => {
    const pair = matchOnOffPair(radios);
    if (pair.matched) qualifying.push({ index, pair });
    else rejected.push(`group ${index + 1}: ${pair.reason}`);
  });

  if (qualifying.length === 1) {
    return { found: true, index: qualifying[0]!.index, pair: qualifying[0]!.pair };
  }

  if (qualifying.length === 0) {
    return {
      found: false,
      reason: groups.length
        ? `None of the ${groups.length} radio group(s) on this page is an On/Off pair. ` +
          rejected.join('; ')
        : 'No radio groups on this page at all.',
    };
  }

  return {
    found: false,
    reason:
      `${qualifying.length} radio groups on this page look like an On/Off pair ` +
      `(${qualifying.map((q) => `group ${q.index + 1}: ${describeRadios(groups[q.index]!)}`).join('; ')}). ` +
      `Refusing to guess which one is monetization.`,
  };
}

/** What to do about the monetization radios, given the operator's intent. */
export type MonetizationPlan =
  | { kind: 'click'; index: number; detail: string }
  | { kind: 'already'; index: number; detail: string }
  | { kind: 'refuse'; reason: string };

/**
 * The whole decision, as a pure function of what is on the page and what was asked for.
 *
 * `want` is a parameter rather than a hard-coded `true`, even though every caller now
 * passes true (MONETIZATION_ALWAYS_ON): the on/off pair matching below is symmetric, and
 * the tests that pin down which radio is which exercise both directions. Wiring the
 * policy in here would make the off case unreachable and therefore unverifiable, and the
 * policy lives one layer up where it can be read.
 */
export function planMonetization(radios: RadioFacts[], want: boolean): MonetizationPlan {
  const pair = matchOnOffPair(radios);
  if (!pair.matched) return { kind: 'refuse', reason: pair.reason };

  const index = want ? pair.onIndex : pair.offIndex;
  const target = radios[index];
  if (!target) {
    // Unreachable: the index came from this same array. Loud rather than a silent skip.
    return { kind: 'refuse', reason: `Radio index ${index} is not in the group of ${radios.length}.` };
  }

  const word = want ? 'on' : 'off';
  const how = `matched by ${pair.matchedBy}`;
  if (target.checked) {
    return { kind: 'already', index, detail: `Monetization is already ${word} (${how}).` };
  }
  return { kind: 'click', index, detail: `Turned monetization ${word} (${how}).` };
}

/**
 * Should the monetization action be offered at all?
 *
 * ONE reason left, and losing the other one is the point. This used to take the operator's
 * three-valued intent as well, and refuse when it was null ("no monetization decision on
 * this report"). Monetization is no longer a per-item decision — it is on for every video
 * on all three channels (the app's MONETIZATION_ALWAYS_ON) — so there is no state in which
 * this extension has nothing to say about it, and the only question left is whether the
 * control is in front of the operator.
 *
 * The signature keeps `surfacePresent` as its whole input rather than being replaced by a
 * bare boolean check at the call site, because the REASON is what the shelf renders on a
 * disabled button, and that sentence belongs beside the rule that produces it.
 */
export function monetizationAvailability(
  surfacePresent: boolean,
): { available: true } | { available: false; reason: string } {
  if (!surfacePresent) {
    return {
      available: false,
      reason: 'Open this video\'s Monetization tab in Studio',
    };
  }
  return { available: true };
}

// --------------------------------------------------------------------------- DOM ---

const SEL = {
  /**
   * Polymer's radio group and radio button, the same elements the details form's
   * "Altered content" / "Paid promotion" pairs use (verified live there, 2026-07-26).
   */
  radioGroup: 'tp-yt-paper-radio-group',
  radio: 'tp-yt-paper-radio-button',
};

/**
 * Read one radio's facts.
 *
 * `checked` consults BOTH representations because tp-yt-paper-radio-button carries the
 * state in both and Studio has been seen setting only one — the details-form filler
 * trusts aria-checked, and the checkbox helper next to it already has to check three
 * places for the same reason.
 */
function readRadio(el: Element): RadioFacts {
  return {
    name: el.getAttribute('name'),
    label: (el.textContent || '').replace(/\s+/g, ' ').trim(),
    checked: el.getAttribute('aria-checked') === 'true' || el.hasAttribute('checked'),
  };
}

/** Every VISIBLE radio group on the page, as elements and as facts, in document order. */
export function readRadioGroups(): Array<{ el: HTMLElement; radios: HTMLElement[]; facts: RadioFacts[] }> {
  return visibleAll<HTMLElement>(SEL.radioGroup).map((el) => {
    const radios = [...el.querySelectorAll<HTMLElement>(SEL.radio)];
    return { el, radios, facts: radios.map(readRadio) };
  });
}

/**
 * True on the standalone monetization page, `/video/<id>/monetization`.
 *
 * URL-only, and therefore only half the story: the upload wizard keeps the SAME url
 * (`/videos/upload?...&udvid=<id>`) on every step, so a false here proves nothing. It is
 * used to sharpen failure messages, never to decide whether the control exists.
 */
export function isMonetizationUrl(): boolean {
  return /\/video\/[^/]+\/monetization/.test(location.pathname);
}

/**
 * The monetization radios, or the reason they could not be identified.
 *
 * The reason is the whole point: it carries the markup that was actually there.
 */
export type MonetizationTarget =
  | { found: true; radios: HTMLElement[]; facts: RadioFacts[] }
  | { found: false; reason: string };

export function findMonetizationRadios(): MonetizationTarget {
  const groups = readRadioGroups();
  const choice = pickMonetizationGroup(groups.map((g) => g.facts));

  if (!choice.found) {
    const where = isMonetizationUrl()
      ? 'This is the monetization page, but '
      : 'Not on a monetization surface: ';
    return { found: false, reason: `${where}${choice.reason}` };
  }

  const group = groups[choice.index];
  if (!group) {
    return { found: false, reason: `Radio group ${choice.index} vanished while it was being read.` };
  }
  return { found: true, radios: group.radios, facts: group.facts };
}

/**
 * Is the monetization control on screen right now?
 *
 * Answered by looking for the control itself rather than by URL or by a container's tag
 * name, because the upload wizard's Monetization step is a panel inside the SAME page as
 * the details form — no navigation, no url change, nothing else to test.
 */
export function monetizationSurfaceReady(): boolean {
  return findMonetizationRadios().found;
}

/** True when Studio reports the radio as selected. Used to verify a click landed. */
export function radioIsChecked(el: Element): boolean {
  return el.getAttribute('aria-checked') === 'true' || el.hasAttribute('checked');
}
