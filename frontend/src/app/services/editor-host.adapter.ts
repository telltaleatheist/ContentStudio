// src/app/services/editor-host.adapter.ts
//
// ContentStudio's implementation of the editor's port (components/editor/editor-host.ts).
// This is the ONLY place the editor and this application's service layer meet.
//
// Thin pass-throughs only. Anything with logic in it belongs on one side or the other, not
// here: a fat adapter is behaviour the next host would have to reimplement from scratch,
// which is exactly what the port exists to prevent.
//
// This file stays OUTSIDE components/editor/ — it is host code, and it does not travel.
//
// Both optional groups are implemented, because ContentStudio has both surfaces: the Inputs
// queue is the titling queue `sendSubjectsToTitles` pushes to, and the editor backend ports
// AutoCutStudio's archive-sync wholesale, so all eight archive members are real here.

import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';

import { ElectronService } from './electron';
import { EditorProcessingService } from './editor-processing.service';
import type { EditorManifest } from '../components/editor/host-data/editor-manifest';
import type {
  ArchiveCheck, ArchiveDeleteProgress, ArchiveProgress, ArchiveQueue, ArchiveResult, ArchiveStatus,
  ArchiveSyncedEntry,
  AssetComponentStatus, AssetInstallProgress, AssetInstallResult, AssetPaths,
  DeleteLocalWeekResult, DeleteRemoteWeekResult, EditorHost, ProcessingJob,
  ProjectScanResult, ProjectsRegistry, RemoteWeekListing, TitleHandoff
} from '../components/editor/editor-host';

@Injectable()
export class EditorHostAdapter implements EditorHost {
  constructor(
    private electron: ElectronService,
    private processing: EditorProcessingService
  ) {}

  /**
   * Strip Electron's IPC wrapper off a rejection, so the port's callers get the message the
   * main process actually wrote.
   *
   * `ipcRenderer.invoke` re-throws a handler's error as
   * `Error invoking remote method 'editor:delete-local-week': Error: <the real message>`.
   * The archive handlers put real sentences in there — "2 files (4.1 GB) would still be
   * uploaded", "cancel the queued sync first" — and the sidebar prints the rejection verbatim
   * on the confirm row, so the operator has been reading the channel name and two "Error:"
   * prefixes ahead of the part that tells them what to do.
   *
   * This is not the "logic" this file's header rules out; it is the opposite. The port
   * promises callers a reason, Electron is the one host that wraps it, and translating a
   * host-specific representation into the port's contract is precisely an adapter's job. A
   * web-backed host would have nothing to unwrap and would need no equivalent.
   */
  private async unwrap<T>(work: Promise<T>): Promise<T> {
    try {
      return await work;
    } catch (err: any) {
      const raw = err instanceof Error ? err.message : String(err);
      const inner = raw.match(/Error invoking remote method '[^']*':\s*([\s\S]*)$/);
      const message = (inner ? inner[1] : raw).replace(/^Error:\s*/, '').trim();
      // An empty message would leave the confirm row blank, which reads as "nothing
      // happened" — keep the original rather than show nothing.
      throw new Error(message || raw || 'The archive operation failed with an empty error.');
    }
  }

  // ── Environment ─────────────────────────────────────────────────────────────

  isElectron(): boolean {
    return this.electron.isElectron();
  }

  // ── Session payload & manifest ──────────────────────────────────────────────

  getEditorPayload(): Promise<{ zipPath: string } | null> {
    return this.electron.getEditorPayload();
  }

  onEditorPayload(callback: (payload: { zipPath: string }) => void): void {
    this.electron.onEditorPayload(callback);
  }

  removeEditorListeners(): void {
    this.electron.removeEditorListeners();
  }

  getEditorManifest(zipPath: string): Promise<EditorManifest> {
    return this.electron.getEditorManifest(zipPath);
  }

  // ── Edit state ──────────────────────────────────────────────────────────────

  loadEditorEdits(payload: { zipPath: string }): Promise<any | null> {
    return this.electron.loadEditorEdits(payload);
  }

  saveEditorEdits(payload: { zipPath: string; edits: any }): Promise<{ path: string }> {
    return this.electron.saveEditorEdits(payload);
  }

  clearEditorSessionState(payload: { zipPath: string }): Promise<{ removed: string[] }> {
    return this.electron.clearEditorSessionState(payload);
  }

  // ── Export ──────────────────────────────────────────────────────────────────

  exportEditorCuts(payload: Parameters<ElectronService['exportEditorCuts']>[0]): Promise<any> {
    return this.electron.exportEditorCuts(payload);
  }

  // ── Transcription ───────────────────────────────────────────────────────────

