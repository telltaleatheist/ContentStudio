// src/app/services/editor-processing.service.ts
//
// Job state for the editor's processing runs — the ONE thing the editor's port asks for that
// is not a bridge call: `getCurrentJob(): Observable<ProcessingJob | null>`.
//
// Ported from AutoCutStudio's ProcessingService, which is where that observable came from.
// It lives here rather than in the adapter because the adapter is a seam, not a place for
// behaviour: EditorHostAdapter.startWorkflow/getCurrentJob/cancelJob are one-line delegates
// to this class, exactly as they were in AutoCutStudio.
//
// It is deliberately NOT ContentStudio's own job queue (services/job-queue.ts). That queue
// tracks metadata generation jobs on a different channel with a different lifecycle; one
// class serving both would be two behaviours wearing one name.
//
// Deviation from the AutoCutStudio original, and the only one: its `showErrorDialog` raised a
// native alert() on every failed run. In the editor window the setup modal already renders
// `job.error` verbatim inline (project-setup-modal.component.ts, state 'error'), so the alert
// was a second, blocking copy of a message the user is already reading. It logs instead.

import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { ElectronService } from './electron';
import type { ProcessingJob } from '../components/editor/editor-host';

@Injectable({
  providedIn: 'root'
})
export class EditorProcessingService {
  private currentJob$ = new BehaviorSubject<ProcessingJob | null>(null);
  private jobHistory$ = new BehaviorSubject<ProcessingJob[]>([]);

  /**
   * Subscribed lazily, not in the constructor: this service is providedIn 'root', so the main
   * window constructs it too, and attaching the editor's workflow listeners there would make
   * every boot depend on the editor half of the preload bridge existing.
   */
  private subscribed = false;

  constructor(private electronService: ElectronService) {}

  private subscribeOnce(): void {
    if (this.subscribed) return;
    this.subscribed = true;

    // Listen for workflow output
    this.electronService.getWorkflowOutput().subscribe((data) => {
      this.handleWorkflowOutput(data);
    });

    // Listen for workflow completion
    this.electronService.getWorkflowComplete().subscribe((data) => {
      this.handleWorkflowComplete(data);
    });
  }

  /**
   * Get current job observable
   */
  getCurrentJob(): Observable<ProcessingJob | null> {
    this.subscribeOnce();
    return this.currentJob$.asObservable();
  }

  /**
   * Get job history observable
   */
  getJobHistory(): Observable<ProcessingJob[]> {
    return this.jobHistory$.asObservable();
  }

  /**
   * Start a new workflow
   */
  async startWorkflow(options: any): Promise<void> {
    this.subscribeOnce();
    try {
      const result = await this.electronService.executeWorkflow(options);

      if (result.success) {
        const job: ProcessingJob = {
          id: result.jobId,
          status: 'running',
          progress: 0,
          message: 'Starting workflow...',
          output: [],
          startTime: new Date()
        };

        this.currentJob$.next(job);
      } else {
        throw new Error(result.error || 'Failed to start workflow');
      }
    } catch (error: any) {
      console.error('Error starting workflow:', error);
      throw error;
    }
  }

  /**
   * Cancel current job
   */
  async cancelJob(): Promise<void> {
    const currentJob = this.currentJob$.value;
    if (!currentJob) return;

    try {
      await this.electronService.editorCancelJob(currentJob.id);

      const updatedJob = {
        ...currentJob,
        status: 'error' as const,
        message: 'Job canceled by user',
        error: 'Canceled',
        endTime: new Date()
      };

      this.currentJob$.next(updatedJob);
      this.addToHistory(updatedJob);
    } catch (error: any) {
      console.error('Error canceling job:', error);
    }
  }

