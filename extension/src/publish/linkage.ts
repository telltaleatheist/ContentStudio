// What the shelf says about the relationship between the report the operator is holding
// and the Studio page underneath it.
//
// WHY THIS IS A NOTE AND NOT A GATE. Matching a report to a video is an exact filename
// join (page.ts's header explains why the extension is the only place that join is even
// possible), and it is a very good DEFAULT: nine times out of ten the report the operator
// wants is the one whose source file Studio is printing in its sidebar. But it is only a
// default. The operator has real workflows with no match at all and never will have one:
//
//   * metadata generated from a TEXT SUBJECT — there is no source video, so there is no
//     filename to join on — filled into a livestream created minutes before going live;
//   * a report deliberately re-used on a second video (a re-upload, a re-cut, a stream
//     of the same material) which is linked to the first one.
//
// A gate turns both of those into "the extension refuses". So the mismatch is DECLARED
// and the fill proceeds on the operator's click. That is not a weakening of the safety
// story: the shelf never auto-fills anything (shelf.ts's header), so a wrong report can
// only ever reach a form because a human read this note and clicked anyway.
//
// PURE, and takes facts rather than reading anything, for the same reason monetization.ts
// splits the same way: the wording is the part that has to be right and the part a
// checkout can actually exercise.
//
// ONE COMPARISON RULE, DELIBERATELY DUMB. This module compares videoIds by string
// identity and filenames by string identity, and does no normalization whatsoever.
// Normalized filename matching is the APP's join (publish-bridge.resolveForPage, via
// normalizeForMatch) and it stays there — a second, subtly different implementation of
// the join living in the extension is exactly the drift the bridge's header forbids.
// Identical strings are the same file under any normalization, so exact equality can only
// ever under-claim a match, and under-claiming shows the operator both filenames and lets
// them decide.

import type { ItemDetail } from './publish-client';

/** The facts the note is written from. Everything here is already on screen somewhere. */
export interface LinkageFacts {
  /** videoId ContentStudio has this report linked to, or null when it is linked to none. */
  itemVideoId: string | null;
  /** Basename the report was generated from; null for a text subject or a compilation. */
  itemSourceFilename: string | null;
  /** The video this Studio page is editing, or null when the URL carries no id. */
  pageVideoId: string | null;
  /** The original filename Studio prints in its sidebar, or null when it prints none. */
  pageFilename: string | null;
}

/**
 * How the report relates to the page.
 *
 * `agree` and `differ` are the two that matter; `unknown` is the honest third answer for
 * a page that does not publish enough about itself to say either way (the live control
 * room prints no filename sidebar, so a report generated from a file cannot be confirmed
 * or denied there). All three fill on a click — the kind only decides the wording and the
 * colour.
 */
export type LinkageKind = 'agree' | 'differ' | 'unknown';

export interface Linkage {
  kind: LinkageKind;
  /** One sentence for the operator, naming both sides. Never empty. */
  note: string;
}

/** Quote a name the way the rest of the shelf does, so a trailing space is visible. */
function quoted(name: string): string {
  return JSON.stringify(name);
}

/**
 * The note for one report on one page.
 *
 * Ordered most to least authoritative, the same order publish-bridge.resolveForPage uses
 * to CHOOSE a report — an explicit videoId link beats a filename, and a filename beats
 * nothing — because a note that ranked its evidence differently from the resolver would
 * describe a decision nobody made.
 */
export function describeLinkage(facts: LinkageFacts): Linkage {
  const { itemVideoId, itemSourceFilename, pageVideoId, pageFilename } = facts;

  if (itemVideoId) {
    if (pageVideoId && itemVideoId === pageVideoId) {
      return { kind: 'agree', note: 'Linked to the video on this page.' };
    }
    const source = itemSourceFilename ? ` (${quoted(itemSourceFilename)})` : '';
    if (pageVideoId) {
      return {
        kind: 'differ',
        note:
          `Linked to video ${itemVideoId}${source} — you are on ${pageVideoId}. ` +
          `Filling writes it here anyway and re-links the report to this video.`,
      };
    }
    return {
      kind: 'unknown',
      note:
        `Linked to video ${itemVideoId}${source} — this page carries no video id, so the ` +
        `fill cannot be recorded against one.`,
    };
  }

  if (!itemSourceFilename) {
    return {
      kind: 'unknown',
      note: 'Generated from a text subject — no source video to match against this page.',
    };
  }

  if (!pageFilename) {
    return {
      kind: 'unknown',
      note:
        `Generated from ${quoted(itemSourceFilename)} — this page prints no filename, so ` +
        `nothing here confirms it is the same video.`,
    };
  }

  if (pageFilename === itemSourceFilename) {
    return { kind: 'agree', note: `Generated from ${quoted(itemSourceFilename)}, the file on this page.` };
  }

  return {
    kind: 'differ',
    note:
      `Generated from ${quoted(itemSourceFilename)} — this page is ${quoted(pageFilename)}. ` +
      `Filling writes it here anyway.`,
  };
}

/** The same note, read off the two objects the shelf already holds. */
export function linkageOf(
  item: ItemDetail,
  page: { videoId: string | null; filename: string | null },
): Linkage {
  return describeLinkage({
    itemVideoId: item.videoId,
    itemSourceFilename: item.sourceFilename,
    pageVideoId: page.videoId,
    pageFilename: page.filename,
  });
}
