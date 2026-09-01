/**
 * Spreaker Config
 *
 * The operator's Spreaker access token and show id, on disk in userData.
 *
 * Modelled on YouTubeAuthService rather than on the api-keys.json handlers, and the
 * differences are the point:
 *
 *   - `userDataPath` is INJECTED, not read from `app` in here, so this is constructible
 *     in a harness against a temp directory (youtube-auth.service.ts:164 does the same).
 *   - The file is written 0600, like youtube-tokens.json and unlike api-keys.json. It
 *     holds a bearer token for a live podcast feed.
 *   - Nothing but `requireCredentials` ever returns the token. `status()` is the ONLY
 *     shape allowed to reach the renderer, and it carries a boolean, never a value — not
 *     even a masked tail, which is a fingerprint of a secret and not a fact anyone needs.
 *
 * WHY THE OAUTH2 CLIENT LIVES HERE. Spreaker offers OAuth2 and nothing else — no API
 * keys, no permanent tokens (developers.spreaker.com/guides/authentication/, read
 * 2026-08-22). This file used to say a desktop app cannot hold the client secret a
 * refresh needs. That is true of a secret SHIPPED IN THE BUNDLE, which is public to
 * everyone who has the app; it is not true of the OPERATOR'S OWN secret, which he types
 * in once and which sits 0600 in his own userData next to the token it mints. Google's
 * client already lives that way in youtube-oauth.json (youtube-auth.service.ts:189), and
 * the two are the same arrangement. So this file now holds `clientId` + `clientSecret` +
 * `refreshToken` as well, and the exchange and the refresh are calls this app makes.
 *
 * A PASTED ACCESS TOKEN STILL WORKS, and is not a fallback in the forbidden sense: it is
 * a second, deliberate, operator-chosen input for someone who already minted a token
 * elsewhere, not a silent recovery from the first one failing. What it cannot do is
 * refresh itself, and `status()` says so by name rather than discovering it at upload
 * time.
 *
 * NOTHING HERE RECOVERS FROM A CORRUPT FILE. A credentials file that will not parse is
 * reported as such, naming the path. Reporting it as "not configured" would look exactly
 * like a machine that has never been set up, and the next save would overwrite it.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  refreshAccessToken,
} from './spreaker-oauth';

/**
 * The file's shape on disk. Written whole, every time.
 *
 * Every string field uses `''` for "not stored" rather than being optional, so `read()`
 * returns one shape and a file written before the OAuth2 fields existed is not a
 * different type from one written after. See `read()` for what that costs.
 */
interface StoredSpreakerConfig {
  accessToken: string;
  showId: string;
  showName: string | null;
  /** ISO. When these values were last written — the only thing that dates a token. */
  savedAt: string;
  /** The operator's registered app. Not a secret: it rides in the authorize URL. */
  clientId: string;
  /** His own secret, not one shipped in the bundle. Never leaves this process. */
  clientSecret: string;
  /** Minted with the access token. Without it the token cannot be renewed, only replaced. */
  refreshToken: string;
  /**
   * ISO, computed from `expires_in` at the moment the token was minted.
   *
   * `''` for "unknown", which is exactly the state of a token that was pasted in by hand:
   * the paste box carries no expiry, and inventing one would be a claim about a token
   * this app never saw issued.
   */
  expiresAt: string;
}

/**
 * What the renderer is allowed to know.
 *
 * `configured` is the single question the panel and the settings page both ask, and the
 * other fields exist to explain a `false` rather than to be recombined into one.
 */
export interface SpreakerConfigStatus {
  /** True only when BOTH a token and a show id are present and non-blank. */
  configured: boolean;
  /** True when a token is stored. Never the token, and never part of it. */
  hasToken: boolean;
  /** The show id, which is not a secret — it is in every public episode URL. */
  showId: string | null;
  showName: string | null;
  /** ISO of the last save, or null when nothing has been saved. */
  savedAt: string | null;
  /** Absolute path of the file, so "where do I put this?" has an answer on screen. */
  credentialsPath: string;
  /** Why `configured` is false, in the words the UI shows. null when it is true. */
  reason: string | null;

