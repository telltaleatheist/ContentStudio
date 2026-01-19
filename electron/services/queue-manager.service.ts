/**
 * Queue Manager Service
 * Manages concurrent task execution with bounded pools
 * - Main pool: 5 concurrent tasks (Whisper, FFmpeg, etc.)
 * - AI pool: 1 concurrent task (LLM analysis)
 */

import * as log from 'electron-log';
import { EventEmitter } from 'events';

export type TaskType = 'main' | 'ai';
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface QueueTask {
  id: string;
  type: TaskType;
  name: string;
  execute: () => Promise<any>;
  onProgress?: (percent: number, message: string) => void;
  status: TaskStatus;
  result?: any;
  error?: string;
  startTime?: number;
  endTime?: number;
}

interface ActiveTask {
  task: QueueTask;
  startTime: number;
  lastProgressTime: number;
}

export class QueueManagerService extends EventEmitter {
  private static instance: QueueManagerService;

  // Task pools
  private mainPool = new Map<string, ActiveTask>();
  private aiPool: ActiveTask | null = null;

  // Task queues
  private mainQueue: QueueTask[] = [];
  private aiQueue: QueueTask[] = [];

  // Concurrency limits
  private readonly MAX_MAIN_CONCURRENT = 5;
  private readonly MAX_AI_CONCURRENT = 1;

  // Watchdog settings
  private readonly WATCHDOG_INTERVAL_MS = 60000; // Check every 60 seconds
  private readonly MAIN_TASK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
  private readonly AI_TASK_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
  private readonly PROGRESS_WARN_MS = 5 * 60 * 1000; // Warn if no progress for 5 min

  private watchdogTimer: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private cancelledTasks = new Set<string>();

  private constructor() {
    super();
    this.startWatchdog();
  }

  static getInstance(): QueueManagerService {
    if (!QueueManagerService.instance) {
      QueueManagerService.instance = new QueueManagerService();
    }
    return QueueManagerService.instance;
  }

  /**
   * Add a task to the queue
   */
  enqueue(task: QueueTask): string {
    task.status = 'pending';

    if (task.type === 'ai') {
      this.aiQueue.push(task);
      log.info(`[QueueManager] Enqueued AI task: ${task.name} (queue: ${this.aiQueue.length})`);
    } else {
      this.mainQueue.push(task);
      log.info(`[QueueManager] Enqueued main task: ${task.name} (queue: ${this.mainQueue.length})`);
    }

    // Start processing if not already running
    this.processQueue();

    return task.id;
  }

  /**
   * Cancel a task by ID
   */
  cancel(taskId: string): boolean {
    // Check if task is in queue (not yet started)
    const mainIndex = this.mainQueue.findIndex(t => t.id === taskId);
    if (mainIndex !== -1) {
      this.mainQueue[mainIndex].status = 'cancelled';
      this.mainQueue.splice(mainIndex, 1);
      log.info(`[QueueManager] Cancelled queued main task: ${taskId}`);
      return true;
    }

    const aiIndex = this.aiQueue.findIndex(t => t.id === taskId);
    if (aiIndex !== -1) {
      this.aiQueue[aiIndex].status = 'cancelled';
      this.aiQueue.splice(aiIndex, 1);
      log.info(`[QueueManager] Cancelled queued AI task: ${taskId}`);
      return true;
    }

    // Mark as cancelled (for running tasks)
    this.cancelledTasks.add(taskId);
    log.info(`[QueueManager] Marked task for cancellation: ${taskId}`);
    return true;
  }

  /**
   * Check if a task is cancelled
   */
  isCancelled(taskId: string): boolean {
    return this.cancelledTasks.has(taskId);
  }

  /**
   * Get current queue status
   */
  getStatus(): {
    mainPoolSize: number;
    mainQueueSize: number;
    aiPoolSize: number;
    aiQueueSize: number;
    activeTasks: string[];
  } {
    return {
      mainPoolSize: this.mainPool.size,
      mainQueueSize: this.mainQueue.length,
      aiPoolSize: this.aiPool ? 1 : 0,
      aiQueueSize: this.aiQueue.length,
      activeTasks: [
        ...Array.from(this.mainPool.values()).map(t => t.task.name),
        ...(this.aiPool ? [this.aiPool.task.name] : [])
      ]
    };
  }

