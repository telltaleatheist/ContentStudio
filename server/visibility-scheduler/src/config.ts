import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface Config {
  /** Port on 127.0.0.1; nginx is the only thing in front of it. */
  port: number;
  /** Public base of the scheduler, no trailing slash: https://contentstudio.owenmorgan.com/scheduler */
  baseUrl: string;
  /** The Web OAuth client in ContentStudio's Google Cloud project. */
  googleClientId: string;
  googleClientSecret: string;
  /** The one Google account allowed to sign in to the setup page. */
  allowedEmail: string;
  /** IANA zone the setup page shows times in. */
  displayTimeZone: string;
  dataDir: string;
}

const REQUIRED = ['port', 'baseUrl', 'googleClientId', 'googleClientSecret', 'allowedEmail', 'displayTimeZone'] as const;

/** Reads <SCHEDULER_DATA_DIR>/config.json. Anything missing stops the service at start. */
export function loadConfig(): Config {
  const dataDir = process.env.SCHEDULER_DATA_DIR;
  if (!dataDir) throw new Error('SCHEDULER_DATA_DIR is not set');
  // The directory holds refresh tokens that can change every video on three channels.
  const mode = statSync(dataDir).mode & 0o777;
  if (mode & 0o077) throw new Error(`${dataDir} is mode ${mode.toString(8)}; it must be 700 (it holds YouTube tokens)`);
  const raw = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as Record<string, unknown>;
  for (const key of REQUIRED) {
    if (raw[key] === undefined || raw[key] === '') throw new Error(`config.json is missing ${key}`);
  }
  if (typeof raw.port !== 'number') throw new Error('config.json: port must be a number');
  new Intl.DateTimeFormat('en-GB', { timeZone: String(raw.displayTimeZone) }); // throws on an unknown zone
  return {
    port: raw.port,
    baseUrl: String(raw.baseUrl).replace(/\/+$/, ''),
    googleClientId: String(raw.googleClientId),
    googleClientSecret: String(raw.googleClientSecret),
    allowedEmail: String(raw.allowedEmail).toLowerCase(),
    displayTimeZone: String(raw.displayTimeZone),
    dataDir,
  };
}
