import { spawn, ChildProcess, execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as log from 'electron-log';
import { app } from 'electron';
import Store from 'electron-store';

/**
 * Python Service
 * Manages Python subprocess for metadata generation
 */

export interface MetadataInput {
  path: string;
  notes?: string;
}

export interface MetadataParams {
  inputs: string[] | MetadataInput[];
  platform: string;
  mode: string;
  aiProvider: string;
  aiModel?: string;
  aiApiKey?: string;
  aiHost?: string;
  outputPath?: string;
  promptSet?: string;
  jobId?: string;
  jobName?: string;
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

      // Ensure required packages are installed
      await this.ensureRequiredPackages();

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

  private async ensureRequiredPackages(): Promise<void> {
    if (!this.pythonPath) return;

    // Get Python version
    let pythonVersion = '3.9';
    try {
      const versionOutput = execSync(`${this.pythonPath} --version`, {
        encoding: 'utf-8',
        timeout: 5000
      });
      const match = versionOutput.match(/Python (\d+\.\d+)/);
      if (match) {
        pythonVersion = match[1];
        log.info(`Detected Python version: ${pythonVersion}`);
      }
    } catch (error) {
      log.error('Failed to detect Python version:', error);
    }

    // First, ensure NumPy 1.x is installed (required for torch/whisper compatibility)
    log.info('Checking NumPy version...');
    try {
      execSync(`${this.pythonPath} -c "import numpy"`, {
        stdio: 'ignore',
        timeout: 5000
      });

      // Check if NumPy 2.x is installed (incompatible with torch)
      try {
        const numpyVersion = execSync(`${this.pythonPath} -c "import numpy; print(numpy.__version__)"`, {
          encoding: 'utf-8',
          timeout: 5000
        }).trim();

        if (numpyVersion.startsWith('2.')) {
          log.warn(`NumPy ${numpyVersion} is incompatible with torch. Downgrading to NumPy 1.x...`);
          execSync(`${this.pythonPath} -m pip install "numpy<2"`, {
            stdio: 'pipe',
            timeout: 60000
          });
          log.info('Successfully downgraded NumPy to 1.x');
        } else {
          log.info(`NumPy ${numpyVersion} is already installed`);
        }
      } catch (error) {
        log.warn('Could not check NumPy version, installing numpy<2...');
        execSync(`${this.pythonPath} -m pip install "numpy<2"`, {
          stdio: 'pipe',
          timeout: 60000
        });
      }
    } catch (error) {
      log.warn('NumPy not found, installing numpy<2...');
      try {
        execSync(`${this.pythonPath} -m pip install "numpy<2"`, {
          stdio: 'pipe',
          timeout: 60000
        });
        log.info('Successfully installed NumPy 1.x');
      } catch (installError) {
        log.error('Failed to install NumPy:', installError);
      }
    }

    const requiredPackages = [
      'requests',
      'openai',
      'anthropic',
      'PyYAML',
      'pathspec',
      'python-dateutil'
    ];

    log.info('Checking for required Python packages...');

    for (const pkg of requiredPackages) {
      try {
        // Check if package is installed
        execSync(`${this.pythonPath} -c "import ${pkg.replace('-', '_')}"`, {
          stdio: 'ignore',
          timeout: 5000
        });
        log.info(`Package ${pkg} is already installed`);
      } catch (error) {
        // Package not found, install it
        log.warn(`Package ${pkg} not found, installing...`);
        try {
          execSync(`${this.pythonPath} -m pip install ${pkg}`, {
            stdio: 'pipe',
            timeout: 60000
          });
          log.info(`Successfully installed ${pkg}`);
        } catch (installError) {
          log.error(`Failed to install ${pkg}:`, installError);
          // Continue anyway, the error will be caught when the script runs
        }
      }
    }

    // Try to install whisper and torch for video transcription
    log.info('Checking for video transcription packages...');

    // Check if whisper is installed
    try {
      execSync(`${this.pythonPath} -c "import whisper"`, {
        stdio: 'ignore',
        timeout: 5000
      });
      log.info('Whisper is already installed');
    } catch (error) {
      log.warn('Whisper not found, attempting to install...');

      // For Python 3.9, we need to install compatible versions
      const majorMinor = parseFloat(pythonVersion);

      try {
        if (majorMinor < 3.10) {
          // For Python 3.9, install older compatible versions
          log.info('Installing PyTorch for Python 3.9...');
          execSync(`${this.pythonPath} -m pip install torch==2.0.1 torchaudio==2.0.2 "numpy<2"`, {
            stdio: 'pipe',
            timeout: 300000 // 5 minutes for torch installation
          });
        } else if (majorMinor < 3.13) {
          // For Python 3.10-3.12, install latest stable
          log.info('Installing PyTorch...');
          execSync(`${this.pythonPath} -m pip install torch torchaudio "numpy<2"`, {
            stdio: 'pipe',
            timeout: 300000
          });
        } else {
          // For Python 3.13+, install latest with proper numpy constraint
          log.info('Installing PyTorch for Python 3.13+...');
          execSync(`${this.pythonPath} -m pip install "numpy<2" torch torchaudio`, {
            stdio: 'pipe',
            timeout: 300000
          });
        }

        log.info('Installing OpenAI Whisper...');
        execSync(`${this.pythonPath} -m pip install openai-whisper`, {
          stdio: 'pipe',
          timeout: 120000
        });

        log.info('Successfully installed video transcription packages');
      } catch (installError) {
        log.error('Failed to install whisper/torch:', installError);
        log.warn('Video transcription will not be available. Audio files will still work.');
      }
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
        // Extract paths and notes from inputs
        const inputPaths: string[] = [];
        const inputNotes: { [path: string]: string } = {};

        params.inputs.forEach((input) => {
          if (typeof input === 'string') {
            inputPaths.push(input);
          } else {
            inputPaths.push(input.path);
            if (input.notes) {
              inputNotes[input.path] = input.notes;
            }
          }
        });

        // Prepare arguments
        const args = [
          this.scriptPath!,
          '--inputs', ...inputPaths,
          '--platform', params.platform,
          '--mode', params.mode,
          '--ai-provider', params.aiProvider
        ];

        // Add notes as JSON if any exist
        if (Object.keys(inputNotes).length > 0) {
          args.push('--input-notes', JSON.stringify(inputNotes));
        }

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
        if (params.promptSet) {
          args.push('--prompt-set', params.promptSet);
        }
        if (params.jobId) {
          args.push('--job-id', params.jobId);
        }
        if (params.jobName) {
          args.push('--job-name', params.jobName);
        }

        log.info('Spawning Python process with args:', args);

        // Spawn Python process
        // Add common binary paths to PATH for ffmpeg and other tools
        const envPath = process.env.PATH || '';
        const additionalPaths = [
          '/usr/local/bin',
          '/opt/homebrew/bin',
          '/opt/local/bin'
        ];
        const pathsToAdd = additionalPaths.filter(p => !envPath.includes(p));
        const enhancedPath = pathsToAdd.length > 0
          ? `${pathsToAdd.join(':')}:${envPath}`
          : envPath;

        const pythonProcess: ChildProcess = spawn(this.pythonPath!, args, {
          env: {
            ...process.env,
            PATH: enhancedPath
          },
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

        // Collect stderr and parse progress
        pythonProcess.stderr?.on('data', (data) => {
          const output = data.toString();
          stderrData += output;
          log.debug('Python stderr:', output);

          // Parse progress information from stderr
          this.parseProgressFromOutput(output);
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

  private parseProgressFromOutput(output: string): void {
    const { BrowserWindow } = require('electron');
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (!mainWindow) return;
    // Parse "Transcribing video: filename.mov"
    const transcribingMatch = output.match(/Transcribing video: (.+)/);
    if (transcribingMatch) {
      mainWindow.webContents.send('generation-progress', {
        phase: 'transcription',
        message: `Transcribing: ${transcribingMatch[1]}`,
        filename: transcribingMatch[1]
      });
      return;
    }

    // Parse Whisper progress bar: "  42%|████▏     | 120000/286924 [01:30<02:20, 1200frames/s]"
    const progressMatch = output.match(/\s*(\d+)%\|[█▏▎▍▌▋▊▉\s]+\|\s*(\d+)\/(\d+)\s*\[(.+?)<(.+?),\s*(.+?)frames\/s\]/);
    if (progressMatch) {
      const percent = parseInt(progressMatch[1]);
      const current = parseInt(progressMatch[2]);
      const total = parseInt(progressMatch[3]);
      const elapsed = progressMatch[4];
      const remaining = progressMatch[5];

      mainWindow.webContents.send('generation-progress', {
        phase: 'transcription',
        progress: percent,
        current,
        total,
        elapsed,
        remaining,
        message: `Transcribing: ${percent}% (${remaining} remaining)`
      });
      return;
    }

    // Parse "Transcription complete (X characters)"
    const completeMatch = output.match(/Transcription complete \((\d+) characters\)/);
    if (completeMatch) {
      mainWindow.webContents.send('generation-progress', {
        phase: 'transcription',
        progress: 100,
        message: `Transcription complete (${completeMatch[1]} characters)`,
        characters: parseInt(completeMatch[1])
      });
      return;
    }

    // Parse "Processing input: filepath"
    const processingMatch = output.match(/Processing input: (.+)/);
    if (processingMatch) {
      mainWindow.webContents.send('generation-progress', {
        phase: 'preparing',
        message: `Processing: ${path.basename(processingMatch[1])}`,
        filename: path.basename(processingMatch[1])
      });
      return;
    }

    // Parse "Processed X item(s)"
    const processedMatch = output.match(/Processed (\d+) item\(s\)/);
    if (processedMatch) {
      mainWindow.webContents.send('generation-progress', {
        phase: 'generating',
        progress: 0,
        message: `Generating metadata...`,
        itemsProcessed: parseInt(processedMatch[1])
      });
      return;
    }

    // Parse "Summarizing long transcript"
    const summarizingMatch = output.match(/Summarizing long transcript/);
    if (summarizingMatch) {
      mainWindow.webContents.send('generation-progress', {
        phase: 'generating',
        progress: 0,
        message: 'Summarizing transcript...'
      });
      return;
    }

    // Parse "Processing X chunks..."
    const chunksMatch = output.match(/Processing (\d+) chunks/);
    if (chunksMatch) {
      mainWindow.webContents.send('generation-progress', {
        phase: 'generating',
        progress: 5,
        totalChunks: parseInt(chunksMatch[1]),
        message: `Summarizing in ${chunksMatch[1]} chunks...`
      });
      return;
    }

    // Parse "Chunk X/Y"
    const chunkProgressMatch = output.match(/Chunk (\d+)\/(\d+)/);
    if (chunkProgressMatch) {
      const current = parseInt(chunkProgressMatch[1]);
      const total = parseInt(chunkProgressMatch[2]);
      const progress = Math.floor((current / total) * 50); // 0-50% for chunking

      mainWindow.webContents.send('generation-progress', {
        phase: 'generating',
        progress,
        currentChunk: current,
        totalChunks: total,
        message: `Summarizing chunk ${current}/${total}...`
      });
      return;
    }

    // Parse "Transcript chunked and summarized"
    const chunkCompleteMatch = output.match(/Transcript chunked and summarized/);
    if (chunkCompleteMatch) {
      mainWindow.webContents.send('generation-progress', {
        phase: 'generating',
        progress: 50,
        message: 'Chunks summarized, generating metadata...'
      });
      return;
    }

    // Parse "Making consolidated request..."
    const consolidatedMatch = output.match(/Making consolidated request/);
    if (consolidatedMatch) {
      mainWindow.webContents.send('generation-progress', {
        phase: 'generating',
        progress: 60,
        message: 'Generating metadata with AI...'
      });
      return;
    }

    // Parse "Response received"
    const responseMatch = output.match(/Response received \((\d+) chars\)/);
    if (responseMatch) {
      mainWindow.webContents.send('generation-progress', {
        phase: 'generating',
        progress: 90,
        message: 'Processing AI response...',
        responseSize: parseInt(responseMatch[1])
      });
      return;
    }

    // Parse "JSON saved"
    const jsonSavedMatch = output.match(/JSON saved:/);
    if (jsonSavedMatch) {
      mainWindow.webContents.send('generation-progress', {
        phase: 'generating',
        progress: 100,
        message: 'Metadata saved!'
      });
      return;
    }
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