  /**
   * Process the queue - fills pools up to limits
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      while (true) {
        // Fill main pool (up to 5 concurrent)
        while (this.mainPool.size < this.MAX_MAIN_CONCURRENT && this.mainQueue.length > 0) {
          const task = this.mainQueue.shift()!;
          this.executeTask(task, 'main').catch(err => {
            log.error(`[QueueManager] Main task error: ${err}`);
          });
        }

        // Fill AI pool (up to 1 concurrent)
        if (!this.aiPool && this.aiQueue.length > 0) {
          const task = this.aiQueue.shift()!;
          this.executeTask(task, 'ai').catch(err => {
            log.error(`[QueueManager] AI task error: ${err}`);
          });
        }

        // Check if done
        if (this.mainQueue.length === 0 && this.aiQueue.length === 0 &&
            this.mainPool.size === 0 && !this.aiPool) {
          break;
        }

        // Small delay to prevent tight loop
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Execute a single task
   */
  private async executeTask(task: QueueTask, poolType: 'main' | 'ai'): Promise<void> {
    const now = Date.now();
    const activeTask: ActiveTask = {
      task,
      startTime: now,
      lastProgressTime: now
    };

    // Add to pool
    if (poolType === 'main') {
      this.mainPool.set(task.id, activeTask);
    } else {
      this.aiPool = activeTask;
    }

    task.status = 'running';
    task.startTime = now;

    log.info(`[QueueManager] Starting ${poolType} task: ${task.name} (${task.id})`);
    this.emit('taskStarted', { taskId: task.id, type: poolType, name: task.name });

    try {
      // Check if already cancelled
      if (this.cancelledTasks.has(task.id)) {
        throw new Error('Task cancelled');
      }

      // Wrap progress callback to track activity
      const originalOnProgress = task.onProgress;
      if (originalOnProgress) {
        task.onProgress = (percent: number, message: string) => {
          activeTask.lastProgressTime = Date.now();
          originalOnProgress(percent, message);
        };
      }

      // Execute the task
      const result = await task.execute();

      task.status = 'completed';
      task.result = result;
      task.endTime = Date.now();

      log.info(`[QueueManager] Completed ${poolType} task: ${task.name} (${task.endTime - task.startTime}ms)`);
      this.emit('taskCompleted', { taskId: task.id, result });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      task.status = this.cancelledTasks.has(task.id) ? 'cancelled' : 'failed';
      task.error = errorMessage;
      task.endTime = Date.now();

      log.error(`[QueueManager] Failed ${poolType} task: ${task.name} - ${errorMessage}`);
      this.emit('taskFailed', { taskId: task.id, error: errorMessage });

    } finally {
      // Remove from pool
      if (poolType === 'main') {
        this.mainPool.delete(task.id);
      } else {
        this.aiPool = null;
      }

      // Clean up cancelled set
      this.cancelledTasks.delete(task.id);

      // Continue processing queue
      this.processQueue();
    }
  }

  /**
   * Watchdog timer to detect stuck tasks
   */
  private startWatchdog(): void {
    this.watchdogTimer = setInterval(() => {
      const now = Date.now();

      // Check main pool tasks
      for (const [taskId, activeTask] of this.mainPool) {
        const runtime = now - activeTask.startTime;
        const timeSinceProgress = now - activeTask.lastProgressTime;

        if (runtime > this.MAIN_TASK_TIMEOUT_MS) {
          log.warn(`[QueueManager] Main task timeout: ${activeTask.task.name} (${taskId}) - ${Math.round(runtime / 1000)}s`);
          this.emit('taskTimeout', { taskId, type: 'main', runtime });
        } else if (timeSinceProgress > this.PROGRESS_WARN_MS) {
          log.warn(`[QueueManager] Main task stalled: ${activeTask.task.name} (${taskId}) - no progress for ${Math.round(timeSinceProgress / 1000)}s`);
        }
      }

      // Check AI pool task
      if (this.aiPool) {
        const runtime = now - this.aiPool.startTime;
        const timeSinceProgress = now - this.aiPool.lastProgressTime;

        if (runtime > this.AI_TASK_TIMEOUT_MS) {
          log.warn(`[QueueManager] AI task timeout: ${this.aiPool.task.name} (${this.aiPool.task.id}) - ${Math.round(runtime / 1000)}s`);
          this.emit('taskTimeout', { taskId: this.aiPool.task.id, type: 'ai', runtime });
        } else if (timeSinceProgress > this.PROGRESS_WARN_MS) {
          log.warn(`[QueueManager] AI task stalled: ${this.aiPool.task.name} - no progress for ${Math.round(timeSinceProgress / 1000)}s`);
        }
      }

      // Log queue status periodically
      const status = this.getStatus();
      if (status.mainPoolSize > 0 || status.aiPoolSize > 0 || status.mainQueueSize > 0 || status.aiQueueSize > 0) {
        log.info(`[QueueManager] Status - Main: ${status.mainPoolSize}/${this.MAX_MAIN_CONCURRENT} running, ${status.mainQueueSize} queued | AI: ${status.aiPoolSize}/${this.MAX_AI_CONCURRENT} running, ${status.aiQueueSize} queued`);
      }
    }, this.WATCHDOG_INTERVAL_MS);
  }

