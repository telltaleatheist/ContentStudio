/**
 * Spreaker IPC
 *
 * The three channels that read and write the Spreaker credentials, registered in one call
 * the way setupPublishIpc is. Namespaced `spreaker-*`.
 *
 * SEPARATE FROM publish-* on purpose. These are about the machine's connection to
 * Spreaker, not about any one item: the settings page uses them to configure it and the
 * publish panel uses `spreaker-get-status` to decide between showing an upload button and
 * showing "Spreaker is not configured, here is where the token goes". An item-scoped
 * channel could not answer that question before an item is open.
 *
 * THE TOKEN NEVER COMES BACK OUT. `status()` is the only shape that reaches the renderer
 * (see SpreakerConfigStatus), and it carries a boolean for the token's presence. There is
 * deliberately no "get token" channel — nothing in the renderer has any use for the value,
 * and a channel that returns a secret is a channel that eventually logs one.
 */

import { ipcMain } from 'electron';
import * as log from 'electron-log';
import { SpreakerConfigSave, SpreakerConfigService } from './spreaker-config.service';

/** Uniform envelope, matching every publish-* channel. */
type Result<T> = { success: true; data: T } | { success: false; error: string };

function ok<T>(data: T): Result<T> {
  return { success: true, data };
}
function fail(error: string): Result<never> {
  return { success: false, error };
}

export function setupSpreakerIpc(config: SpreakerConfigService): void {
  if (!config || typeof config.status !== 'function') {
    throw new Error('setupSpreakerIpc requires a SpreakerConfigService.');
  }

  /**
   * Is Spreaker set up, and if not, what is missing and where does it go?
   *
   * Read on every call rather than cached: the settings page and the publish panel are
   * different windows' worth of state, and a token saved in one has to be visible to the
   * other without a restart.
   */
  ipcMain.handle('spreaker-get-status', async () => {
    try {
      return ok(config.status());
    } catch (err: any) {
      return fail(err?.message || String(err));
    }
  });

  /**
   * Save the show id, and the token when one is supplied.
   *
   * An OMITTED token means "leave the stored one alone" — the settings page shows only
   * whether a token exists, so re-saving a show id must not demand the token again. It is
   * validated in the config service, which names the value and the rule; that message is
   * what the settings page shows.
   */
  ipcMain.handle('spreaker-save-credentials', async (_e, input: SpreakerConfigSave) => {
    try {
      const status = await config.save(input);
      // The show id is not a secret and the token is not logged — this line says a save
      // happened and to what show, which is what a support question needs.
      log.info(
        `[Spreaker] credentials saved: show ${status.showId}` +
        `${status.showName ? ` (${status.showName})` : ''}, token ${status.hasToken ? 'present' : 'ABSENT'}`
      );
      return ok(status);
    } catch (err: any) {
      log.error('[Spreaker] saving credentials failed:', err);
      return fail(err?.message || String(err));
    }
  });

  /** Remove the credentials file. Explicit, and the only way a stored token goes away. */
  ipcMain.handle('spreaker-clear-credentials', async () => {
    try {
      const status = await config.clear();
      log.info('[Spreaker] credentials cleared');
      return ok(status);
    } catch (err: any) {
      return fail(err?.message || String(err));
    }
  });

  console.log('[SpreakerIpc] Registered');
}
