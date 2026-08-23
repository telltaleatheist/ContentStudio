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

import { FillError, sleep } from './dom';
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
 * The thumbnail file input, or null.
 *
 * NOT filtered by visibility, unlike dom.ts's `visible()`. A file input attached to a
 * styled "Upload file" button is deliberately zero-sized — that is how every such control
 * on the web is built — so requiring a bounding box would reject the very element being
 * looked for.
 */
export function findThumbnailInput(): HTMLInputElement | null {
  for (const selector of THUMBNAIL_INPUT_SELECTORS) {
    const el = document.querySelector<HTMLInputElement>(selector);
    if (el) return el;
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

  const bytes = decodeBase64(thumbnail);
  const file = new File([bytes], thumbnail.filename, { type: thumbnail.mime });

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

  // The same 300ms the monetization step waits before reading its radio back: long enough
  // for Polymer's microtask flush and the uploader's own handler, short enough that a
  // failure is reported while the operator is still looking at the page.
  await sleep(300);

  const landed = input.files?.[0];
  if (!landed) {
    throw new FillError(
      `Studio dropped ${thumbnail.filename} straight back out of its thumbnail input. ` +
        `The image was not set.`,
    );
  }
  if (landed.name !== thumbnail.filename || landed.size !== thumbnail.bytes) {
    throw new FillError(
      `Studio's thumbnail input holds ${landed.name} (${landed.size} bytes) rather than ` +
        `${thumbnail.filename} (${thumbnail.bytes} bytes). Something else wrote to it; ` +
        `check the image before saving.`,
    );
  }
  return landed.name;
}
