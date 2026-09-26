// electron/services/editor/binary-resolver.ts
import * as path from 'path';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import * as log from 'electron-log';
import { EditorPaths } from './app-config';
import * as assetManager from './asset-manager';

/**
 * Service to resolve paths to the editor backend's binaries.
 *
 * Ported from AutoCutStudio with ONE deliberate behavioural change: there is no longer a
 * fallback chain that ends in a guess. ACS ended every resolution with "return the bare
 * name and hope it's on PATH", plus a hardcoded conda env path and a hardcoded
 * /Applications/AutoCutStudio.app bundle path. All of those are gone. The chain here is:
 *
 *     managed shared install (OwenMorgan) → editor-backend/<kind>/<platform-arch>/ → THROW
 *
 * and the throw names the exact path that was tried. A silently-substituted binary is an
 * unexpected code path in production, i.e. a deliberate bug: an ffmpeg that is not the one
 * this pipeline was built against fails later, somewhere unrelated, with a worse message.
 */
export class BinaryResolver {
  private binariesPath: string;
  private pythonPath: string;

  constructor() {
    // Unlike ACS there is no dev-vs-packaged split here: editor-backend/ ships whole, so
    // the per-platform subdirectory is always present in both modes.
    const platformDir = EditorPaths.platformDir();
    this.binariesPath = EditorPaths.binariesPath;
    this.pythonPath = EditorPaths.pythonRuntimePath;

    log.info('BinaryResolver initialized');
    log.info(`App architecture (process.arch): ${process.arch}`);
    log.info(`Platform directory: ${platformDir}`);

    // Detect if running under Rosetta
    if (process.platform === 'darwin' && process.arch === 'arm64') {
      const isRosetta = this.detectRosetta();
      if (isRosetta) {
        log.info('⚠️  Running ARM64 build on Intel Mac via Rosetta');
        log.info('   Using ARM64 binaries (will be translated by Rosetta)');
      }
    }

    log.info(`Binaries path: ${this.binariesPath}`);
    log.info(`Python path: ${this.pythonPath}`);
  }

  /**
   * Detect if running under Rosetta (ARM64 app on Intel Mac)
   * Returns true if running under Rosetta, false otherwise
   */
  private detectRosetta(): boolean {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') {
      return false;
    }

