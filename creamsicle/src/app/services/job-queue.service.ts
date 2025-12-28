import { Injectable, signal } from '@angular/core';
import { InputItem } from './inputs-state.service';

export type ItemStatus = 'pending' | 'transcribing' | 'transcribed' | 'generating' | 'completed' | 'failed';

export interface ItemProgress {
  status: ItemStatus;
  progress: number;
}

export interface QueuedJob {
  id: string;
  name: string;
  inputs: InputItem[];
  promptSet: string;
  mode: 'individual' | 'compilation';
  status: 'pending' | 'processing' | 'completed' | 'failed';
  createdAt: Date;
  completedAt?: Date;
  progress: number;
  currentlyProcessing: string;
  error?: string;
  outputFiles?: string[];
  processingTime?: number;
  itemProgress: ItemProgress[];
  currentItemIndex: number;
}

@Injectable({
  providedIn: 'root'
})
export class JobQueueService {
  jobs = signal<QueuedJob[]>([]);
  isProcessing = signal(false);

  addJob(name: string, inputs: InputItem[], promptSet: string, mode: 'individual' | 'compilation'): string {
    const jobId = `job-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const newJob: QueuedJob = {
      id: jobId,
      name,
      inputs: [...inputs],
      promptSet,
      mode,
      status: 'pending',
      createdAt: new Date(),
      progress: 0,
      currentlyProcessing: '',
      itemProgress: inputs.map(() => ({ status: 'pending', progress: 0 })),
      currentItemIndex: -1
    };

    this.jobs.update(jobs => [...jobs, newJob]);
    return jobId;
  }

  removeJob(jobId: string) {
    this.jobs.update(jobs => jobs.filter(job => job.id !== jobId));
  }

  clearCompletedJobs() {
    this.jobs.update(jobs => jobs.filter(job =>
      job.status !== 'completed' && job.status !== 'failed'
    ));

    if (this.jobs().length === 0 || !this.hasProcessingJob()) {
      this.isProcessing.set(false);
    }
  }

  updateJob(jobId: string, updates: Partial<QueuedJob>) {
    this.jobs.update(jobs =>
      jobs.map(job => job.id === jobId ? { ...job, ...updates } : job)
    );
  }

  getJob(jobId: string): QueuedJob | undefined {
    return this.jobs().find(job => job.id === jobId);
  }

  getPendingJobs(): QueuedJob[] {
    return this.jobs().filter(job => job.status === 'pending');
  }

  getNextPendingJob(): QueuedJob | undefined {
    return this.jobs().find(job => job.status === 'pending');
  }

  hasProcessingJob(): boolean {
    return this.jobs().some(job => job.status === 'processing');
  }

  updateItemProgress(jobId: string, itemIndex: number, progress: number, status: ItemStatus) {
    this.jobs.update(jobs =>
      jobs.map(job => {
        if (job.id === jobId && job.itemProgress[itemIndex]) {
          const newItemProgress = [...job.itemProgress];
          newItemProgress[itemIndex] = { status, progress };
          const isActiveStatus = status === 'transcribing' || status === 'generating';
          return {
            ...job,
            itemProgress: newItemProgress,
            currentItemIndex: isActiveStatus ? itemIndex : job.currentItemIndex
          };
        }
        return job;
      })
    );
  }
}