  /**
   * Handle workflow output
   */
  private handleWorkflowOutput(data: { jobId: string; type: string; data: string; progress?: number; sub_progress?: number }): void {
    const currentJob = this.currentJob$.value;

    if (!currentJob || currentJob.id !== data.jobId) {
      return;
    }

    // Handle progress updates
    if (data.type === 'progress' && data.progress !== undefined) {
      const updatedJob = {
        ...currentJob,
        progress: data.progress,
        message: this.truncateMessage(String(data.data ?? '')),
        subProgress: data.sub_progress || 0
      };
      this.currentJob$.next(updatedJob);
      return;
    }

    // For stdout type, try to parse data as JSON to check for special events
    if (data.type === 'stdout' && typeof data.data === 'string') {
      try {
        const parsed = JSON.parse(data.data);

        // Handle skip_capabilities event
        if (parsed.type === 'skip_capabilities') {
          const updatedJob = {
            ...currentJob,
            skipDecisions: parsed.data.decisions
          };
          this.currentJob$.next(updatedJob);
          return;
        }

        // Handle operation_start event
        if (parsed.type === 'operation_start') {
          const updatedJob = {
            ...currentJob,
            currentOperation: parsed.data.operation,
            canSkipCurrent: parsed.data.can_skip,
            subProgress: 0  // Reset sub-progress
          };
          this.currentJob$.next(updatedJob);
          return;
        }
      } catch (e) {
        // Not JSON or different format, treat as regular output
      }
    }

    // Handle skip_capabilities event (legacy format)
    if (data.type === 'skip_capabilities') {
      try {
        const parsedData = typeof data.data === 'string' ? JSON.parse(data.data) : data.data;
        const updatedJob = {
          ...currentJob,
          skipDecisions: parsedData.decisions
        };
        this.currentJob$.next(updatedJob);
      } catch (e) {
        // Malformed payload — don't let it kill the subscription for the rest of the job.
        console.warn('[EditorProcessingService] Failed to parse skip_capabilities payload:', e);
      }
      return;
    }

    // Handle operation_start event (legacy format)
    if (data.type === 'operation_start') {
      try {
        const parsedData = typeof data.data === 'string' ? JSON.parse(data.data) : data.data;
        const updatedJob = {
          ...currentJob,
          currentOperation: parsedData.operation,
          canSkipCurrent: parsedData.can_skip,
          subProgress: 0  // Reset sub-progress
        };
        this.currentJob$.next(updatedJob);
      } catch (e) {
        // Malformed payload — don't let it kill the subscription for the rest of the job.
        console.warn('[EditorProcessingService] Failed to parse operation_start payload:', e);
      }
      return;
    }

    // Handle regular output — cap at 500 lines to prevent memory leaks
    const MAX_OUTPUT_LINES = 500;
    const line = String(data.data ?? '');
    let output: string[];
    if (currentJob.output.length >= MAX_OUTPUT_LINES) {
      // Drop oldest lines to stay within limit
      output = [...currentJob.output.slice(-MAX_OUTPUT_LINES + 1), line];
    } else {
      output = [...currentJob.output, line];
    }
    const updatedJob: ProcessingJob = {
      ...currentJob,
      output,
      message: this.extractLastMessage(output)
    };

    // Capture structured Python errors. The `type==='error'` payload is forwarded
    // by the main process through onError → a 'stderr' workflow-output event, so
    // both surface here as 'stderr' (or a defensive 'error'). Retain the latest
    // non-empty text so a failed job can prefer it over regex-scraped output.
    if ((data.type === 'stderr' || data.type === 'error') && line.trim()) {
      updatedJob.emittedError = line.trim();
    }

    this.currentJob$.next(updatedJob);
  }

  /**
   * Extract error details from console output
   */
  private extractErrorDetails(output: string[]): string {
    const allOutput = output.join('\n');
    const lines = allOutput.split('\n').filter(line => line.trim());

    // Look for common error patterns
    const errorPatterns = [
      /Error:/i,
      /Exception:/i,
      /Traceback/i,
      /ModuleNotFoundError:/i,
      /ImportError:/i,
      /FileNotFoundError:/i,
      /PermissionError:/i,
      /failed/i,
      /cannot/i
    ];

    // Find lines with errors (last 20 lines for context)
    const recentLines = lines.slice(-20);
    const errorLines: string[] = [];

    for (const line of recentLines) {
      if (errorPatterns.some(pattern => pattern.test(line))) {
        errorLines.push(line);
      }
    }

    // If we found error lines, return them
    if (errorLines.length > 0) {
      return errorLines.join('\n');
    }

    // Otherwise return last 5 lines as context
    return recentLines.slice(-5).join('\n');
  }

