import { Injectable, signal } from '@angular/core';
import { InputItem } from './inputs-state';

export interface QueuedJob {
  id: string;
  name: string;
  inputs: InputItem[];
  status: 'pending' | 'processing' | 'completed' | 'failed';
  createdAt: Date;
  completedAt?: Date;
  progress: number;
  currentlyProcessing: string;
  error?: string;
  outputFiles?: string[];
  processingTime?: number;
}

@Injectable({
  providedIn: 'root'
})
export class JobQueueService {
  jobs = signal<QueuedJob[]>([]);
  isProcessing = signal(false);

  constructor() {}

  addJob(name: string, inputs: InputItem[]): string {
    const jobId = `job-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const newJob: QueuedJob = {
      id: jobId,
      name,
      inputs: [...inputs], // Clone the inputs array
      status: 'pending',
      createdAt: new Date(),
      progress: 0,
      currentlyProcessing: ''
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
}
