// Studio's LIVESTREAM metadata form: finding the title and description boxes on it.
//
// WHY THIS EXISTS. The operator's pre-stream workflow has no upload in it at all: he
// generates metadata from a text subject, creates the stream in Studio, and wants the
// stream's details filled from that report before he goes live. That form is NOT the
// upload wizard and it is NOT /video/<id>/edit — Studio reaches its live surfaces by
// different routes (the live control room at /video/<id>/livestreaming, the channel-level
// live dashboard at /channel/<cid>/livestreaming) and renders the metadata editor inside
// its own hosts there. `ytcp-video-metadata-editor`, which is what page.detailsFormReady
// anchors on, is not guaranteed to be one of them.
//
// STRUCTURE, copied from monetization.ts and for the same reason: everything above the
// `--- DOM ---` line is PURE and takes facts as input; the DOM half only reads elements
// into those facts. Studio's live markup cannot be tested from a checkout; the rule for
// deciding which box is the title CAN be, so it is not allowed to hide inside a
// querySelector.
//
// WHAT IT ANCHORS TO, and why (this is the section to read when it breaks):
//
//   Every Studio metadata form — wizard, edit page, and by all appearances the live ones —
//   builds its title and description out of the same component: a contenteditable
//   `<div id="textbox">` inside a ytcp form host. So this looks for VISIBLE
//   `div#textbox` elements and decides which is which from two signals:
//
//     1. the aria-label, preferred: "Add a title…" and "Tell viewers about…" are the
//        strings fillers.ts already anchors on and they are verified live on the two
//        upload surfaces. THEY ARE ENGLISH and a Studio in another language will not
//        match them, which is exactly why there is a second signal.
//     2. POSITION, second: in every Studio metadata form the title box precedes the
//        description box in document order. This is the same positional reasoning the
//        A/B variant slots already use (fillers.abSlots), and for the same reason —
//        position is the one property that survives translation.
//
//   A page qualifies for the positional read ONLY when it shows EXACTLY TWO textboxes.
//   Two is the shape of a metadata form; three or more is a page this code does not
//   understand (an open A/B dialog stacks four, and a dialog over a form stacks more
//   still), and guessing which pair of five boxes is the metadata pair is how the wrong
//   field gets overwritten. It refuses instead.
//
//   Half-evidence from the aria-labels — one box that says "Add a title" and no box that
//   says "Tell viewers", or two boxes that both claim to be the title — is also a refusal
//   rather than a fall-through to position. That is monetization.ts's rule restated: the
//   labels are the stronger signal, and disagreeing with them by reaching for the weaker
//   one is how a half-understood page gets written to.
//
//   AND the whole read is gated on the URL being one of Studio's live routes, which
//   monetization.ts's equivalent deliberately is not. See isLivestreamUrl for why: "two
//   textboxes" also describes a playlist's edit page and the channel customization page,
//   and shape alone would offer to write a video's title over either.
//
// NOT VERIFIED AGAINST LIVE STUDIO. Nobody has run this against a real live control room
// or a real "create stream" dialog; the recon that produced fillers.ts's selectors was
// done in the upload wizard, and LEDGER II-B #70 records what recon-on-the-wrong-page
// costs. That is precisely why every miss returns a REASON THAT DUMPS WHAT IT ACTUALLY
// FOUND — the aria-label, id and host element of every textbox on the page, plus the URL.
// The first operator to hit a breakage gets the real markup in the shelf, which makes the
// fix a one-line selector change rather than an investigation.

import { visibleAll } from './dom';

/** What the pure decision needs to know about one candidate textbox. */
export interface TextboxFacts {
  /** The aria-label, whitespace-collapsed, or null when Studio rendered none. ENGLISH. */
  ariaLabel: string | null;
  /**
   * Tag name of the nearest custom-element ancestor — the "host". DIAGNOSTIC ONLY, and
   * deliberately not matched on: the host is the thing that differs between Studio's
   * surfaces (the A/B dialog alone has two hosts by entry point — see fillers.abSlots),
   * so it is the fact worth PRINTING when something misses and the last one worth
   * anchoring to.
   */
  host: string | null;
}

/** The two label shapes fillers.ts already anchors on, restated here as facts-level tests. */
const TITLE_LABEL = /^add a title/i;
const DESCRIPTION_LABEL = /^tell viewers/i;

/** A short dump of what was on the page. This is the diagnostic payload. */
export function describeTextboxes(facts: TextboxFacts[]): string {
  if (!facts.length) return '(no visible div#textbox on the page)';
  return facts
    .map(
      (f) =>
        `{host=${f.host ?? 'none'}, aria-label=${
          f.ariaLabel === null ? 'none' : JSON.stringify(f.ariaLabel)
        }}`,
    )
    .join(', ');
}

/** Indices matching a predicate. */
function indicesWhere(facts: TextboxFacts[], pick: (f: TextboxFacts) => boolean): number[] {
  const out: number[] = [];
  facts.forEach((f, i) => {
    if (pick(f)) out.push(i);
  });
  return out;
}

export type TextboxMatch =
  | { matched: true; titleIndex: number; descriptionIndex: number; matchedBy: 'aria-label' | 'position' }
  | { matched: false; reason: string };

/**
 * Which of the page's textboxes are the title and the description.
 *
 * `facts` MUST be in document order — the positional branch is the whole reason this
 * function can work on a Studio that is not in English, and it reads index 0 as the title
 * on exactly that basis.
 */