  /**
   * Stop the watchdog timer
   */
  stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  /**
   * Clear all queues and cancel running tasks
   */
  clearAll(): void {
    // Clear queues
    this.mainQueue = [];
    this.aiQueue = [];

    // Cancel running tasks
    for (const taskId of this.mainPool.keys()) {
      this.cancelledTasks.add(taskId);
    }
    if (this.aiPool) {
      this.cancelledTasks.add(this.aiPool.task.id);
    }

    log.info('[QueueManager] Cleared all queues and marked running tasks for cancellation');
  }
}

// Export singleton instance
export const queueManager = QueueManagerService.getInstance();

/**
 * Helper to create a main pool task (for Whisper, FFmpeg, etc.)
 */
export function createMainTask(
  id: string,
  name: string,
  execute: () => Promise<any>,
  onProgress?: (percent: number, message: string) => void
): QueueTask {
  return {
    id,
    type: 'main',
    name,
    execute,
    onProgress,
    status: 'pending'
  };
}

/**
 * Helper to create an AI pool task (for LLM analysis)
 */
export function createAITask(
  id: string,
  name: string,
  execute: () => Promise<any>,
  onProgress?: (percent: number, message: string) => void
): QueueTask {
  return {
    id,
    type: 'ai',
    name,
    execute,
    onProgress,
    status: 'pending'
  };
}

/**
 * Queue a transcription task and wait for completion
 */
export function queueTranscription<T>(
  id: string,
  name: string,
  execute: () => Promise<T>,
  onProgress?: (percent: number, message: string) => void
): Promise<T> {
  return new Promise((resolve, reject) => {
    const task = createMainTask(id, name, execute, onProgress);

    const onComplete = (event: { taskId: string; result: T }) => {
      if (event.taskId === id) {
        queueManager.off('taskCompleted', onComplete);
        queueManager.off('taskFailed', onFail);
        resolve(event.result);
      }
    };

    const onFail = (event: { taskId: string; error: string }) => {
      if (event.taskId === id) {
        queueManager.off('taskCompleted', onComplete);
        queueManager.off('taskFailed', onFail);
        reject(new Error(event.error));
      }
    };

    queueManager.on('taskCompleted', onComplete);
    queueManager.on('taskFailed', onFail);
    queueManager.enqueue(task);
  });
}

/**
 * Queue an AI task and wait for completion
 */
export function queueAITask<T>(
  id: string,
  name: string,
  execute: () => Promise<T>,
  onProgress?: (percent: number, message: string) => void
): Promise<T> {
  return new Promise((resolve, reject) => {
    const task = createAITask(id, name, execute, onProgress);

    const onComplete = (event: { taskId: string; result: T }) => {
      if (event.taskId === id) {
        queueManager.off('taskCompleted', onComplete);
        queueManager.off('taskFailed', onFail);
        resolve(event.result);
      }
    };

    const onFail = (event: { taskId: string; error: string }) => {
      if (event.taskId === id) {
        queueManager.off('taskCompleted', onComplete);
        queueManager.off('taskFailed', onFail);
        reject(new Error(event.error));
      }
    };

    queueManager.on('taskCompleted', onComplete);
    queueManager.on('taskFailed', onFail);
    queueManager.enqueue(task);
  });
}
