import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable, interval, Subject } from 'rxjs';
import { VideoJob, VideoTask, VideoJobSettings, QueueStats, ProcessingWebSocketMessage } from '../models/video-processing.model';

@Injectable({
  providedIn: 'root'
})
export class VideoProcessingService {
  private jobs$ = new BehaviorSubject<VideoJob[]>([]);
  private activeJobId$ = new BehaviorSubject<string | null>(null);
  private queueStats$ = new BehaviorSubject<QueueStats>(this.calculateStats([]));
  private progressUpdates$ = new Subject<ProcessingWebSocketMessage>();

  // WebSocket simulation for demo
  private simulationInterval: any;

  constructor() {
    // Simulate WebSocket updates for demo purposes
    this.startProgressSimulation();
  }

  getJobs(): Observable<VideoJob[]> {
    return this.jobs$.asObservable();
  }

  getActiveJobId(): Observable<string | null> {
    return this.activeJobId$.asObservable();
  }

  getQueueStats(): Observable<QueueStats> {
    return this.queueStats$.asObservable();
  }

  getProgressUpdates(): Observable<ProcessingWebSocketMessage> {
    return this.progressUpdates$.asObservable();
  }

  addJob(videoUrl: string, videoName: string, settings: VideoJobSettings): VideoJob {
    const job: VideoJob = {
      id: this.generateId(),
      videoUrl,
      videoName,
      status: 'queued',
      addedAt: new Date(),
      settings,
      tasks: this.createTasks(settings, !!videoUrl),
      progress: 0,
      fileSize: Math.floor(Math.random() * 500000000) + 50000000, // 50MB - 500MB
      duration: Math.floor(Math.random() * 600) + 30 // 30s - 10min
    };

    const currentJobs = this.jobs$.value;
    this.jobs$.next([...currentJobs, job]);
    this.updateStats();

    // Auto-start processing if no active job
    if (!this.activeJobId$.value) {
      this.startNextJob();
    }

    return job;
  }

  private createTasks(settings: VideoJobSettings, isUrl: boolean): VideoTask[] {
    const tasks: VideoTask[] = [];

    if (isUrl) {
      tasks.push({
        id: this.generateId(),
        type: 'download',
        name: 'Download Video',
        status: 'pending',
        progress: 0,
        estimatedTime: 30
      });
    }

    tasks.push({
      id: this.generateId(),
      type: 'import',
      name: 'Import to Database',
      status: 'pending',
      progress: 0,
      estimatedTime: 10
    });

    if (settings.fixAspectRatio) {
      tasks.push({
        id: this.generateId(),
        type: 'aspect-ratio',
        name: `Fix Aspect Ratio (${settings.aspectRatio || '16:9'})`,
        status: 'pending',
        progress: 0,
        estimatedTime: 45
      });
    }

    if (settings.normalizeAudio) {
      tasks.push({
        id: this.generateId(),
        type: 'normalize-audio',
        name: 'Normalize Audio',
        status: 'pending',
        progress: 0,
        estimatedTime: 20
      });
    }

    if (settings.transcribe) {
      tasks.push({
        id: this.generateId(),
        type: 'transcribe',
        name: `Transcribe (${settings.whisperModel || 'base'})`,
        status: 'pending',
        progress: 0,
        estimatedTime: 60
      });
    }

    if (settings.aiAnalysis) {
      tasks.push({
        id: this.generateId(),
        type: 'ai-analysis',
        name: `AI Analysis (${settings.aiModel || 'gpt-3.5-turbo'})`,
        status: 'pending',
        progress: 0,
        estimatedTime: 30
      });
    }

    return tasks;
  }

  removeJob(jobId: string): void {
    const currentJobs = this.jobs$.value;
    this.jobs$.next(currentJobs.filter(job => job.id !== jobId));
    this.updateStats();
  }

  pauseJob(jobId: string): void {
    this.updateJobStatus(jobId, 'paused');
  }

  resumeJob(jobId: string): void {
    this.updateJobStatus(jobId, 'queued');
    if (!this.activeJobId$.value) {
      this.startNextJob();
    }
  }

  retryJob(jobId: string): void {
    const job = this.jobs$.value.find(j => j.id === jobId);
    if (job) {
      job.status = 'queued';
      job.progress = 0;
      job.tasks.forEach(task => {
        task.status = 'pending';
        task.progress = 0;
        task.error = undefined;
      });
      this.jobs$.next([...this.jobs$.value]);
      this.updateStats();

      if (!this.activeJobId$.value) {
        this.startNextJob();
      }
    }
  }