export function matchTextboxes(facts: TextboxFacts[]): TextboxMatch {
  const byLabel = {
    title: indicesWhere(facts, (f) => !!f.ariaLabel && TITLE_LABEL.test(f.ariaLabel)),
    description: indicesWhere(facts, (f) => !!f.ariaLabel && DESCRIPTION_LABEL.test(f.ariaLabel)),
  };

  if (byLabel.title.length === 1 && byLabel.description.length === 1) {
    return {
      matched: true,
      titleIndex: byLabel.title[0]!,
      descriptionIndex: byLabel.description[0]!,
      matchedBy: 'aria-label',
    };
  }
  if (byLabel.title.length > 0 || byLabel.description.length > 0) {
    return {
      matched: false,
      reason:
        `the labels identify ${byLabel.title.length} title and ${byLabel.description.length} ` +
        `description boxes, which is not a pair: ${describeTextboxes(facts)}`,
    };
  }

  if (facts.length === 2) {
    return { matched: true, titleIndex: 0, descriptionIndex: 1, matchedBy: 'position' };
  }

  return {
    matched: false,
    reason:
      `no box is labelled in English and there are ${facts.length} of them rather than the ` +
      `two a metadata form has, so which is the title cannot be read from position: ` +
      `${describeTextboxes(facts)}`,
  };
}

// --------------------------------------------------------------------------- DOM

/**
 * Studio's live surfaces, by URL.
 *
 * THIS ONE IS A GATE, and it is the one place this module deliberately departs from
 * monetization.ts. That module finds its control purely by shape and never looks at the
 * URL, because "a radio group holding exactly one ON answer and exactly one OFF answer"
 * is specific enough to be unambiguous anywhere in Studio. "Two contenteditable
 * textboxes" is NOT: a playlist's edit page and the channel customization page are both
 * a name box above a description box, and a positional read there would offer to write a
 * video's title over a playlist's — or a channel's. The URL is the second discriminator
 * that shape alone cannot supply.
 *
 * Both live routes are here because Studio has two: the control room for one stream
 * (/video/<id>/livestreaming) and the channel live dashboard (/channel/<cid>/livestreaming),
 * which opens stream details in a DIALOG over the same href — which is why readiness below
 * still has to be answered by looking for the fields rather than by this test alone.
 */
export function isLivestreamUrl(): boolean {
  return /\/(video|channel)\/[^/]+\/livestreaming/.test(location.pathname);
}

/**
 * Tag name of the nearest ancestor that is a custom element.
 *
 * "Contains a dash" IS the definition of a custom-element name, so this needs no list of
 * Studio's own prefixes to keep up to date — which matters because naming the prefixes
 * (ytcp-, ytls-, tp-yt-) is precisely the guess this module is trying not to make.
 */
function hostTagOf(el: HTMLElement): string | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const tag = node.tagName.toLowerCase();
    if (tag.includes('-')) return tag;
  }
  return null;
}

/** Every visible metadata textbox on the page, in document order, with its facts. */
export function readTextboxes(): { els: HTMLElement[]; facts: TextboxFacts[] } {
  // querySelectorAll returns document order and `visibleAll` only filters, so the order
  // the positional branch depends on is preserved.
  const els = visibleAll<HTMLElement>('div#textbox');
  const facts = els.map((el): TextboxFacts => {
    const label = el.getAttribute('aria-label');
    return {
      ariaLabel: label === null ? null : label.replace(/\s+/g, ' ').trim(),
      host: hostTagOf(el),
    };
  });
  return { els, facts };
}

export type LivestreamFields =
  | { found: true; title: HTMLElement; description: HTMLElement; matchedBy: 'aria-label' | 'position' }
  | { found: false; reason: string };

/**
 * The title and description boxes of whatever metadata form is on screen.
 *
 * The reason is the whole point: it carries the markup that was actually there, plus the
 * URL, because the first thing anyone will ask about a miss is which Studio surface it
 * happened on.
 */
export function findLivestreamFields(): LivestreamFields {
  if (!isLivestreamUrl()) {
    // Named rather than silent: a caller that reached here has already failed to find the
    // verified selectors, so "there is no title box on this page" is about to be reported
    // somewhere, and the operator deserves to know it was the URL and not the markup that
    // ruled this out. If Studio ever opens stream details from a route this test does not
    // cover, this exact line in the shelf is the evidence — and the fix is the regex.
    return {
      found: false,
      reason: `${location.pathname} is not one of Studio's live routes, so the shape-based read of the metadata form did not run.`,
    };
  }

  const { els, facts } = readTextboxes();
  const choice = matchTextboxes(facts);

  if (!choice.matched) {
    return { found: false, reason: `This is a livestream surface, but ${choice.reason}` };
  }

  const title = els[choice.titleIndex];
  const description = els[choice.descriptionIndex];
  if (!title || !description) {
    return {
      found: false,
      reason: `Textbox ${choice.titleIndex}/${choice.descriptionIndex} vanished while it was being read.`,
    };
  }
  return { found: true, title, description, matchedBy: choice.matchedBy };
}

/**
 * Is a livestream metadata form on screen right now?
 *
 * Answered by looking for the fields rather than by URL, for monetizationSurfaceReady's
 * reason: the live dashboard opens stream details in a dialog over the SAME page, with no
 * navigation and no url change, so there is nothing else to test.
 */
export function livestreamDetailsReady(): boolean {
  return findLivestreamFields().found;
}
