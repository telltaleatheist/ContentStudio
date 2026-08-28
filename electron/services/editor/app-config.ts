// electron/services/editor/app-config.ts
import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as log from 'electron-log';

/**
 * Path roots for the ported AutoCutStudio editor backend.
 *
 * This is the trimmed replacement for ACS's `AppConfig`. ACS resolved everything against
 * one `resourcesPath` that was the PROJECT ROOT in development and `process.resourcesPath`
 * when packaged, with the CLI/core/binaries/python/utilities trees sitting directly under
 * it. In ContentStudio that whole tree lives under `editor-backend/`, so `rootPath` is the
 * ONE thing that moves between dev and packaged and every other path hangs off it.
 *
 * Deliberately NOT ported from ACS's AppConfig:
 *   - the `/Applications/AutoCutStudio.app/Contents/Resources` hardcoded fallback,
 *   - the "CLI not where I expected, go hunting" re-resolution,
 *   - the preload/frontend paths (ContentStudio's main.ts owns those).
 * A missing backend is a loud failure naming the exact directory that is not there, not a
 * silent hunt through other people's app bundles.
 */
export class EditorPaths {
  /** Platform-arch directory name for the per-platform trees (binaries/, python/). */
  static platformDir(): string {
    const platform = process.platform === 'darwin' ? 'mac' :
                     process.platform === 'win32' ? 'win' : 'linux';
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    return `${platform}-${arch}`;
  }

  /**
   * The repo root in development. The compiled file lives at
   * `<repo>/dist/main/services/editor/app-config.js`, so four levels up is the repo —
   * the same relationship main.ts uses to find `frontend/dist`.
   */
  private static repoRoot(): string {
    return path.join(__dirname, '..', '..', '..', '..');
  }

  /**
   * `editor-backend/` — Python source root (PYTHONPATH), the process cwd for every CLI
   * spawn, and the parent of cli/ core/ binaries/ python/ utilities/.
   *
   * Packaged builds must ship it as an extraResource (it contains multi-hundred-MB
   * runtimes that cannot live inside the asar). If it is not there, say so with the path.
   */
  static get rootPath(): string {
    const root = app.isPackaged
      ? path.join(process.resourcesPath, 'editor-backend')
      : path.join(EditorPaths.repoRoot(), 'editor-backend');
    if (!fs.existsSync(root)) {
      throw new Error(
        `Editor backend not found at ${root} — the editor's Python CLIs, binaries and ` +
        `runtimes all live under editor-backend/.`
      );
    }
    return root;
  }

  /** cli/ — editor_manifest.py, editor_export.py, transcribe.py, electron_workflow.py. */
  static get cliPath(): string {
    return path.join(EditorPaths.rootPath, 'cli');
  }

  /** core/ — the Python package the CLIs import (reached via PYTHONPATH = rootPath). */
  static get corePath(): string {
    return path.join(EditorPaths.rootPath, 'core');
  }

  /** binaries/<plat-arch>/ — ffmpeg, ffprobe, auto-editor. */
  static get binariesPath(): string {
    return path.join(EditorPaths.rootPath, 'binaries', EditorPaths.platformDir());
  }

  /** python/<plat-arch>/ — holds python-runtime/bin/python3. */
  static get pythonRuntimePath(): string {
    return path.join(EditorPaths.rootPath, 'python', EditorPaths.platformDir());
  }

  /** utilities/ — bin/ (whisper-cli + dylibs) and models/ (ggml-*.bin). */
  static get utilitiesPath(): string {
    return path.join(EditorPaths.rootPath, 'utilities');
  }

  /**
   * The config directory exported to Python as AUTOCUT_CONFIG_DIR — keep that env var
   * NAME, `core/config.py` reads it.
   *
   * ONE DIRECTORY FOR BOTH RUNS: userData/config, always. It used to be the repo's
   * `config/` in development and userData only when packaged, and the two then kept
   * separate project lists — a week edited in dev was simply absent from the packaged
   * build, which had a copy frozen at whenever it was last seeded. Same app, same Mac,
   * same folders on disk, two answers to "which projects exist".
   *
   * The repo's `config/` keeps its job as the SEED (see bundledConfigPath), which is what
   * it always was for packaged builds. It is no longer read at run time.
   *
   * This is also where projects.json and drift_corrections.json live, so the Python side
   * and the Electron side always agree on one directory.
   */
  static get configDir(): string {
    return path.join(app.getPath('userData'), 'config');
  }

  /** The bundled (read-only) copy of a config file, used to seed the packaged userData copy. */
  static bundledConfigPath(filename: string): string {
    return app.isPackaged
      ? path.join(process.resourcesPath, 'config', filename)
      : path.join(EditorPaths.repoRoot(), 'config', filename);
  }

  /**
   * Absolute path to a config file in `configDir`, seeding it from the bundled copy the
   * first time it is not there (ACS's ensureUserConfig, verbatim in behaviour).
   */
  static ensureConfigFile(filename: string): string {
    const dir = EditorPaths.configDir;
    const target = path.join(dir, filename);

    // Seeds in BOTH runs now. It used to return early in development, because development
    // read the repo's config/ directly and there was nothing to seed; now both read
    // userData, so a fresh dev machine needs the same copy a packaged one does.
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      log.info('[EditorPaths] Created user config directory:', dir);
    }
    if (!fs.existsSync(target)) {
      const bundled = EditorPaths.bundledConfigPath(filename);
      if (!fs.existsSync(bundled)) {
        throw new Error(
          `Editor config ${filename} is missing from both ${dir} and the bundled copy at ${bundled}.`
        );
      }
      fs.copyFileSync(bundled, target);
      log.info(`[EditorPaths] Seeded user config from bundle: ${filename}`);
    }
    return target;
  }
}