  /**
   * Handle workflow completion
   */
  private handleWorkflowComplete(data: { jobId: string; exitCode: number; result?: any }): void {
    const currentJob = this.currentJob$.value;

    if (!currentJob || currentJob.id !== data.jobId) {
      console.warn('[EditorProcessingService] Ignoring completion - no matching job', { currentJobId: currentJob?.id, dataJobId: data.jobId });
      return;
    }

    // Extract detailed error information if workflow failed
    let errorMessage = '';
    let errorDetails = '';

    if (data.exitCode !== 0) {
      // Prefer the structured error text Python emitted over regex-scraped console
      // output; fall back to scraping only when no structured error was captured.
      errorDetails = currentJob.emittedError || this.extractErrorDetails(currentJob.output);

      // Create a user-friendly error message
      if (errorDetails.includes('ModuleNotFoundError') || errorDetails.includes('ImportError')) {
        const match = errorDetails.match(/No module named '([^']+)'/);
        const moduleName = match ? match[1] : 'unknown';
        errorMessage = `Missing Python package: ${moduleName}. The system will attempt to install it automatically on next run.`;
      } else if (errorDetails.includes('FileNotFoundError')) {
        errorMessage = 'A required file was not found. Please check your input files and try again.';
      } else if (errorDetails.includes('PermissionError')) {
        errorMessage = 'Permission denied. Please check file permissions and try again.';
      } else {
        errorMessage = 'Workflow failed. See error details below.';
      }
    }

    const updatedJob = {
      ...currentJob,
      status: data.exitCode === 0 ? 'completed' as const : 'error' as const,
      progress: 100,
      message: data.exitCode === 0 ? 'Workflow completed successfully!' : errorMessage,
      error: data.exitCode !== 0 ? errorDetails : undefined,
      // The success result (zipPath/clips/session) only reaches the renderer via the
      // completion callback, so capture it here onto the job's results field.
      results: data.exitCode === 0 && data.result !== undefined ? data.result : currentJob.results,
      endTime: new Date()
    };

    this.currentJob$.next(updatedJob);
    this.addToHistory(updatedJob);

    // The setup modal renders `job.error` verbatim; this is the console copy for a log dump.
    if (data.exitCode !== 0) {
      console.error(`[EditorProcessingService] ${errorMessage}\n\n━━━ Error Details ━━━\n${errorDetails}`);
    }
  }

  /**
   * Extract last meaningful message from output and truncate if needed
   */
  private extractLastMessage(output: string[]): string {
    const lines = output.map(l => String(l ?? '')).join('').split('\n').filter(line => line.trim());
    const lastLine = lines[lines.length - 1] || 'Processing...';
    return this.truncateMessage(lastLine);
  }

  /**
   * Truncate message to max 100 characters for progress display
   */
  private truncateMessage(message: string, maxLength: number = 100): string {
    const str = String(message ?? '');
    if (str.length <= maxLength) {
      return str;
    }
    return str.substring(0, maxLength - 3) + '...';
  }

  /**
   * Add job to history — drops output to free memory
   */
  private addToHistory(job: ProcessingJob): void {
    // Keep only the last few output lines for error context, drop the rest
    const historyJob = {
      ...job,
      output: job.output.slice(-20)
    };
    const history = [historyJob, ...this.jobHistory$.value];
    this.jobHistory$.next(history.slice(0, 10));
  }

  /**
   * Clear current job
   */
  clearCurrentJob(): void {
    this.currentJob$.next(null);
  }
}
