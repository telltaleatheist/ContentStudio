/**
 * Offscreen document: turns CSV text into a blob: URL for chrome.downloads.
 *
 * MV3 service workers have no URL.createObjectURL, so large exports would otherwise have
 * to go through a data: URL — and those hit a size ceiling in Chrome somewhere around a
 * couple of megabytes. A big channel can exceed that, and the failure mode is an
 * auto-save that silently never happens at the end of a long unattended scan.
 *
 * This document exists only long enough to mint the URL.
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'make-blob-url') return false;
  try {
    const blob = new Blob([message.text], { type: 'text/csv;charset=utf-8' });
    sendResponse({ ok: true, url: URL.createObjectURL(blob) });
  } catch (err) {
    sendResponse({ ok: false, error: err?.message || String(err) });
  }
  return true;
});
