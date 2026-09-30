// The thumbnail layout and drawing live in electron/shared/, compiled by BOTH the main process (the
// final render) and this app (the Thumbnails window's live card previews), so a card is placed and
// drawn by the same code that writes its PNG (LEDGER law 10). Import them from here.
export * from '../../../../../electron/shared/thumbnail-layout';
export * from '../../../../../electron/shared/thumbnail-draw';
