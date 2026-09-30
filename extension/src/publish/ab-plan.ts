// What the A/B fill will set up, decided BEFORE anything on the page is touched.
//
// PURE, and on its own for that reason: no DOM, no chrome.*, no imports. Every refusal the
// A/B action can give without looking at Studio is decided here, so the whole decision can
// be checked offline (tools/ab-thumbnails-checks.js bundles this file and runs it under
// node), and fillers.ts is left with the part that genuinely needs a page: finding the
// dialog, clicking the chip, and confirming what landed.
//
// ── The rule (LEDGER #250) ───────────────────────────────────────────────────────────
//
// Studio's A/B dialog offers three tests on one chip bar: "Title only", "Thumbnail only",
// "Title and thumbnail". ContentStudio uses the first and the third:
//
//   * no thumbnails saved               -> "Title only", the chosen titles
//   * ONE thumbnail saved               -> "Title only" too: one image is the video's own
//                                          thumbnail (the separate Thumbnail action sets
//                                          it), not something to test; the fill says so
//   * n thumbnails saved (2-3), n titles-> "Title and thumbnail", pair k = title k + Pick k
//   * anything else                     -> refused, in plain words, before any click
//
// Two or more that do not match the titles are REFUSED rather than trimmed to the shorter
// list. Pairing three titles with two images would either leave Studio's row 3
// half-filled (which it refuses) or quietly drop a title Owen chose; both are a test he
// did not set up. (Owen, 2026-09-30: he may save only one thumbnail, and then wants the
// titles tested with it as the video's thumbnail — so one is a plan, not a refusal.)

/**
 * Studio's three tests, by the chip's position in the dialog's chip bar.
 *
 * Positions, not labels: the chips carry `id="chip-0"` .. `chip-2` in a fixed order, and
 * their visible text ("Title only", …) is localized English — the same policy as the
 * variant slots (fillers.ts header).
 */
export const AB_CHIP = {
  titleOnly: 0,
  thumbnailOnly: 1,
  titleAndThumbnail: 2,
} as const;

export type AbPlan =
  | {
      kind: 'fill';
      mode: 'titles';
      chip: typeof AB_CHIP.titleOnly;
      count: number;
      /** 0 or 1: how many thumbnails were saved (one is the video's own, not tested). */
      savedThumbnails: number;
      summary: string;
    }
  | {
      kind: 'fill';
      mode: 'titles-and-thumbnails';
      chip: typeof AB_CHIP.titleAndThumbnail;
      count: number;
      summary: string;
    }
  | { kind: 'refuse'; reason: string };

/**
 * What the A/B action will do with this many titles and saved thumbnails.
 *
 * `thumbnailCount` is `undefined` when ContentStudio is too old to say (it predates the
 * count on the item detail). That is refused with its own wording, never read as 0: an app
 * that cannot serve the picks would otherwise turn Owen's title-and-thumbnail test into a
 * titles-only one without a word — the hasThumbnail rule, applied to the picks.
 */
export function planAbTest(titleCount: number, thumbnailCount: number | undefined): AbPlan {
  if (titleCount < 2) {
    return { kind: 'refuse', reason: `Pick at least 2 titles (${titleCount} chosen)` };
  }
  if (thumbnailCount === undefined) {
    return {
      kind: 'refuse',
      reason: 'This ContentStudio is older than the A/B thumbnails — update the app',
    };
  }
  if (!Number.isInteger(thumbnailCount) || thumbnailCount < 0) {
    return {
      kind: 'refuse',
      reason: `ContentStudio sent ${JSON.stringify(thumbnailCount)} as the number of saved thumbnails — update the app`,
    };
  }

  if (thumbnailCount === 0) {
    return {
      kind: 'fill',
      mode: 'titles',
      chip: AB_CHIP.titleOnly,
      count: titleCount,
      savedThumbnails: 0,
      summary: `${titleCount} titles, no thumbnails saved`,
    };
  }
  if (thumbnailCount === 1) {
    // One image has nothing to be compared with: it is the video's thumbnail (Pick 1 is
    // what the Thumbnails window sets as it), and the titles are tested on their own.
    return {
      kind: 'fill',
      mode: 'titles',
      chip: AB_CHIP.titleOnly,
      count: titleCount,
      savedThumbnails: 1,
      summary: `${titleCount} titles; the 1 saved thumbnail is the video's own, not tested`,
    };
  }
  if (thumbnailCount < titleCount) {
    return {
      kind: 'refuse',
      reason:
        `${titleCount} titles but ${thumbnailCount} thumbnails saved — save a thumbnail for ` +
        `each title in ContentStudio's Thumbnails window, or drop a title`,
    };
  }
  if (thumbnailCount > titleCount) {
    return {
      kind: 'refuse',
      reason:
        `${titleCount} titles but ${thumbnailCount} thumbnails saved — pick a title for each ` +
        `thumbnail, or remove a thumbnail in ContentStudio's Thumbnails window`,
    };
  }
  return {
    kind: 'fill',
    mode: 'titles-and-thumbnails',
    chip: AB_CHIP.titleAndThumbnail,
    count: titleCount,
    summary: `${titleCount} titles and ${thumbnailCount} thumbnails`,
  };
}

/**
 * The images that arrived at fill time, checked against the plan made from the count.
 *
 * The count on the item detail was read when the shelf loaded; the images are fetched when
 * the button is pressed, and Owen can save in the Thumbnails window in between. A mismatch
 * is refused naming both numbers, before anything is put into Studio, so the test is always
 * set from one reading of his picks.
 */
export function checkArrivedThumbnails(planned: number, arrived: number): string | null {
  if (planned === arrived) return null;
  return (
    `ContentStudio had ${planned} thumbnails saved for the test when this page loaded and ` +
    `sent ${arrived} now — reload the report in the shelf and fill again`
  );
}

/**
 * What pressing Studio's A/B button led to, from what is on screen.
 *
 *   'dialog'   the A/B dialog, with its variant slots
 *   'confirm'  Studio's "Run a new test?" question: a test already exists on this video,
 *              and its Continue deletes that test ON THE SERVER at once — not on Save.
 *              The extension never presses it; the operator decides.
 *   'nothing'  neither (yet)
 *
 * The slots win when both are somehow present: the question has been answered once the
 * dialog with slots is up.
 */
export type AbOpenState = 'dialog' | 'confirm' | 'nothing';

export function classifyAbOpen(slotCount: number, confirmOpen: boolean): AbOpenState {
  if (slotCount >= 2) return 'dialog';
  if (confirmOpen) return 'confirm';
  return 'nothing';
}