  /** True when an OAuth2 client id is stored. The value is not carried; see `authorizeUrl`. */
  hasClientId: boolean;
  /** True when a client secret is stored. Never the secret, and never part of it. */
  hasClientSecret: boolean;
  /** True when a refresh token is stored. Never the token. */
  hasRefreshToken: boolean;
  /**
   * Whether this machine can renew its own access token — client id, client secret and
   * refresh token all present.
   *
   * A separate field rather than an && in the UI because it is the difference between
   * "this keeps working" and "you will be re-authorizing by hand", and that sentence is
   * decided here, once.
   */
  canRefresh: boolean;
  /**
   * ISO of the access token's expiry, or null when it is not known — which is the state of
   * every token that was pasted in rather than minted here.
   */
  expiresAt: string | null;
  /**
   * The URL that opens Spreaker's approval page, or null when no client id is stored.
   *
   * Built here rather than in the renderer because the client id is not sent to the
   * renderer. Null is the honest answer to "what should the Authorize button open?" when
   * there is no app to authorize.
   */
  authorizeUrl: string | null;
}

/** What an upload needs. Only `requireCredentials` returns this. */
export interface SpreakerCredentials {
  accessToken: string;
  showId: string;
  showName: string | null;
}

/**
 * A save. `accessToken` is optional and OMISSION MEANS UNCHANGED — the settings page
 * shows a presence flag, never the token, so re-saving a show id must not require the
 * operator to paste the token again just to prove he still has it.
 *
 * `null` is not accepted for it: "clear the token" is `clear()`, which is a different
 * action with a different consequence, and collapsing the two into one nullable field is
 * how an empty form field ends up revoking a working integration.
 */
export interface SpreakerConfigSave {
  showId: string;
  showName?: string | null;
  accessToken?: string;
  /**
   * The OAuth2 client id of the operator's registered Spreaker app.
   *
   * Same rule as `accessToken`, and for the same reason: `status()` carries only whether
   * one is stored, so the settings box is empty on every load and an empty box has to
   * mean "leave it alone" or re-saving a show id would wipe the app registration.
   */
  clientId?: string;
  /**
   * Its secret. Same rule again — OMISSION MEANS UNCHANGED, and `null` is not accepted
   * for it: removing the OAuth2 client is `clear()`, which is a different action with a
   * different consequence, and collapsing the two into one nullable field is how an empty
   * form field ends up revoking a working integration.
   */
  clientSecret?: string;
}

/** Placeholder text a copy-paste can leave behind. Refused as loudly as an empty string. */
const PLACEHOLDERS = ['paste', 'your-token', 'oauth-token', 'access_token', 'xxx'];

function looksLikePlaceholder(value: string): boolean {
  const lowered = value.trim().toLowerCase();
  return PLACEHOLDERS.some((p) => lowered === p || lowered.startsWith(`${p}_`) || lowered.startsWith(`${p}-`));
}

/**
 * How close to expiry an access token gets renewed before an upload.
 *
 * Spreaker issues tokens with an `expires_in` of about ten years, so this window is never
 * reached in normal operation and the refresh is a safety net rather than a routine. Seven
 * days is wide enough that a machine which is only opened occasionally still renews before
 * an upload fails, and narrow enough that the renewal is not happening on every push.
 */
const REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export class SpreakerConfigService {
  private readonly filePath: string;
  /** Serializes writes, so a show-id save cannot interleave with a token save. */
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(userDataPath: string) {
    if (typeof userDataPath !== 'string' || !userDataPath.trim()) {
      throw new Error(
        `SpreakerConfigService needs the userData path; got ${JSON.stringify(userDataPath)}.`
      );
    }
    this.filePath = path.join(userDataPath, 'spreaker-credentials.json');
  }

  /** Where the credentials live. Shown in the UI; it is the answer to "where do I put it?". */
  get credentialsPath(): string {
    return this.filePath;
  }

  /**
   * The stored config, or null when the file does not exist. Throws on a corrupt one.
   *
   * A FILE WRITTEN BEFORE THE OAUTH2 FIELDS EXISTED READS CLEANLY. Its four keys are
   * present and its four new ones are not, and a missing key becomes `''` — "not stored" —
   * which is the same answer `status()` would give for a machine that has never entered a
   * client id. It is not an error and it does not trigger a rewrite: the file is only
   * written when the operator saves, so an app that is merely opened leaves a working
   * pasted-token setup exactly as it found it.
   */
  private read(): StoredSpreakerConfig | null {
    if (!fs.existsSync(this.filePath)) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch (err) {
      throw new Error(
        `Spreaker credentials file ${this.filePath} could not be read: ` +
        `${err instanceof Error ? err.message : String(err)}. Fix or delete it — it is not ` +
        `being treated as "not configured", because that would overwrite it on the next save.`
      );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(
        `Spreaker credentials file ${this.filePath} does not contain a credentials object.`
      );
    }
    const stored = parsed as Partial<StoredSpreakerConfig>;
    return {
      accessToken: typeof stored.accessToken === 'string' ? stored.accessToken : '',
      showId: typeof stored.showId === 'string' ? stored.showId : '',
      showName: typeof stored.showName === 'string' && stored.showName.trim() ? stored.showName : null,
      savedAt: typeof stored.savedAt === 'string' ? stored.savedAt : '',
      clientId: typeof stored.clientId === 'string' ? stored.clientId : '',
      clientSecret: typeof stored.clientSecret === 'string' ? stored.clientSecret : '',
      refreshToken: typeof stored.refreshToken === 'string' ? stored.refreshToken : '',
      expiresAt: typeof stored.expiresAt === 'string' ? stored.expiresAt : '',
    };
  }

  /** The renderer-safe projection. Never throws for "not configured" — that is an answer. */
  status(): SpreakerConfigStatus {
    const stored = this.read();
    const hasToken = !!stored && stored.accessToken.trim().length > 0;
    const showId = stored && stored.showId.trim() ? stored.showId.trim() : null;

    let reason: string | null = null;
    if (!stored) {
      reason = 'Spreaker has never been set up on this machine.';
    } else if (!hasToken && !showId) {
      reason = 'No Spreaker access token and no show id are stored.';
    } else if (!hasToken) {
      reason = 'A Spreaker show id is stored, but no access token.';
    } else if (!showId) {
      reason = 'A Spreaker access token is stored, but no show id.';
    }

    const clientId = stored ? stored.clientId.trim() : '';
    const hasClientSecret = !!stored && stored.clientSecret.trim().length > 0;
    const hasRefreshToken = !!stored && stored.refreshToken.trim().length > 0;

    return {
      configured: hasToken && !!showId,
      hasToken,
      showId,
      showName: stored?.showName ?? null,
      savedAt: stored && stored.savedAt ? stored.savedAt : null,
      credentialsPath: this.filePath,
      reason,
      hasClientId: clientId.length > 0,
      hasClientSecret,
      hasRefreshToken,
      canRefresh: clientId.length > 0 && hasClientSecret && hasRefreshToken,
      expiresAt: stored && stored.expiresAt ? stored.expiresAt : null,
      authorizeUrl: clientId ? buildAuthorizeUrl({ clientId, state: this.newState() }) : null,
    };
  }

  /**
   * A fresh `state` for an authorize URL.
   *
   * It is NOT a CSRF defence here and it is not stored: the redirect goes to a
   * `http://localhost` that nothing in this app is listening on, so `state` never comes
   * back to be compared against anything. It is sent because it is part of the authorize
   * request Spreaker documents, and it is random rather than fixed so that two authorize
   * runs are not the same URL.
   */
  private newState(): string {
    return crypto.randomBytes(16).toString('hex');
  }

  /**
   * The credentials for an upload, or a refusal that IS the setup procedure.
   *
   * The long message is deliberate. This is the failure an operator meets on a new machine
   * or after a token expires, and "Spreaker is not configured" without the steps is a dead
   * end at exactly the moment the steps are wanted.
   */
  requireCredentials(context: 'upload' | 'read' = 'upload'): SpreakerCredentials {
    const stored = this.read();
    const token = stored?.accessToken.trim() ?? '';
    const showId = stored?.showId.trim() ?? '';

    if (!token || !showId) {
      // The read path gets the short form. The calendar shows this refusal as a toast
      // titled "Spreaker schedule not read", and six token-setup steps in a toast serve
      // nobody who was only looking at the board; the walkthrough belongs to the moment
      // an upload is being set up.
      if (context === 'read') {
        throw new Error(
          `Spreaker is not configured, so the show's schedule cannot be read. ` +
          `${!token ? 'No access token is stored. ' : ''}` +
          `${!showId ? 'No show id is stored. ' : ''}` +
          `Set them in Settings → Spreaker.`
        );
      }
      throw new Error(
        `Spreaker is not configured, so nothing can be uploaded. ` +
        `${!token ? 'No access token is stored. ' : ''}` +
        `${!showId ? 'No show id is stored. ' : ''}` +
        `Set them in Settings → Spreaker. To get a token: sign in at spreaker.com, enable ` +
        `Developer Tools in your account settings and register an app whose redirect URI is ` +
        `exactly http://localhost; paste its client id and client secret into Settings → ` +
        `Spreaker, press "Authorize with Spreaker", copy the code= value out of the address ` +
        `bar when localhost fails to load, and press "Exchange & save token". The show id is ` +
        `the number in your show's URL. Credentials live in ${this.filePath} and never leave ` +
        `this machine.`
      );
    }

    return { accessToken: token, showId, showName: stored?.showName ?? null };
  }

  /**
   * The show an upload targets, WITHOUT the token.
   *
   * This is what publish/ is given. It still fails when the token is missing — an upload
   * that would 401 must be refused before the file is read, not after — but the value
   * never crosses into the publish module.
   */
  requireTarget(context: 'upload' | 'read' = 'upload'): { showId: string; showName: string | null } {
    const { showId, showName } = this.requireCredentials(context);
    return { showId, showName };
  }

  /**
   * The credentials for an upload, renewing the access token first when it is close to
   * expiry and this machine is able to renew it.
   *
   * THIS IS WHAT THE UPLOADER GETS. `requireCredentials()` is the synchronous read and
   * still exists for `requireTarget()`, which wants the show and the assurance that a
   * token exists, not the token itself.
   *
   * Three conditions, all of them necessary: an expiry is recorded (a pasted token has
   * none, and a token whose expiry is unknown is not a token known to be expiring), it is
   * within the window, and there is a client id, a client secret and a refresh token to
   * renew it with. When they hold, a failed renewal FAILS THE UPLOAD with Spreaker's own
   * words: proceeding on a token that is about to be — or already is — rejected would turn
   * a nameable credentials problem into a 401 mid-upload of a 132 MB file.
   */
  async requireFreshCredentials(): Promise<SpreakerCredentials> {
    const before = this.status();
    if (before.canRefresh && before.expiresAt) {
      const expiresAt = Date.parse(before.expiresAt);
      if (!Number.isFinite(expiresAt)) {
        throw new Error(
          `The stored Spreaker token expiry ${JSON.stringify(before.expiresAt)} in ` +
          `${this.filePath} is not a date, so there is no way to tell whether the token is ` +
          `still valid. Re-authorize in Settings → Spreaker to replace it.`
        );
      }
      if (expiresAt - Date.now() <= REFRESH_WINDOW_MS) {
        await this.refreshToken();
      }
    }
    return this.requireCredentials();
  }

  /**
   * Trade an authorization code for an access token, and store what comes back.
   *
   * THE CODE IS NEVER WRITTEN DOWN. It is single-use and lives for minutes; the moment it
   * has been exchanged it is worth nothing, and a copy of it on disk is a copy of a
   * credential that bought a live one.
   *
   * A reply with no refresh_token is still stored. The access token in it is real and the
   * operator asked for it; what is lost is the ability to renew it, and `canRefresh` says
   * so on the next status rather than a second exchange being demanded for a code that no
   * longer exists.
   */
  async exchangeCode(input: { code: string }): Promise<SpreakerConfigStatus> {
    const code = typeof input?.code === 'string' ? input.code.trim() : '';
    if (!code) {
      throw new Error(
        `No authorization code was supplied. It is the code= value in the address bar after ` +
        `pressing "Authorize with Spreaker" and approving the app — the page itself will not ` +
        `load, which is expected.`
      );
    }

    const stored = this.read();
    const clientId = stored ? stored.clientId.trim() : '';
    const clientSecret = stored ? stored.clientSecret.trim() : '';
    if (!clientId || !clientSecret) {
      throw new Error(
        `A code cannot be exchanged: ` +
        `${!clientId ? 'no OAuth2 client id is stored. ' : ''}` +
        `${!clientSecret ? 'no OAuth2 client secret is stored. ' : ''}` +
        `Both come from the app you registered under Developer Tools at spreaker.com. Save ` +
        `them in Settings → Spreaker first, then authorize.`
      );
    }

    const grant = await exchangeAuthorizationCode({ clientId, clientSecret, code });
    return this.persistGrant(grant, stored);
  }

  /**
   * Renew the access token from the stored refresh token.
   *
   * Refuses by name when any of the three values it needs is absent, because "refresh
   * failed" for a machine that never had a refresh token is a different problem from one
   * whose authorization was revoked, and only the second is about Spreaker.
   */
  async refreshToken(): Promise<SpreakerConfigStatus> {
    const stored = this.read();
    const clientId = stored ? stored.clientId.trim() : '';
    const clientSecret = stored ? stored.clientSecret.trim() : '';
    const refresh = stored ? stored.refreshToken.trim() : '';
    if (!clientId || !clientSecret || !refresh) {
      throw new Error(
        `The Spreaker access token cannot be renewed on this machine: ` +
        `${!clientId ? 'no OAuth2 client id is stored. ' : ''}` +
        `${!clientSecret ? 'no OAuth2 client secret is stored. ' : ''}` +
        `${!refresh ? 'no refresh token is stored — a token that was pasted in by hand ' +
          'carries none. ' : ''}` +
        `Save the client id and secret in Settings → Spreaker and authorize once; every ` +
        `renewal after that is automatic.`
      );
    }

    const grant = await refreshAccessToken({ clientId, clientSecret, refreshToken: refresh });
    return this.persistGrant(grant, stored);
  }

  /**
   * Write a minted token alongside everything already stored.
   *
   * `stored` is passed in rather than re-read so the client id and secret written here are
   * the ones the grant was obtained with.
   *
   * A refresh reply MAY omit refresh_token (RFC 6749 §6), and then the one just used is
   * still valid. Keeping it is not a recovery from a missing value — the reply did not
   * replace it, so there is nothing to replace.
   */
  private persistGrant(
    grant: { accessToken: string; refreshToken: string | null; expiresAt: string },
    stored: StoredSpreakerConfig | null
  ): Promise<SpreakerConfigStatus> {
    const run = this.writeQueue.then(() => {
      const current = this.read();
      const base = current ?? stored;
      if (!base) {
        throw new Error(
          `The Spreaker credentials file ${this.filePath} disappeared while the token was ` +
          `being minted, so there is nothing to store it alongside. The new token has been ` +
          `discarded; save the client id and secret again and re-authorize.`
        );
      }

      const next: StoredSpreakerConfig = {
        ...base,
        accessToken: grant.accessToken,
        refreshToken: grant.refreshToken === null ? base.refreshToken : grant.refreshToken,
        expiresAt: grant.expiresAt,
        savedAt: new Date().toISOString(),
      };

      this.writeFile(next);
      return this.status();
    });

    this.writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * The file, whole and 0600.
   *
   * 0600 on the write AND a chmod after it: the mode argument is ignored when the file
   * already exists, which is exactly the case that matters here. Same idiom as
   * youtube-auth.service.ts's writeBundles.
   */
  private writeFile(next: StoredSpreakerConfig): void {
    fs.writeFileSync(this.filePath, JSON.stringify(next, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      /* best-effort on platforms without chmod */
    }
  }

  /**
   * Write the config, read-modify-write, serialized.
   *
   * Every value is validated rather than trusted. A show id that is not a number is the
   * likeliest paste error there is — the show's *name* is right next to it in the URL —
   * and storing it would produce a 404 at upload time with nothing pointing at the cause.
   */
  save(input: SpreakerConfigSave): Promise<SpreakerConfigStatus> {
    const run = this.writeQueue.then(() => {
      if (!input || typeof input !== 'object') {
        throw new Error(`Spreaker settings must be an object; got ${JSON.stringify(input)}.`);
      }

      const showId = typeof input.showId === 'string' ? input.showId.trim() : '';
      if (!showId) {
        throw new Error(
          `A Spreaker show id is required. It is the number in your show's URL ` +
          `(spreaker.com/show/1234567 → 1234567).`
        );
      }
      if (!/^\d+$/.test(showId)) {
        throw new Error(
          `Spreaker show id ${JSON.stringify(showId)} is not a number. It is the numeric id ` +
          `in your show's URL (spreaker.com/show/1234567 → 1234567), not the show's name.`
        );
      }

      const existing = this.read();

      let accessToken: string;
      if (input.accessToken === undefined) {
        // Omitted means unchanged. Whether there is anything to leave unchanged is decided
        // below, once the OAuth2 client is known: a client id + secret is a complete answer
        // to "how does this machine get a token", so a save carrying them and no token is
        // not the empty save this used to refuse.
        accessToken = existing?.accessToken.trim() ?? '';
      } else {
        if (typeof input.accessToken !== 'string') {
          throw new Error(
            `The Spreaker access token must be a string; got ${typeof input.accessToken}.`
          );
        }
        accessToken = input.accessToken.trim();
        if (!accessToken) {
          throw new Error(
            `The Spreaker access token is empty. To remove the integration use "Remove from ` +
            `this machine", which says what it does; saving a blank token would silently ` +
            `disconnect it.`
          );
        }
        if (looksLikePlaceholder(accessToken)) {
          throw new Error(
            `${JSON.stringify(accessToken)} looks like placeholder text rather than a Spreaker ` +
            `access token. Paste the access_token value from the OAuth2 token exchange.`
          );
        }
      }

      const showName =
        input.showName === undefined
          ? existing?.showName ?? null
          : typeof input.showName === 'string' && input.showName.trim()
            ? input.showName.trim()
            : null;

      const clientId = this.readOAuthField(input.clientId, existing?.clientId, {
        label: 'OAuth2 client id',
        source: 'It is the Client ID of the app you registered under Developer Tools at spreaker.com.',
      });
      const clientSecret = this.readOAuthField(input.clientSecret, existing?.clientSecret, {
        label: 'OAuth2 client secret',
        source: 'It is the Client Secret of that same registered app.',
      });

      // The file has to leave this machine ABLE to upload, by one route or the other: a
      // token it already holds, or the client id + secret that mint one. A show id and
      // nothing else is a file that can only produce a 401.
      if (!accessToken && !(clientId && clientSecret)) {
        throw new Error(
          `Nothing was saved. There is no stored Spreaker access token and none was ` +
          `supplied, and no OAuth2 client id and secret to mint one with. Enter the client ` +
          `id and secret of your registered app (then Authorize), or paste an access token ` +
          `you minted elsewhere.`
        );
      }

      const next: StoredSpreakerConfig = {
        accessToken,
        showId,
        showName,
        savedAt: new Date().toISOString(),
        clientId,
        clientSecret,
        // Neither is touched by a save: they belong to a token, and a save does not mint
        // one. A save that REPLACES the access token by hand leaves them alone too, and
        // `canRefresh` then describes a refresh token that would renew a token nobody is
        // using — which is why the settings page reports both facts separately.
        refreshToken: existing?.refreshToken ?? '',
        // A HAND-PASTED TOKEN HAS NO KNOWN EXPIRY, so replacing the token here erases the
        // recorded one instead of letting it describe a token it is not about. That also
        // stops the pre-upload renewal from firing on a stale date and silently replacing
        // the token the operator just chose to paste; `refreshToken` below still renews it
        // when he asks for it explicitly.
        expiresAt: input.accessToken === undefined ? existing?.expiresAt ?? '' : '',
      };

      this.writeFile(next);

      return this.status();
    });

    this.writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * One OAuth2 client field out of a save: the supplied value, or the stored one when it
   * was omitted.
   *
   * Both fields carry the SAME rule as the access token — omitted is unchanged, blank is
   * refused — so the rule is written once. Blank is refused rather than treated as "remove
   * it" because neither box is ever prefilled (`status()` carries only whether a value is
   * stored), so an empty box is what a save that only edits the show id looks like.
   */
  private readOAuthField(
    supplied: string | undefined,
    stored: string | undefined,
    field: { label: string; source: string }
  ): string {
    if (supplied === undefined) return stored?.trim() ?? '';

    if (typeof supplied !== 'string') {
      throw new Error(`The Spreaker ${field.label} must be a string; got ${typeof supplied}.`);
    }
    const value = supplied.trim();
    if (!value) {
      throw new Error(
        `The Spreaker ${field.label} is empty. Leave the box blank to keep the stored one; ` +
        `to remove the integration use "Remove from this machine", which says what it does.`
      );
    }
    if (looksLikePlaceholder(value)) {
      throw new Error(
        `${JSON.stringify(value)} looks like placeholder text rather than a Spreaker ` +
        `${field.label}. ${field.source}`
      );
    }
    return value;
  }

  /** Remove the credentials file entirely. Says what it did; there is no half-cleared state. */
  clear(): Promise<SpreakerConfigStatus> {
    const run = this.writeQueue.then(() => {
      if (fs.existsSync(this.filePath)) fs.unlinkSync(this.filePath);
      return this.status();
    });
    this.writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }
}
