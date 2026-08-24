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
  // Whisper resolutions are validated by SPAWNING the binary (-h), so cache the
  // successful result for the process lifetime like ffmpeg/ffprobe. Not-found is
  // NOT cached (throws), so installing the model mid-session is picked up.
  private cachedWhisperCliPath: string | null = null;
  private cachedWhisperModelPath: string | null = null;

  /**
   * Bundled whisper-cli filename for THIS machine's arch. The utilities/bin dir ships
   * per-arch binaries whose ggml/whisper dylibs are @loader_path-linked with matching
   * -x64 / (unsuffixed arm64) names, so each binary loads its own arch's libs and the
   * two sets coexist without collision:
   *   - Apple Silicon (arm64): `whisper-cli` — the proven Metal build (~40x realtime).
   *   - Intel (x64): `whisper-cli-x64` — a CPU/BLAS build (no Metal on Intel Macs).
   *   - Windows: `whisper-cli.exe`.
   */
  private whisperBinaryName(): string {
    if (process.platform === 'win32') return 'whisper-cli.exe';
    if (process.platform === 'darwin') {
      return process.arch === 'arm64' ? 'whisper-cli' : 'whisper-cli-x64';
    }
    return 'whisper-cli';
  }

  /**
   * On macOS, confirm a Mach-O binary actually contains THIS process's architecture
   * before we try to run it — a wrong-arch binary otherwise fails with a confusing
   * dyld error. Fails loud on mismatch; a `file` probe that itself errors is not
   * treated as a mismatch (binaryWorks(-h) is the real gate right after).
   */
  private assertBinaryArch(binaryPath: string, name: string): void {
    if (process.platform !== 'darwin') return;
    let out: string;
    try {
      const { execSync } = require('child_process');
      out = execSync(`file "${binaryPath}"`, { encoding: 'utf8' });
    } catch {
      return; // couldn't probe; the -h run below is the authoritative check
    }
    const expected = process.arch === 'arm64' ? 'arm64' : 'x86_64';
    if (!(out.includes(expected) || out.includes('universal'))) {
      throw new Error(
        `${name} has the wrong architecture for this machine (need ${expected}): ${out.trim()}`
      );
    }
  }

  /**
   * Get the path to the whisper.cpp CLI binary for THIS machine's architecture (see
   * whisperBinaryName — arm64 Metal build, x64 CPU build, or the .exe). A plain
   * `whisper` on PATH is NOT acceptable, so there is deliberately NO PATH fallback.
   * Order: managed catalog entry (future-proofing; no such entry yet, so resolveBinary
   * returns null), then the arch-specific bundled binary under editor-backend/utilities/bin.
   *
   * A bundled binary that exists but lacks +x is chmod'd; its arch is verified against this
   * machine; and — critically — a binary that exists but does NOT actually run (-h) is a
   * hard THROW, never a fallback.
   */
  getWhisperCliPath(): string {
    if (this.cachedWhisperCliPath) return this.cachedWhisperCliPath;

    const binName = this.whisperBinaryName();

    // 1. Managed shared download (no catalog entry yet → resolveBinary returns null).
    const managed = assetManager.resolveBinary('whisper-cli', binName);
    if (managed && this.binaryWorks(managed, ['-h'])) {
      log.info(`Using managed whisper-cli: ${managed}`);
      this.cachedWhisperCliPath = managed;
      return managed;
    }

    // 2. Bundled arch-specific binary under editor-backend/utilities/bin.
    const bundled = path.join(EditorPaths.utilitiesPath, 'bin', binName);
    if (fs.existsSync(bundled)) {
      // Ensure it's executable — a freshly copied bundled binary may lack +x.
      try {
        fs.accessSync(bundled, fs.constants.X_OK);
      } catch {
        try {
          fs.chmodSync(bundled, 0o755);
          log.info(`Made bundled whisper-cli executable: ${bundled}`);
        } catch (chmodError) {
          throw new Error(
            `Whisper binary found but is not executable and chmod failed: ${bundled} ` +
            `(${(chmodError as Error).message}).`
          );
        }
      }
      // Wrong architecture is a loud, specific failure rather than a cryptic dyld error.
      this.assertBinaryArch(bundled, 'Whisper binary');
      // Exists + executable + right arch, but must actually RUN — a non-running binary
      // (missing dylib, bad build) is a throw, not a silent fallback.
      if (!this.binaryWorks(bundled, ['-h'])) {
        throw new Error(
          `Whisper binary found at ${bundled} but it failed to run (-h) — it may be ` +
          `missing its ggml dylibs.`
        );
      }
      log.info(`Using bundled whisper-cli: ${bundled}`);
      this.cachedWhisperCliPath = bundled;
      return bundled;
    }

    // NO PATH fallback — the transcription pipeline needs the exact bundled build.
    throw new Error(`Whisper binary not found — expected a bundled binary at ${bundled}.`);
  }

  /**
   * Get the path to the whisper model. Order: the managed `whisper-large-v3-turbo`
   * catalog entry (a REAL entry — resolveEntry returns null only when not installed),
   * then the bundled editor-backend/utilities/models copy, then the older base-model
   * chain. Throws — no PATH/guess fallback — with an actionable install message when
   * nothing exists.
   */
  getWhisperModelPath(): string {
    if (this.cachedWhisperModelPath) return this.cachedWhisperModelPath;

    // The shipped model is LARGE-V3-TURBO (operator, 2026-08-24 — it replaces base as the
    // editor's transcription model; the catalog comment always said a heavier model could
    // be swapped in here when quality became the priority). The rungs BELOW it exist for
    // real transitional states, never as a silent substitute: a machine that installed
    // base under the older catalog and has not run the setup screen since, or a dev
    // checkout with a different local model bundled. Whichever runs is logged AND recorded
    // in the transcript sidecar's 'model' field, so provenance is always visible.
    // BOTH turbo rungs outrank every base rung — a machine with managed base installed
    // and a bundled turbo present must run turbo, or the swap never lands there.
    const bundled = (size: string) => ({
      kind: 'bundled' as const, name: size,
      p: path.join(EditorPaths.utilitiesPath, 'models', `ggml-${size}.bin`),
    });
    const candidates: Array<{ kind: 'managed' | 'bundled'; name: string; p: string | null }> = [
      { kind: 'managed', name: 'large-v3-turbo', p: assetManager.resolveEntry('whisper-large-v3-turbo') },
      bundled('large-v3-turbo'),
      { kind: 'managed', name: 'base', p: assetManager.resolveEntry('whisper-base') },
      ...['base', 'small', 'medium', 'large-v3'].map(bundled),
    ];
    for (const c of candidates) {
      if (c.p && fs.existsSync(c.p)) {
        log.info(`Using ${c.kind} whisper ${c.name} model: ${c.p}`);
        this.cachedWhisperModelPath = c.p;
        return c.p;
      }
    }

    throw new Error(
      `Whisper model not installed — expected ` +
      `${path.join(EditorPaths.utilitiesPath, 'models', 'ggml-large-v3-turbo.bin')} or a managed ` +
      `'whisper-large-v3-turbo' install.`
    );
  }

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
   * Resolve the optional voice-isolation (audio-separator) env directory.
   * This is the managed, conda-packed env downloaded into the shared OwenMorgan
   * location; returns its absolute root, or null when not installed.
   * Mirrors the managed alt-env resolution used by getAutoEditorPath.
   *
   * null is a legitimate ANSWER here, not a fallback: the whole point of this call is to
   * tell the caller whether the optional component is installed.
   */
  getVoiceSeparatorEnvDir(): string | null {
    return assetManager.resolveDir('voice-separator-env');
  }

  /**
   * Resolve the Python interpreter inside the voice-isolation env, or null when
   * the env isn't installed. Uses the catalog `entry` (bin/python3 on unix,
   * python.exe on Windows).
   */
  getVoiceSeparatorPython(): string | null {
    const envDir = this.getVoiceSeparatorEnvDir();
    if (!envDir) return null;
    const py = process.platform === 'win32'
      ? path.join(envDir, 'python.exe')
      : path.join(envDir, 'bin', 'python3');
    return fs.existsSync(py) ? py : null;
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
