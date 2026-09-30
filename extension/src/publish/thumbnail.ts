// Setting a video's custom thumbnail in YouTube Studio.
//
// WHY THIS IS ITS OWN MODULE, and not two more lines in dom.ts: every other field the
// extension writes is text going into an element that already exists on the page. This
// one is a FILE going into an `<input type="file">`, and a file input is the one control
// a script cannot simply assign to — `input.value = '/some/path'` throws, by design,
// because a page that could name a file could read the disk.
//
// The only way in is a DataTransfer: build a File in the page's own JS, put it on a
// DataTransfer's file list, hand that list to the input's `files` property, and dispatch
// the `change` event the uploader is listening for. That is a genuine user-gesture-shaped
// sequence as far as the page is concerned, and it is the same mechanism a drag-and-drop
// onto the page would produce.
//
// ── Where the bytes come from ────────────────────────────────────────────────────────
//
// Not from disk. The thumbnail lives on Callisto and a content script has no filesystem;
// ContentStudio reads and RE-VALIDATES the file and serves the bytes base64 over its
// localhost routes (publish-bridge.getThumbnail), which reach here through the service
// worker for the reason every other call does — see publish-messages.ts.
//
// ── What it will not do ──────────────────────────────────────────────────────────────
//
// It does not save. Nothing in this extension presses Studio's Save button, and this is
// no exception: the operator sees the image land in the form and decides.
//
// It does not click "Upload file", "Replace", or the thumbnail testing controls. Studio
// keeps an `ytcp-thumbnails-experiment-editor` on the same page (see fillers.ts's warning
// about it), and a click aimed at the wrong one of these enrols the video in a thumbnail
// A/B test that nobody asked for. The file input is addressed directly and nothing else
// is touched.
//
// NOT YET VERIFIED AGAINST LIVE STUDIO. The selectors below were written from Studio's
// published DOM shape, and the module is built so that a miss is LOUD: every path either
// sets the file and confirms the input now holds it, or throws naming what it could not
// find. There is no branch that reports success without having read the file back off the
// input.

import { FillError, waitFor } from './dom';
import type { PublishThumbnail } from './publish-client';

/**
 * Where Studio's custom-thumbnail file input lives, most specific first.
 *
 * A DECLARED TABLE, in order, and each entry is a whole answer rather than a fragment to
 * be combined: the first one that matches an element on the page wins, and if none do,
 * nothing is guessed. The order matters because the LAST entry is the loose one — any
 * image-accepting file input in the details form — and it is last precisely because it
 * could match something else if Studio ever grows a second image picker. Reaching it is
 * still better than failing, but only after the named ones have been tried.
 *
 * `#file-loader` inside `ytcp-thumbnail-uploader` is the control Studio has used for the
 * custom thumbnail since the 2021 redesign.
 */
const THUMBNAIL_INPUT_SELECTORS: readonly string[] = [
  'ytcp-thumbnail-uploader input[type="file"]',
  'ytcp-video-thumbnail-editor input[type="file"]',
  '#thumbnail-uploader input[type="file"]',
  'input#file-loader[type="file"]',
  'input[type="file"][accept*="image"]',
];

/**
 * Whether a file input belongs to Studio's A/B dialog rather than the details form.
 *
 * The A/B dialog's "Title and thumbnail" test puts a `ytcp-thumbnail-uploader` with its own
 * `input#file-loader` on every variant row — the SAME markup as the video's own thumbnail
 * control. While that dialog is open, the first selector below would match row 1 of the
 * test as readily as the video's thumbnail, and in the upload wizard the details form is
 * itself inside a dialog, so "inside any dialog" cannot be the test. What marks the A/B
 * dialog is holding MORE THAN ONE uploader (three rows); the details form holds one.
 */
function insideAbDialog(input: HTMLInputElement): boolean {
  const dialog = input.closest('ytcp-dialog, tp-yt-paper-dialog');
  return !!dialog && dialog.querySelectorAll('ytcp-thumbnail-uploader').length > 1;
}

/**
 * The video's own thumbnail file input, or null. Never one of the A/B test's rows.
 *
 * NOT filtered by visibility, unlike dom.ts's `visible()`. A file input attached to a
 * styled "Upload file" button is deliberately zero-sized — that is how every such control
 * on the web is built — so requiring a bounding box would reject the very element being
 * looked for.
 */
export function findThumbnailInput(): HTMLInputElement | null {
  for (const selector of THUMBNAIL_INPUT_SELECTORS) {
    for (const el of document.querySelectorAll<HTMLInputElement>(selector)) {
      if (!insideAbDialog(el)) return el;
    }
  }
  return null;
}

/** Whether the page currently offers anywhere to put a thumbnail. */
export function thumbnailSurfaceReady(): boolean {
  return findThumbnailInput() !== null;
}

/**
 * Base64 back to bytes, checked against the length the app measured.
 *
 * The check is not decoration. `atob` will happily decode a truncated string into a
 * shorter, still-valid-looking buffer, and a truncated PNG handed to Studio uploads as a
 * corrupt image that looks fine in the form. If the two lengths disagree, something ate
 * part of the payload on the way here and the only honest thing to do is say so.
 */
