/**
 * Spreaker OAuth2
 *
 * The two calls that mint an access token and re-mint it — `authorization_code` and
 * `refresh_token`, both at `POST https://api.spreaker.com/oauth2/token` — plus the pure
 * builder for the authorize URL the operator opens.
 *
 * TRANSPORT ONLY, in the same sense as spreaker-api.service.ts: nothing here reads or
 * writes the credentials file, decides when a refresh is due, or knows what a show is.
 * SpreakerConfigService owns all of that. This file owns the wire format and the words a
 * failure comes back with.
 *
 * ── WHY THERE IS NO LOOPBACK SERVER ──────────────────────────────────────────────────
 *
 * youtube-auth.service.ts runs a one-shot HTTP server on an ephemeral 127.0.0.1 port and
 * lets Google redirect the code straight into it. That works because Google's Desktop-app
 * clients accept ANY loopback port without pre-registration. Spreaker does not: it
 * matches `redirect_uri` literally against the one registered on the app, and the
 * operator's app registers exactly `http://localhost` — no port, no path. A server would
 * have to bind port 80, and the exchange would still have to send a redirect_uri that
 * matched. So the browser lands on a localhost that refuses the connection, the `code` is
 * sitting in the address bar, and the operator copies it into Settings. That is the whole
 * of the manual step, and it is a consequence of Spreaker's registration rules rather
 * than a shortcut.
 *
 * NOTHING HERE IS LOGGED. The client secret, the code and both tokens all pass through
 * this file and none of them appears in a log line, an error message or a URL query
 * string — the secret and the code travel in the request BODY.
 */

import axios from 'axios';
import { readErrorResponse } from './spreaker-api.service';

/** Where the operator approves the app. Opened in his own browser, never in a window here. */
export const SPREAKER_AUTHORIZE_ENDPOINT = 'https://www.spreaker.com/oauth2/authorize';

/** Where codes and refresh tokens become access tokens. Read 2026-08-25. */
export const SPREAKER_TOKEN_ENDPOINT = 'https://api.spreaker.com/oauth2/token';

/**
 * The registered callback, and it is EXACTLY this string.
 *
 * It is sent twice — once on authorize, once on exchange — and Spreaker compares both
 * against the app's registration. A trailing slash, a port or a path is a different URI
 * and produces a 400 that does not say which of the three copies disagreed.
 */
export const SPREAKER_REDIRECT_URI = 'http://localhost';

/** The only scope Spreaker offers. There is no narrower, upload-only one to ask for. */
export const SPREAKER_SCOPE = 'basic';

/**
 * What a token endpoint call yields.
 *
 * `refreshToken` is null when the reply carried none — which is a fact about the reply,
 * not a missing value to be filled in. What that means differs between the two grants and
 * is decided by the caller.
 */
export interface SpreakerTokenGrant {
  accessToken: string;
  refreshToken: string | null;
  /** ISO. `expires_in` counted from the instant of THIS call, which is the only anchor. */
  expiresAt: string;
}

/**
 * The URL the operator opens to approve the app. PURE, so it can be read against
 * Spreaker's docs without a network, a token or a browser.
 */
export function buildAuthorizeUrl(params: { clientId: string; state: string }): string {
  const query = new URLSearchParams({
    client_id: params.clientId,
    response_type: 'code',
    state: params.state,
    scope: SPREAKER_SCOPE,
    redirect_uri: SPREAKER_REDIRECT_URI,
  });
  return `${SPREAKER_AUTHORIZE_ENDPOINT}?${query.toString()}`;
}

/**
 * Spreaker's own words about a failed token call, or the raw body when it is not its
 * error envelope.
 *
 * Verbatim on purpose. "Invalid authorization code" and "invalid client credentials" are
 * different next actions, and both are lost by a summary.
 */
