// The map between the master recording and the editor's timeline now lives in
// electron/shared/master-timeline-map.ts, compiled by BOTH the main process and this app, so the
// Thumbnails tab (main) and the editor (here) read one mapping, never two copies (LEDGER law 10).
export * from '../../../../../../electron/shared/master-timeline-map';