function decodeBase64(thumbnail: PublishThumbnail): ArrayBuffer {
  let binary: string;
  try {
    binary = atob(thumbnail.base64);
  } catch (cause) {
    throw new FillError(
      `ContentStudio's thumbnail for ${thumbnail.filename} did not decode as base64. ` +
        `Nothing was set.`,
    );
  }
  if (binary.length !== thumbnail.bytes) {
    throw new FillError(
      `ContentStudio said ${thumbnail.filename} is ${thumbnail.bytes} bytes but ` +
        `${binary.length} arrived. The image was cut short in transit; nothing was set.`,
    );
  }
  // The ArrayBuffer is what comes back, not the view over it: File/Blob will not accept a
  // typed array that might be backed by a SharedArrayBuffer, and it is right not to.
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return buffer;
}

/**
 * Put one thumbnail into Studio's file input, and confirm it landed.
 *
 * Returns the filename Studio now holds. Throws a FillError naming what went wrong
 * otherwise — there is no "probably worked" return.
 */
export async function setStudioThumbnail(thumbnail: PublishThumbnail): Promise<string> {
  const input = findThumbnailInput();
  if (!input) {
    throw new FillError(
      `No thumbnail file input on this page. Open the video's Details page (or the ` +
        `upload wizard's Details step) — the thumbnail control is not on Monetization or ` +
        `Analytics.`,
    );
  }
  if (input.disabled) {
    throw new FillError(
      `Studio's thumbnail input is disabled on this page. That is usually a channel ` +
        `without custom-thumbnail permission, or a video still processing.`,
    );
  }
  return setThumbnailOnInput(input, thumbnail, "Studio's thumbnail input");
}

/**
 * How long Studio gets to take a file: its uploader turns `is-ongoing-transfer` on while it reads
 * the file and off when the picture is in (about a second live), so this is a generous ceiling.
 */
const TAKE_MS = 15_000;

/**
 * Put one thumbnail into a GIVEN file input, and confirm Studio's uploader took it.
 *
 * The mechanism both callers share: the video's own thumbnail above, and each row of the
 * A/B dialog's "Title and thumbnail" test (fillers.ts), which finds its inputs itself —
 * strictly inside that dialog. `what` names the input in every error, so a failure says
 * which one it was.
 *
 * THE PROOF, as seen live 2026-09-30. Studio's uploaders EMPTY their input once they have the
 * file, so the input is no proof at all (reading it back failed every fill after the first
 * picture: "dropped straight back out", with the picture on screen). And the picture changing
 * is no proof either: putting in the same picture a row already shows (Fill everything sets
 * the video's thumbnail, which is A/B row 1, just before the A/B action) changes nothing on
 * screen. What Studio does every time, same picture or not, is turn the uploader's
 * `is-ongoing-transfer` on while it takes the file and off when it is done. So: that flag
 * seen on and then off, and the uploader then showing a picture made from a file (`data:`).
 */
export async function setThumbnailOnInput(
  input: HTMLInputElement,
  thumbnail: PublishThumbnail,
  what: string,
): Promise<string> {
  if (input.disabled) {
    throw new FillError(`${what} is disabled, so ${thumbnail.filename} could not be put into it.`);
  }
  const uploader = input.closest<HTMLElement>('ytcp-thumbnail-uploader');
  if (!uploader) {
    throw new FillError(
      `${what} is not inside Studio's thumbnail uploader (ytcp-thumbnail-uploader), so there is ` +
        `no way to see whether it took ${thumbnail.filename}. Nothing was set.`,
    );
  }

  const bytes = decodeBase64(thumbnail);
  const file = new File([bytes], thumbnail.filename, { type: thumbnail.mime });

  // Watched from BEFORE the file goes in: the flag can go on and off again within one tick.
  let started = false;
  let finished = false;
  const observer = new MutationObserver(() => {
    if (uploader.hasAttribute('is-ongoing-transfer')) started = true;
    else if (started) finished = true;
  });
  observer.observe(uploader, { attributes: true, attributeFilter: ['is-ongoing-transfer'] });

  try {
    // A DataTransfer is the only object whose `files` a FileList can be built from, and
    // `input.files` is the only way a file gets into a file input from script. Assigning
    // `input.value` throws; there is no third option and nothing here falls back to one.
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;

    // Both events, in this order, because Studio's uploader is Polymer: `input` is what a
    // two-way binding listens for and `change` is what a plain listener does, and which one
    // this particular element uses is not something to be confident about from outside.
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));

    await waitFor(() => started || null, `Studio to start taking ${thumbnail.filename} (${what})`, TAKE_MS).catch(() => {
      throw new FillError(`Studio never started taking ${thumbnail.filename} from ${what}. The image was not set.`);
    });
    await waitFor(() => finished || null, `Studio to finish taking ${thumbnail.filename} (${what})`, TAKE_MS).catch(() => {
      throw new FillError(`Studio started taking ${thumbnail.filename} from ${what} but did not finish within ${TAKE_MS / 1000} s. Check the picture before saving.`);
    });
  } finally {
    observer.disconnect();
  }

  const shown = [...uploader.querySelectorAll<HTMLImageElement>('img')].some((img) =>
    (img.getAttribute('src') || '').startsWith('data:image/'),
  );
  if (!shown) {
    throw new FillError(
      `Studio took ${thumbnail.filename} from ${what} but shows no picture made from it. ` +
        `It may have refused the image; check the picture before saving.`,
    );
  }
  return thumbnail.filename;
}