function describeFailure(status: number, body: unknown, raw: string): string {
  const fromEnvelope = body === null ? null : readErrorResponse(body);
  if (fromEnvelope) return `HTTP ${status}: ${fromEnvelope}`;
  const text = raw.trim().slice(0, 400);
  return text ? `HTTP ${status}: ${text}` : `HTTP ${status} with an empty body`;
}

/**
 * One call to the token endpoint.
 *
 * `validateStatus` is opened up so a 4xx arrives as a RESPONSE rather than as an axios
 * exception: the body of a 4xx is Spreaker's error envelope, and it is the only part of
 * the failure worth showing.
 */
async function postToken(
  fields: Record<string, string>,
  failureHint: string
): Promise<SpreakerTokenGrant> {
  let status: number;
  let data: unknown;
  try {
    const resp = await axios.post(SPREAKER_TOKEN_ENDPOINT, new URLSearchParams(fields).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      validateStatus: () => true,
    });
    status = resp.status;
    data = resp.data;
  } catch (err) {
    // No response at all — DNS, TLS, an offline machine. Nothing about the credentials
    // has been learned, so the message says so rather than blaming them.
    throw new Error(
      `Could not reach Spreaker's token endpoint (${SPREAKER_TOKEN_ENDPOINT}): ` +
      `${err instanceof Error ? err.message : String(err)}. Nothing was changed.`
    );
  }

  if (status < 200 || status >= 300) {
    const raw = typeof data === 'string' ? data : JSON.stringify(data ?? '');
    throw new Error(
      `Spreaker refused the request — ${describeFailure(status, data, raw)}. ${failureHint}`
    );
  }

  const body = data as Record<string, unknown> | null;
  const accessToken = typeof body?.access_token === 'string' ? body.access_token.trim() : '';
  if (!accessToken) {
    throw new Error(
      `Spreaker replied HTTP ${status} with no access_token in it. Nothing was saved.`
    );
  }

  const expiresIn = Number(body?.expires_in);
  if (!Number.isFinite(expiresIn)) {
    throw new Error(
      `Spreaker's reply carried expires_in ${JSON.stringify(body?.expires_in)}, which is not a ` +
      `number, so there is no expiry to record. Nothing was saved.`
    );
  }

  const refreshToken =
    typeof body?.refresh_token === 'string' && body.refresh_token.trim()
      ? body.refresh_token.trim()
      : null;

  return {
    accessToken,
    refreshToken,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
  };
}

/**
 * Trade an authorization code for tokens.
 *
 * The code is single-use and short-lived, so the failure message has to name that: an
 * operator who pasted yesterday's code needs to be told to re-authorize, not to check his
 * client secret.
 */
export function exchangeAuthorizationCode(params: {
  clientId: string;
  clientSecret: string;
  code: string;
}): Promise<SpreakerTokenGrant> {
  return postToken(
    {
      grant_type: 'authorization_code',
      client_id: params.clientId,
      client_secret: params.clientSecret,
      redirect_uri: SPREAKER_REDIRECT_URI,
      code: params.code,
    },
    `Authorization codes are single-use and expire within minutes, so a code that has ` +
    `already been exchanged or was copied a while ago will be refused: press "Authorize ` +
    `with Spreaker" again and exchange the new code straight away. If it still fails, the ` +
    `stored client id or client secret does not match the registered app.`
  );
}

/**
 * Trade the stored refresh token for a fresh access token.
 *
 * A refusal here means the saved authorization is gone — revoked at Spreaker, or the app's
 * secret was regenerated — and the only cure is a new authorize/exchange.
 */
export function refreshAccessToken(params: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<SpreakerTokenGrant> {
  return postToken(
    {
      grant_type: 'refresh_token',
      client_id: params.clientId,
      client_secret: params.clientSecret,
      refresh_token: params.refreshToken,
    },
    `The stored refresh token was not accepted. It is revoked, or the client id or client ` +
    `secret no longer matches the registered app. Authorize with Spreaker again and ` +
    `exchange a new code.`
  );
}