  transcribeSession(payload: { zipPath: string }): Promise<{ jobId: string }> {
    return this.electron.transcribeSession(payload);
  }

  cancelTranscription(payload: { jobId: string }): Promise<any> {
    return this.electron.cancelTranscription(payload);
  }

  onTranscribeProgress(callback: (data: { jobId: string; progress: number; message: string }) => void): void {
    this.electron.onTranscribeProgress(callback);
  }

  onTranscribeComplete(
    callback: (data: { jobId: string; exitCode: number; result: any; errorMessage?: string }) => void
  ): void {
    this.electron.onTranscribeComplete(callback);
  }

  removeTranscribeListeners(): void {
    this.electron.removeTranscribeListeners();
  }

  loadTranscript(payload: { zipPath: string }): Promise<any> {
    return this.electron.loadTranscript(payload);
  }

  // ── Story analysis ──────────────────────────────────────────────────────────

  ollamaListModels(host?: string): Promise<{ connected: boolean; models: Array<{ id: string; name: string }> }> {
    return this.electron.ollamaListModels(host);
  }

  analyzeStoryChapters(payload: Parameters<ElectronService['analyzeStoryChapters']>[0]): Promise<any> {
    return this.electron.analyzeStoryChapters(payload);
  }

  suggestStoryTitle(payload: { text: string | string[]; model: string; host?: string }): Promise<{ title: string }> {
    return this.electron.suggestStoryTitle(payload);
  }

  cancelStoryAnalysis(): Promise<{ stopped: boolean }> {
    return this.electron.cancelStoryAnalysis();
  }

  unloadStoryModel(payload: { model: string; host?: string }): Promise<{ ok: boolean }> {
    return this.electron.unloadStoryModel(payload);
  }

  onStoryAnalyzeProgress(callback: (p: { phase: string; done: number; total: number }) => void): void {
    this.electron.onStoryAnalyzeProgress(callback);
  }

  removeStoryAnalyzeProgressListener(): void {
    this.electron.removeStoryAnalyzeProgressListener();
  }

  // ── Media ───────────────────────────────────────────────────────────────────

  alignmentExtractPeaks(opts: { filePath: string; startSec: number; durationSec: number; buckets: number }):
    Promise<{ success?: boolean; min?: number[]; max?: number[]; error?: any }> {
    return this.electron.alignmentExtractPeaks(opts);
  }

  // ── Files & dialogs ─────────────────────────────────────────────────────────
  //
  // Three of these are the one place the adapter is not name-for-name: ContentStudio already
  // owns `selectDirectory`, `readDirectory` and `showInFolder` for its own channels, so the
  // editor's ride prefixed methods. The port member names are unchanged — that is the point
  // of having an adapter at all.

  selectFile(options?: { title?: string; filters?: any[]; properties?: any[] }):
    Promise<{ canceled: boolean; filePaths: string[] }> {
    return this.electron.selectFile(options);
  }

  selectDirectory(options?: { title?: string }): Promise<{ canceled: boolean; filePaths: string[] }> {
    return this.electron.editorSelectDirectory(options);
  }

  readDirectory(dirPath: string): Promise<{ success: boolean; directories?: any[]; files?: any[] }> {
    return this.electron.editorReadDirectory(dirPath);
  }

  checkFileExists(filePath: string): Promise<{ exists: boolean }> {
    return this.electron.checkFileExists(filePath);
  }

  showInFolder(filePath: string): Promise<any> {
    return this.electron.editorShowInFolder(filePath);
  }

  getPathForFile(file: File): string {
    return this.electron.getPathForFile(file);
  }

  // ── Asset relinking ─────────────────────────────────────────────────────────

  getAssetConfig(): Promise<{ success: boolean; assetPaths?: AssetPaths; error?: string }> {
    return this.electron.getAssetConfig();
  }

  saveAssetConfig(assetPaths: AssetPaths): Promise<{ success: boolean; error?: string }> {
    return this.electron.saveAssetConfig(assetPaths);
  }

  searchFilesRecursive(opts: { rootPath: string; filenames: string[]; maxDepth?: number }):
    Promise<{ success: boolean; foundFiles?: Record<string, string>; error?: string }> {
    return this.electron.searchFilesRecursive(opts);
  }

  // ── Projects registry ───────────────────────────────────────────────────────

  readProjectsRegistry(): Promise<ProjectsRegistry> {
    return this.electron.readProjectsRegistry();
  }

  writeProjectsRegistry(registry: ProjectsRegistry): Promise<{ success: boolean }> {
    return this.electron.writeProjectsRegistry(registry);
  }

