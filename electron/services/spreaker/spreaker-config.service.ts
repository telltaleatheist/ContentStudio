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
 * WHY A PASTED TOKEN AND NOT AN OAUTH FLOW. Spreaker offers OAuth2 and nothing else — no
 * API keys, no permanent tokens (developers.spreaker.com/guides/authentication/, read
 * 2026-08-22). Refreshing needs the app's client SECRET, which a desktop app cannot hold:
 * anything in the bundle is public. With one account, one show and one operator, the
 * honest arrangement is that he runs the authorize/exchange once by hand and pastes the
 * access token here. When it expires the app says so by name — see the message in
 * `requireCredentials`, which is the whole re-mint procedure.
 *
 * NOTHING HERE RECOVERS FROM A CORRUPT FILE. A credentials file that will not parse is
 * reported as such, naming the path. Reporting it as "not configured" would look exactly
 * like a machine that has never been set up, and the next save would overwrite it.
 */

import * as fs from 'fs';
import * as path from 'path';

/** The file's shape on disk. Written whole, every time. */
interface StoredSpreakerConfig {
  accessToken: string;
  showId: string;
  showName: string | null;
  /** ISO. When these values were last written — the only thing that dates a token. */
  savedAt: string;
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
}

/** Placeholder text a copy-paste can leave behind. Refused as loudly as an empty string. */
const PLACEHOLDERS = ['paste', 'your-token', 'oauth-token', 'access_token', 'xxx'];

function looksLikePlaceholder(value: string): boolean {
  const lowered = value.trim().toLowerCase();
  return PLACEHOLDERS.some((p) => lowered === p || lowered.startsWith(`${p}_`) || lowered.startsWith(`${p}-`));
}

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

  /** The stored config, or null when the file does not exist. Throws on a corrupt one. */
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

    return {
      configured: hasToken && !!showId,
      hasToken,
      showId,
      showName: stored?.showName ?? null,
      savedAt: stored && stored.savedAt ? stored.savedAt : null,
      credentialsPath: this.filePath,
      reason,
    };
  }

  /**
   * The credentials for an upload, or a refusal that IS the setup procedure.
   *
   * The long message is deliberate. This is the failure an operator meets on a new machine
   * or after a token expires, and "Spreaker is not configured" without the steps is a dead
   * end at exactly the moment the steps are wanted.
   */
  requireCredentials(): SpreakerCredentials {
    const stored = this.read();
    const token = stored?.accessToken.trim() ?? '';
    const showId = stored?.showId.trim() ?? '';

    if (!token || !showId) {
      throw new Error(
        `Spreaker is not configured, so nothing can be uploaded. ` +
        `${!token ? 'No access token is stored. ' : ''}` +
        `${!showId ? 'No show id is stored. ' : ''}` +
        `Set them in Settings → Spreaker. To get a token: sign in at spreaker.com, enable ` +
        `Developer Tools in your account settings to register an app (client id + secret), ` +
        `then run the OAuth2 authorize flow once by hand — ` +
        `https://www.spreaker.com/oauth2/authorize?client_id=…&response_type=code&scope=basic&redirect_uri=… ` +
        `— and exchange the code at https://api.spreaker.com/oauth2/token for an ` +
        `access_token. The show id is the number in your show's URL. Credentials live in ` +
        `${this.filePath} and never leave this machine.`
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
  requireTarget(): { showId: string; showName: string | null } {
    const { showId, showName } = this.requireCredentials();
    return { showId, showName };
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
        // Omitted means unchanged — but there has to BE something to leave unchanged.
        accessToken = existing?.accessToken.trim() ?? '';
        if (!accessToken) {
          throw new Error(
            `No Spreaker access token is stored and none was supplied, so there is nothing ` +
            `to save it alongside. Paste the token as well.`
          );
        }
      } else {
        if (typeof input.accessToken !== 'string') {
          throw new Error(
            `The Spreaker access token must be a string; got ${typeof input.accessToken}.`
          );
        }
        accessToken = input.accessToken.trim();
        if (!accessToken) {
          throw new Error(
            `The Spreaker access token is empty. To remove the integration use Clear, which ` +
            `says what it does; saving a blank token would silently disconnect it.`
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

      const next: StoredSpreakerConfig = {
        accessToken,
        showId,
        showName,
        savedAt: new Date().toISOString(),
      };

      // 0600 on the write AND a chmod after it: the mode argument is ignored when the file
      // already exists, which is exactly the case that matters here. Same idiom as
      // youtube-auth.service.ts's writeBundles.
      fs.writeFileSync(this.filePath, JSON.stringify(next, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      });
      try {
        fs.chmodSync(this.filePath, 0o600);
      } catch {
        /* best-effort on platforms without chmod */
      }

      return this.status();
    });

    this.writeQueue = run.then(() => undefined, () => undefined);
    return run;
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
