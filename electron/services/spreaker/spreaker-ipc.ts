/**
 * Spreaker IPC
 *
 * The channels that read and write the Spreaker credentials, and the two that mint them,
 * registered in one call the way setupPublishIpc is. Namespaced `spreaker-*`.
 *
 * SEPARATE FROM publish-* on purpose. These are about the machine's connection to
 * Spreaker, not about any one item: the settings page uses them to configure it and the
 * publish panel uses `spreaker-get-status` to decide between showing an upload button and
 * showing "Spreaker is not configured, here is where the token goes". An item-scoped
 * channel could not answer that question before an item is open.
 *
 * NO SECRET COMES BACK OUT. `status()` is the only shape that reaches the renderer (see
 * SpreakerConfigStatus), and it carries a boolean for the presence of the access token,
 * the client secret and the refresh token. There is deliberately no "get token" channel —
 * nothing in the renderer has any use for the value, and a channel that returns a secret
 * is a channel that eventually logs one. `authorizeUrl` is the one exception in kind and
 * not in principle: it is a URL the operator is about to put in his own address bar.
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
        `${status.showName ? ` (${status.showName})` : ''}, token ${status.hasToken ? 'present' : 'ABSENT'}` +
        `, oauth client ${status.hasClientId && status.hasClientSecret ? 'present' : 'incomplete'}`
      );
      return ok(status);
    } catch (err: any) {
      log.error('[Spreaker] saving credentials failed:', err);
      return fail(err?.message || String(err));
    }
  });

  /**
   * Trade the authorization code the operator copied out of the address bar for a token.
   *
   * THE CODE ARRIVES HERE AND GOES NO FURTHER THAN THE REQUEST. It is not logged and it is
   * not stored: it is single-use, it expires in minutes, and after the exchange it buys
   * nothing — but before it, a copy of it is a copy of the credential it buys.
   *
   * Spreaker's refusals come back verbatim. A code that was already used and a client
   * secret that does not match the app are different problems with the same button.
   */
  ipcMain.handle('spreaker-exchange-code', async (_e, input: { code: string }) => {
    try {
      const status = await config.exchangeCode(input);
      log.info(
        `[Spreaker] authorization code exchanged: token present, ` +
        `refresh token ${status.hasRefreshToken ? 'present' : 'ABSENT'}, ` +
        `expires ${status.expiresAt ?? 'unknown'}`
      );
      return ok(status);
    } catch (err: any) {
      // The message is Spreaker's, or a named refusal about what is missing here. The
      // error object is logged; the code never appears in it.
      log.error('[Spreaker] exchanging the authorization code failed:', err?.message || err);
      return fail(err?.message || String(err));
    }
  });

  /**
   * Renew the access token now, on the operator's say-so.
   *
   * The same renewal happens automatically before an upload when the token is close to
   * expiring; this channel exists so the operator can see it work — and see it FAIL — at a
   * moment of his choosing rather than while a 132 MB episode is waiting.
   */
  ipcMain.handle('spreaker-refresh-token', async () => {
    try {
      const status = await config.refreshToken();
      log.info(`[Spreaker] access token renewed; expires ${status.expiresAt ?? 'unknown'}`);
      return ok(status);
    } catch (err: any) {
      log.error('[Spreaker] renewing the access token failed:', err?.message || err);
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