  scanProjectFolder(folderPath: string): Promise<ProjectScanResult> {
    return this.electron.scanProjectFolder(folderPath);
  }

  // ContentStudio can delete folders, so the optional member is implemented. The port name is
  // `deleteLocalWeek`; the bridge name carries the `editor` prefix its channel does.
  deleteLocalWeek(payload: { weekPath: string }): Promise<DeleteLocalWeekResult> {
    return this.unwrap(this.electron.editorDeleteLocalWeek(payload));
  }

  // ── Processing ──────────────────────────────────────────────────────────────

  autoDetectAudio(masterVideoPath: string): Promise<{
    success: boolean;
    audioFiles?: { [key: string]: string };
    videoFiles?: { [key: string]: string };
    error?: string;
  }> {
    return this.electron.autoDetectAudio(masterVideoPath);
  }

  listAssets(): Promise<{ success: boolean; components?: AssetComponentStatus[]; error?: string }> {
    return this.electron.listAssets();
  }

  // ── Installing the environment ──────────────────────────────────────────────
  //
  // ContentStudio downloads the editor's toolchain into the shared OwenMorgan location, so the
  // whole optional group is implemented. Names are the port's, which are also the bridge's.

  installAsset(id: string): Promise<AssetInstallResult> {
    return this.electron.installAsset(id);
  }

  cancelAsset(id: string): Promise<{ success: boolean }> {
    return this.electron.cancelAsset(id);
  }

  ensureRequiredAssets(): Promise<{ success: boolean; ok?: boolean; failed?: string[]; error?: string }> {
    return this.electron.ensureRequiredAssets();
  }

  onAssetProgress(callback: (p: AssetInstallProgress) => void): void {
    this.electron.onAssetProgress(callback);
  }

  removeAssetProgressListener(): void {
    this.electron.removeAssetProgressListener();
  }

  startWorkflow(options: any): Promise<void> {
    return this.processing.startWorkflow(options);
  }

  getCurrentJob(): Observable<ProcessingJob | null> {
    return this.processing.getCurrentJob();
  }

  cancelJob(): Promise<void> {
    return this.processing.cancelJob();
  }

  sendSkipSignal(): Promise<void> {
    return this.electron.sendSkipSignal();
  }

  // ── Host handoffs ───────────────────────────────────────────────────────────

  // ContentStudio HAS a titling queue (the Inputs tab), so the optional member is implemented.
  sendSubjectsToTitles(payload: { handoffs: TitleHandoff[] }): Promise<{ success: boolean }> {
    return this.electron.sendSubjectsToTitles(payload);
  }

  // ── Backup archive ──────────────────────────────────────────────────────────

  // ContentStudio has a NAS to push to, so the whole optional group is implemented.

  archiveStatus(): Promise<ArchiveStatus> {
    return this.electron.archiveStatus();
  }

  archiveConnect(): Promise<ArchiveStatus> {
    return this.electron.archiveConnect();
  }

  archiveSync(payload: { items: Array<{ localPath: string; kind: 'week' | 'day' }> }): Promise<{ ids: string[] }> {
    return this.unwrap(this.electron.archiveSync(payload));
  }

  archiveCancel(payload: { paths: string[] }): Promise<{ canceled: number }> {
    return this.electron.archiveCancel(payload);
  }

  onArchiveQueue(callback: (q: ArchiveQueue) => void): void {
    this.electron.onArchiveQueue(callback);
  }

  archiveCheck(payload: { localPath: string; kind: 'week' | 'day' }): Promise<ArchiveCheck> {
    return this.unwrap(this.electron.archiveCheck(payload));
  }

  archiveSyncedPaths(): Promise<{ synced: ArchiveSyncedEntry[] }> {
    return this.unwrap(this.electron.archiveSyncedPaths());
  }

  archiveListRemoteWeeks(): Promise<RemoteWeekListing> {
    return this.unwrap(this.electron.archiveListRemoteWeeks());
  }

  archiveDeleteRemoteWeek(payload: { path: string }): Promise<DeleteRemoteWeekResult> {
    return this.unwrap(this.electron.archiveDeleteRemoteWeek(payload));
  }

  onArchiveProgress(callback: (p: ArchiveProgress) => void): void {
    this.electron.onArchiveProgress(callback);
  }

  onArchiveDeleteProgress(callback: (p: ArchiveDeleteProgress) => void): void {
    this.electron.onArchiveDeleteProgress(callback);
  }

  onArchiveComplete(callback: (r: ArchiveResult) => void): void {
    this.electron.onArchiveComplete(callback);
  }

  removeArchiveListeners(): void {
    this.electron.removeArchiveListeners();
  }
}
