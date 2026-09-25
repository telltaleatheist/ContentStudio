/**
 * Where the app keeps its userData, and the one declared way a DEVELOPMENT run may put it
 * elsewhere (P8b).
 *
 * main.ts pins userData with `app.setPath` (see its comment: the dev and packaged runs disagree
 * about the app's name), and that pin also means Chromium's `--user-data-dir` has no effect.
 * Two agents launched the real app on Owen's data by mistake that way (docs/crucible/P2.md). So a
 * dev run can name another folder with CONTENTSTUDIO_USER_DATA, and nothing else moves it:
 *
 *   - honoured ONLY when the app is not packaged: a shipped build always uses Owen's real folder,
 *     whatever its environment says, and says it ignored the variable;
 *   - an absolute path, or the run is refused by name (a relative one would land wherever the
 *     launch happened to start);
 *   - logged at boot either way (Law 8), so a run's log says whose data it ran on.
 *
 * PURE (no electron import), so tools/routing-publish-checks.js asserts every case.
 */
import * as path from 'path';

export const USER_DATA_ENV = 'CONTENTSTUDIO_USER_DATA';

export interface UserDataChoice {
  path: string;
  /** 'env' when the variable moved it; 'pinned' for the app's own folder. */
  source: 'env' | 'pinned';
  /** The boot log line. */
  line: string;
}

export function resolveUserDataPath(input: { env: Record<string, string | undefined>; isPackaged: boolean; appData: string }): UserDataChoice {
  const pinned = path.join(input.appData, 'contentstudio');
  const asked = (input.env[USER_DATA_ENV] ?? '').trim();
  if (asked === '') return { path: pinned, source: 'pinned', line: `userData: ${pinned}` };
  if (input.isPackaged) {
    return {
      path: pinned,
      source: 'pinned',
      line: `userData: ${pinned} (${USER_DATA_ENV}=${asked} is IGNORED: a packaged build always runs on its own folder)`,
    };
  }
  if (!path.isAbsolute(asked)) {
    throw new Error(`${USER_DATA_ENV} must be an absolute path (got "${asked}"); a relative one would land wherever this run was launched from.`);
  }
  return { path: asked, source: 'env', line: `userData: ${asked} (from ${USER_DATA_ENV}, a development run; the real folder ${pinned} is not touched)` };
}
