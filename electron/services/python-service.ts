import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as log from 'electron-log';
import { app } from 'electron';
import Store from 'electron-store';

/**
 * Python Service
 * Manages Python subprocess for metadata generation
 */

export interface MetadataParams {
  inputs: string[];
  platform: string;
  mode: string;
  aiProvider: string;
  aiModel?: string;
  aiApiKey?: string;
  aiHost?: string;
  outputPath?: string;
}

export interface MetadataResult {
  success: boolean;
  metadata?: any;
  output_files?: string[];
  processing_time?: number;
  error?: string;
}

export class PythonService {
  private store: Store;
  private pythonPath: string | null = null;
  private scriptPath: string | null = null;

  constructor(store: Store) {
    this.store = store;
  }

  async initialize(): Promise<boolean> {
    try {
      // Find Python executable and script
      const pythonDir = this.getPythonDirectory();

      // Check if Python environment exists
      const venvPython = path.join(pythonDir, 'venv', 'bin', 'python');
      const systemPython = 'python3';

      // Try venv Python first, fall back to system Python
      if (fs.existsSync(venvPython)) {
        this.pythonPath = venvPython;
        log.info('Using venv Python:', this.pythonPath);
      } else {
        this.pythonPath = systemPython;
        log.info('Using system Python:', this.pythonPath);
        log.warn('Virtual environment not found. Run: npm run setup:python');
      }

      // Set script path
      this.scriptPath = path.join(pythonDir, 'metadata_generator.py');

      if (!fs.existsSync(this.scriptPath)) {
        log.error('Python script not found:', this.scriptPath);
        return false;
      }

      log.info('Python service initialized');
      return true;

    } catch (error) {
      log.error('Failed to initialize Python service:', error);
      return false;
    }
  }

  async generateMetadata(params: MetadataParams): Promise<MetadataResult> {
    if (!this.pythonPath || !this.scriptPath) {
      return {
        success: false,
        error: 'Python service not initialized'
      };
    }

    return new Promise((resolve) => {
      const startTime = Date.now();

      try {
        // Prepare arguments
        const args = [
          this.scriptPath!,
          '--inputs', ...params.inputs,
          '--platform', params.platform,
          '--mode', params.mode,
          '--ai-provider', params.aiProvider
        ];

        // Add optional parameters
        if (params.aiModel) {
          args.push('--ai-model', params.aiModel);
        }
        if (params.aiApiKey) {
          args.push('--ai-api-key', params.aiApiKey);
        }
        if (params.aiHost) {
          args.push('--ai-host', params.aiHost);
        }
        if (params.outputPath) {
          args.push('--output', params.outputPath);
        }

        log.info('Spawning Python process with args:', args);

        // Spawn Python process
        const pythonProcess: ChildProcess = spawn(this.pythonPath!, args, {
          env: { ...process.env },
          stdio: ['pipe', 'pipe', 'pipe']
        });

        let stdoutData = '';
        let stderrData = '';

        // Collect stdout
        pythonProcess.stdout?.on('data', (data) => {
          const output = data.toString();
          stdoutData += output;
          log.debug('Python stdout:', output);
        });

        // Collect stderr
        pythonProcess.stderr?.on('data', (data) => {
          const output = data.toString();
          stderrData += output;
          log.debug('Python stderr:', output);
        });

        // Handle process completion
        pythonProcess.on('close', (code) => {
          const processingTime = (Date.now() - startTime) / 1000;

          if (code === 0) {
            try {
              // Parse JSON output from Python
              const result = JSON.parse(stdoutData);
              // Flatten the result to top level for easier access
              resolve({
                success: result.success !== undefined ? result.success : true,
                metadata: result.metadata,
                output_files: result.output_files,
                processing_time: result.processing_time || processingTime,
                error: result.error
              });
            } catch (error) {
              log.error('Failed to parse Python output:', error);
              resolve({
                success: false,
                error: 'Failed to parse Python output: ' + (error as Error).message,
                processing_time: processingTime
              });
            }
          } else {
            log.error('Python process exited with code:', code);
            log.error('Python stderr:', stderrData);
            resolve({
              success: false,
              error: stderrData || `Python process exited with code ${code}`,
              processing_time: processingTime
            });
          }
        });

        // Handle process errors
        pythonProcess.on('error', (error) => {
          log.error('Python process error:', error);
          resolve({
            success: false,
            error: error.message,
            processing_time: (Date.now() - startTime) / 1000
          });
        });

      } catch (error) {
        log.error('Failed to spawn Python process:', error);
        resolve({
          success: false,
          error: (error as Error).message,
          processing_time: (Date.now() - startTime) / 1000
        });
      }
    });
  }

  private getPythonDirectory(): string {
    if (app.isPackaged) {
      // In production, Python files are in resources/python
      return path.join(process.resourcesPath, 'python');
    } else {
      // In development, Python files are in project root
      return path.join(app.getAppPath(), 'python');
    }
  }

  cleanup(): void {
    log.info('Python service cleanup complete');
  }
}
