// Reading the Studio details page: which video is open, and what the uploaded file was.
//
// The filename is the load-bearing bit. The Data API refuses to return
// fileDetails.fileName (verified: it comes back undefined even when
// fileDetailsAvailability is "available"), but Studio prints it in the right-hand
// sidebar — so the extension is the only place the exact original filename is
// obtainable, which is what makes matching an exact join instead of fuzzy guesswork.

import { visible, visibleAll } from './dom';
import { isLivestreamUrl, livestreamDetailsReady } from './livestream';

/**
 * The video currently open for editing.
 *
 * TWO shapes, because Studio has two ways in and the operator normally uses the second:
 *   1. standalone page   /video/<id>/edit
 *   2. upload wizard     /channel/<cid>/videos/upload?...&udvid=<id>   <- "Edit draft"
 *
 * The wizard is a modal over the channel content list (Details -> Monetization ->
 * Video elements -> Checks -> Visibility) and carries the id in `udvid`.
 */
export function videoIdFromUrl(): string | null {
  const fromPath = location.pathname.match(/\/video\/([^/]+)\//);
  if (fromPath?.[1]) return fromPath[1];

  const udvid = new URLSearchParams(location.search).get('udvid');
  return udvid && udvid.trim() ? udvid : null;
}

/**
 * The video id ONLY when Studio is on the standalone edit page /video/<id>/edit.
 *
 * Narrower than videoIdFromUrl() on purpose: the nav strip navigates BETWEEN videos, and
 * the upload wizard is a modal over the channel content list with its own unsaved state.
 * Throwing a hard navigation at it would drop whatever the operator had half-entered, so
 * the strip is simply not mounted there.
 */
export function videoEditId(): string | null {
  const match = location.pathname.match(/\/video\/([^/]+)\/edit/);
  return match?.[1] ?? null;
}

/** True wherever the video metadata form is available — either entry point. */
export function isDetailsPage(): boolean {
  if (/\/video\/[^/]+\/edit/.test(location.pathname)) return true;
  // Upload wizard: only counts once a specific video is open (udvid present).
  return /\/videos\/upload\/?$/.test(location.pathname) && !!videoIdFromUrl();
}

/**
 * True on Studio's live surfaces — the control room and the channel live dashboard.
 *
 * DELIBERATELY SEPARATE from isDetailsPage rather than folded into it. isDetailsPage
 * answers "the upload/edit metadata form is here, and its filename sidebar with it", and
 * two callers depend on exactly that: resolveCurrentVideo waits up to 15 seconds for the
 * form before reading the sidebar off it, and the filename join needs the sidebar to
 * exist. Neither holds on a live surface — the control room prints no filename sidebar at
 * all, and its details form is behind an Edit control the operator may never have opened —
 * so a live page that answered true to isDetailsPage would sit in a fifteen-second wait
 * and then report a page that is loaded fine as "Studio has not finished loading".
 *
 * See livestream.ts for why the FORM is found by shape rather than by this URL: the live
 * dashboard opens stream details in a dialog over the same href.
 */
export function isLivestreamPage(): boolean {
  return isLivestreamUrl();
}

/**
 * The original uploaded filename, e.g. `f2 - amanda grace.mov`.
 *
 * Structure (verified live): inside `ytcp-video-info`, a `div.label` whose text is
 * "Filename" followed by a sibling `div.value` holding the name. The LABEL TEXT IS
 * LOCALIZED, so fall back to a shape-based scan (any .value that looks like a media
 * filename) when the English label isn't found.
 */
export function readFilename(): string | null {
  const info = document.querySelector('ytcp-video-info');
  if (!info) return null;

  const labels = [...info.querySelectorAll<HTMLElement>('div.label')];

  const labelled = labels.find((l) => /^filename$/i.test((l.textContent || '').trim()));
  if (labelled) {
    const value = (labelled.nextElementSibling?.textContent || '').trim();
    if (value) return value;
  }

  // Locale fallback: the only sidebar value that looks like a media file.
  for (const el of info.querySelectorAll<HTMLElement>('div.value')) {
    const text = (el.textContent || '').trim();
    if (/\.(mov|mp4|mkv|avi|m4v|webm|mpg|mpeg|wmv|flv)$/i.test(text)) return text;
  }
  return null;
}

/**
 * Draft indicator. Differs by entry point: the standalone page shows a banner, the
 * upload wizard shows a "Saved as draft" chip in the modal header.
 */
export function looksLikeDraft(): boolean {
  const text = document.body.innerText || '';
  return /this video is in a draft state/i.test(text) || /saved as draft/i.test(text);
}

/** Whether the page currently has unsaved changes. */
export function hasUnsavedChanges(): boolean {
  const save = visibleAll<HTMLElement>('ytcp-button').find((b) =>
    /^save$/i.test((b.textContent || '').trim()),
  );
  if (!save) return false;
  return !(save.hasAttribute('disabled') || save.getAttribute('aria-disabled') === 'true');
}

/**
 * Wait until the details form has actually rendered.
 *
 * Studio is an SPA: the content script fires long before the form exists, and again the
 * URL can change without a reload.
 *
 * Two checks because the title box's aria-label is a placeholder-style string that is not
 * guaranteed on a video that already HAS a title (published and scheduled videos, which
 * are valid fill targets — only YouTube's A/B test needs a non-draft). The metadata editor
 * element is the structural fact; the title box is the fast path.
 *
 * A THIRD check, added for the live surfaces, and it is the weakest of the three on
 * purpose. `ytcp-video-metadata-editor` is the upload/edit form's own host element and is
 * not guaranteed to be what Studio renders inside the live control room or the live
 * dashboard's edit dialog, so those forms are recognised by their SHAPE instead — see
 * livestream.ts, which is scoped to Studio's live routes and dumps the markup it found on
 * every miss. It runs last because the first two are verified live and this one is not:
 * on the surfaces that were verified, this branch is never reached.
 */
export function detailsFormReady(): boolean {
  return (
    !!visible('div#textbox[aria-label^="Add a title"]') ||
    !!visible('ytcp-video-metadata-editor') ||
    livestreamDetailsReady()
  );
}