  updateBatchSettings(jobIds: string[], settings: Partial<VideoJobSettings>): void {
    const jobs = this.jobs$.value;
    jobIds.forEach(id => {
      const job = jobs.find(j => j.id === id);
      if (job && job.status === 'queued') {
        job.settings = { ...job.settings, ...settings };
        job.tasks = this.createTasks(job.settings, !!job.videoUrl);
      }
    });
    this.jobs$.next([...jobs]);
  }

  clearCompleted(): void {
    const currentJobs = this.jobs$.value;
    this.jobs$.next(currentJobs.filter(job => job.status !== 'completed'));
    this.updateStats();
  }

  clearAll(): void {
    this.jobs$.next([]);
    this.activeJobId$.next(null);
    this.updateStats();
  }

  private startNextJob(): void {
    const nextJob = this.jobs$.value.find(job => job.status === 'queued');
    if (nextJob) {
      this.activeJobId$.next(nextJob.id);
      this.updateJobStatus(nextJob.id, 'processing');
      nextJob.startedAt = new Date();
      this.jobs$.next([...this.jobs$.value]);
    } else {
      this.activeJobId$.next(null);
    }
  }

  private updateJobStatus(jobId: string, status: VideoJob['status']): void {
    const jobs = this.jobs$.value;
    const job = jobs.find(j => j.id === jobId);
    if (job) {
      job.status = status;
      if (status === 'completed') {
        job.completedAt = new Date();
      }
      this.jobs$.next([...jobs]);
      this.updateStats();
    }
  }

  private calculateStats(jobs: VideoJob[]): QueueStats {
    const stats: QueueStats = {
      totalJobs: jobs.length,
      completedJobs: jobs.filter(j => j.status === 'completed').length,
      failedJobs: jobs.filter(j => j.status === 'failed').length,
      processingJobs: jobs.filter(j => j.status === 'processing').length,
      queuedJobs: jobs.filter(j => j.status === 'queued').length,
      averageProcessingTime: 0,
      estimatedTimeRemaining: 0
    };

    // Calculate average processing time
    const completedJobs = jobs.filter(j => j.status === 'completed' && j.startedAt && j.completedAt);
    if (completedJobs.length > 0) {
      const totalTime = completedJobs.reduce((sum, job) => {
        return sum + (job.completedAt!.getTime() - job.startedAt!.getTime());
      }, 0);
      stats.averageProcessingTime = totalTime / completedJobs.length / 1000; // in seconds
    }

    // Estimate remaining time
    const pendingTasks = jobs
      .filter(j => j.status === 'queued' || j.status === 'processing')
      .flatMap(j => j.tasks)
      .filter(t => t.status === 'pending' || t.status === 'in-progress');

    stats.estimatedTimeRemaining = pendingTasks.reduce((sum, task) => sum + (task.estimatedTime || 0), 0);

    return stats;
  }

  private updateStats(): void {
    this.queueStats$.next(this.calculateStats(this.jobs$.value));
  }

  private generateId(): string {
    return Math.random().toString(36).substr(2, 9);
  }

  // WebSocket simulation for demo
  private startProgressSimulation(): void {
    interval(1000).subscribe(() => {
      const activeJobId = this.activeJobId$.value;
      if (activeJobId) {
        const jobs = this.jobs$.value;
        const activeJob = jobs.find(j => j.id === activeJobId);

        if (activeJob && activeJob.status === 'processing') {
          // Find current task
          const currentTask = activeJob.tasks.find(t => t.status === 'in-progress');
          const pendingTask = activeJob.tasks.find(t => t.status === 'pending');

          if (!currentTask && pendingTask) {
            // Start next task
            pendingTask.status = 'in-progress';
            pendingTask.startedAt = new Date();
          } else if (currentTask) {
            // Update progress
            currentTask.progress = Math.min(currentTask.progress + Math.random() * 15 + 5, 100);

            if (currentTask.progress >= 100) {
              currentTask.status = 'completed';
              currentTask.completedAt = new Date();
              currentTask.progress = 100;
            }

            // Send WebSocket message
            this.progressUpdates$.next({
              jobId: activeJobId,
              taskId: currentTask.id,
              type: 'progress',
              data: {
                progress: currentTask.progress,
                status: currentTask.status
              }
            });
          }

          // Update overall job progress
          const totalTasks = activeJob.tasks.length;
          const completedTasks = activeJob.tasks.filter(t => t.status === 'completed').length;
          const inProgressTask = activeJob.tasks.find(t => t.status === 'in-progress');
          const inProgressContribution = inProgressTask ? (inProgressTask.progress / 100) : 0;

          activeJob.progress = ((completedTasks + inProgressContribution) / totalTasks) * 100;

          // Check if job is complete
          if (activeJob.tasks.every(t => t.status === 'completed')) {
            this.updateJobStatus(activeJobId, 'completed');
            this.startNextJob();
          }

          this.jobs$.next([...jobs]);
          this.updateStats();
        }
      }
    });
  }
}