    try {
      const { execSync } = require('child_process');
      // sysctl returns 1 if running under Rosetta, 0 if native ARM64
      const result = execSync('sysctl -in sysctl.proc_translated', { encoding: 'utf8' }).trim();
      return result === '1';
    } catch (error) {
      // If the command fails, we're likely on native ARM64
      // (the sysctl key doesn't exist on native ARM64)
      return false;
    }
  }

  /**
   * Verify a binary actually runs, not just that the file exists. A bundled
   * binary can exist + be executable yet abort at launch (missing dylib, wrong
   * arch) — that's what caused the original ffprobe SIGABRT. Returns true only
   * if the process launches and exits without throwing.
   */
  private binaryWorks(binPath: string, args: string[]): boolean {
    try {
      execFileSync(binPath, args, { stdio: 'ignore', timeout: 10_000 });
      return true;
    } catch (error) {
      log.warn(`Binary failed validation (${binPath}): ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * Find a bundled binary by name
   * Returns the full path to the binary if found, null otherwise
   */
  private findBundledBinary(binaryName: string): string | null {
    const binaryPath = path.join(this.binariesPath, binaryName);

    try {
      if (fs.existsSync(binaryPath)) {
        // Check if file is executable
        try {
          fs.accessSync(binaryPath, fs.constants.X_OK);
          log.info(`Found bundled binary: ${binaryPath}`);
          return binaryPath;
        } catch (e) {
          log.warn(`Bundled binary exists but is not executable: ${binaryPath}`);
          // Try to make it executable
          try {
            fs.chmodSync(binaryPath, 0o755);
            log.info(`Made bundled binary executable: ${binaryPath}`);
            return binaryPath;
          } catch (chmodError) {
            log.error(`Failed to make binary executable: ${chmodError}`);
            return null;
          }
        }
      }
    } catch (error) {
      log.warn(`Error checking for bundled binary ${binaryName}:`, error);
    }

    return null;
  }

  // Resolved-path caches: resolution validates the binary by SPAWNING it
  // (`-version`), so re-resolving on every call (e.g. once per waveform peak
  // extraction) both spams the log and doubles the process spawns. A successful
  // resolution is stable for the process lifetime; the not-found path is NOT
  // cached (it throws) so an install completed mid-session gets picked up.
  private cachedFfmpegPath: string | null = null;
  private cachedFfprobePath: string | null = null;

  /**
   * Get the path to ffmpeg. Managed shared install, then the bundled binary, then THROW —
   * a system ffmpeg is NOT an acceptable substitute (see the class comment).
   */
  getFfmpegPath(): string {
    if (this.cachedFfmpegPath) return this.cachedFfmpegPath;

    // 1. Managed shared download (cross-app OwenMorgan location), validated.
    const managed = assetManager.resolveBinary('ffmpeg-tools', 'ffmpeg');
    if (managed && this.binaryWorks(managed, ['-version'])) {
      log.info(`Using managed ffmpeg: ${managed}`);
      this.cachedFfmpegPath = managed;
      return managed;
    }

    // 2. Bundled binary — but only if it actually runs.
    const bundled = this.findBundledBinary('ffmpeg');
    if (bundled && this.binaryWorks(bundled, ['-version'])) {
      this.cachedFfmpegPath = bundled;
      return bundled;
    }

    throw new Error(
      `ffmpeg not found — no managed 'ffmpeg-tools' install, and no working binary at ` +
      `${path.join(this.binariesPath, 'ffmpeg')}.`
    );
  }

  /**
   * Get the path to ffprobe. Managed shared install, then the bundled binary, then THROW.
   */
  getFfprobePath(): string {
    if (this.cachedFfprobePath) return this.cachedFfprobePath;

    // 1. Managed shared download (cross-app OwenMorgan location), validated.
    const managed = assetManager.resolveBinary('ffmpeg-tools', 'ffprobe');
    if (managed && this.binaryWorks(managed, ['-version'])) {
      log.info(`Using managed ffprobe: ${managed}`);
      this.cachedFfprobePath = managed;
      return managed;
    }

    // 2. Bundled binary — but only if it actually runs.
    const bundled = this.findBundledBinary('ffprobe');
    if (bundled && this.binaryWorks(bundled, ['-version'])) {
      this.cachedFfprobePath = bundled;
      return bundled;
    }

    throw new Error(
      `ffprobe not found — no managed 'ffmpeg-tools' install, and no working binary at ` +
      `${path.join(this.binariesPath, 'ffprobe')}.`
    );
  }

  /**
   * Get the path to the Python interpreter that runs the editor CLIs.
   *
   * ACS ended this chain with a hardcoded miniconda env path and then bare "python3".
   * Both are gone: the CLIs import `core/` and third-party packages that only the managed
   * or bundled runtime has, so an arbitrary system python is not a substitute — it is a
   * confusing ImportError several seconds later.
   */
  getPythonPath(): string {
    // Check the managed shared Python env first (downloaded from GH releases).
    const managedPython = assetManager.resolveEntry('python-env');
    if (managedPython && this.binaryWorks(managedPython, ['--version'])) {
      log.info(`Using managed Python env: ${managedPython}`);
      return managedPython;
    }

    // Check for the bundled Python runtime.
    const bundledPython = path.join(this.pythonPath, 'python-runtime', 'bin', 'python3');
    if (fs.existsSync(bundledPython)) {
      log.info(`Found bundled Python: ${bundledPython}`);
      return bundledPython;
    }

    throw new Error(
      `Python runtime not found — no managed 'python-env' install, and nothing at ` +
      `${bundledPython}.`
    );
  }

  /**
   * Get the path to auto-editor. Managed env, then the bundled runtime's bin/, then THROW.
   */
  getAutoEditorPath(): string {
    // 1. Managed shared Python env (downloaded from GH releases).
    const envDir = assetManager.resolveDir('python-env');
    if (envDir) {
      const managedAE = process.platform === 'win32'
        ? path.join(envDir, 'Scripts', 'auto-editor.exe')
        : path.join(envDir, 'bin', 'auto-editor');
      if (fs.existsSync(managedAE)) {
        log.info(`Using managed auto-editor: ${managedAE}`);
        return managedAE;
      }
    }

    // 2. Bundled Python environment.
    const bundledAutoEditor = path.join(this.pythonPath, 'python-runtime', 'bin', 'auto-editor');
    if (fs.existsSync(bundledAutoEditor)) {
      log.info(`Found bundled auto-editor: ${bundledAutoEditor}`);
      return bundledAutoEditor;
    }

    throw new Error(
      `auto-editor not found — no managed 'python-env' install, and nothing at ` +
      `${bundledAutoEditor}.`
    );
  }

  /**
   * Get Python environment variables
   * Includes PATH to bundled binaries if they exist
   */
  getPythonEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      // editor-backend/ is the Python source root: `import core.…` resolves from here.
      PYTHONPATH: EditorPaths.rootPath
    };

    // Point the Python side at the SAME config directory the Settings UI writes
    // to, so user-edited speed factors (drift_corrections.json) actually reach
    // the pipeline. Packaged → userData/config; dev → the repo's config/.
    // The env var NAME is ACS's and must not change — core/config.py reads it.
    env.AUTOCUT_CONFIG_DIR = EditorPaths.configDir;

    // Build PATH so the Python subprocess's bare `ffmpeg`/`ffprobe`/`auto-editor`
    // calls resolve to our managed binaries first, then bundled, then system.
    const pathComponents: string[] = [];

    // 1. Managed shared binaries (validated working ffmpeg/ffprobe).
    const managedFfmpeg = assetManager.resolveBinary('ffmpeg-tools', 'ffmpeg');
    if (managedFfmpeg) {
      pathComponents.push(path.dirname(managedFfmpeg));
    }
    const managedPython = assetManager.resolveEntry('python-env');
    if (managedPython) {
      pathComponents.push(path.dirname(managedPython));
    }

    // 2. Bundled binaries.
    if (fs.existsSync(this.binariesPath)) {
      pathComponents.push(this.binariesPath);
    }

    const bundledPythonBin = path.join(this.pythonPath, 'python-runtime', 'bin');
    if (fs.existsSync(bundledPythonBin)) {
      pathComponents.push(bundledPythonBin);
    }

    // Add common system paths — these are unix-only, so don't pollute PATH with
    // them on Windows (where PATH is ';'-delimited and these dirs don't exist).
    if (process.platform !== 'win32') {
      pathComponents.push('/usr/local/bin');
      pathComponents.push('/opt/homebrew/bin');
      pathComponents.push('/usr/bin');
      pathComponents.push('/bin');
    }

    // Add existing PATH
    if (process.env.PATH) {
      pathComponents.push(process.env.PATH);
    }

    env.PATH = pathComponents.join(path.delimiter);

    return env;
  }

  /**
   * Check which required binaries resolve. Each resolver now THROWS rather than returning
   * a guess, so "available" is exactly "the resolver produced a real path" — which is what
   * this was always meant to report.
   */
  checkBinaries(): {
    python: boolean;
    ffmpeg: boolean;
    ffprobe: boolean;
    autoEditor: boolean;
  } {
    const ok = (resolve: () => string): boolean => {
      try {
        return fs.existsSync(resolve());
      } catch (error) {
        log.warn(`[BinaryResolver] ${(error as Error).message}`);
        return false;
      }
    };
    return {
      python: ok(() => this.getPythonPath()),
      ffmpeg: ok(() => this.getFfmpegPath()),
      ffprobe: ok(() => this.getFfprobePath()),
      autoEditor: ok(() => this.getAutoEditorPath()),
    };
  }
}
