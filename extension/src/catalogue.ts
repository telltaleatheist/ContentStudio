// Studio catalogue + A/B experiment collection.
//
// This resolves TODO(v1-metadata) in collector.ts. That TODO deferred VideoRecords
// because the analytics query returns only videoIds, a valid VideoRecord needs a real
// publishedAt, and no Studio metadata endpoint had been confirmed — so, correctly, it
// emitted nothing rather than guessing.
//
// The endpoint exists: `creator/list_creator_videos` is what backs Studio's own content
// list, and its `mask` returns videoId, title, description, publish time and duration,
// 100 per request. Reconnoitred and verified live 2026-07-26.
//
// It also closes the A/B loop. `creator/get_creator_videos` returns, per video:
//
//   videoCreatorExperiment.experimentArmData[].title   the variant titles
//   videoCreatorExperiment.result.armResults[]         { arm, watchtimeFraction }
//   videoCreatorExperiment.result.winnerArm            which one won
//   videoCreatorExperiment.result.resultState          CREATOR_EXPERIMENT_RESULT_STATE_*
//                                                      (WINNER | NO_WINNER |
//                                                       NOT_CONCLUSIVE_YET | NOT_ENOUGH_DATA
//                                                       — wire format captured 2026-08-23)
//
// which is exactly the shape VideoVerdict.abTest has been waiting for since the analytics
// design was written. Batches of 50 ids (100 returns HTTP 400).
//
// Both functions are INJECTED into a Studio tab's MAIN world, same as the analytics
// collector: they need window.ytcfg and the SAPISID cookie, and close over nothing.
//
// No fallbacks. Every failure returns a distinct code that reaches the UI unchanged.

import type { VideoRecord } from './types';

export interface CatalogueVideo {
  videoId: string;
  title: string;
  publishedAt: string;   // ISO; '' when never published
  durationSec: number;
  privacy: string;
  isLive: boolean;
  isShort: boolean;
}

export interface AbTestRecord {
  videoId: string;
  channelId: string;
  variants: string[];
  winner: string;        // the winning title, '' when undecided
  liftPct: number;       // winner's share minus the best loser's, in points
  method: 'test-compare';
  decidedAt: string;     // ISO
  shares: number[];      // watch-time share per variant, percent
}

export type CatalogueFailureKind =
  | 'no-sapisid'
  | 'ytcfg-missing'
  | 'channel-mismatch'
  | 'http'
  | 'shape'
  | 'network';

export class CatalogueError extends Error {
  readonly kind: CatalogueFailureKind;
  readonly status: number | undefined;

  constructor(kind: CatalogueFailureKind, message: string, status?: number) {
    super(message);
    this.name = 'CatalogueError';
    this.kind = kind;
    this.status = status;
  }
}

/**
 * Injected: the channel's whole catalogue with real publish dates.
 *
 * Self-contained — runs in the page, closes over nothing.
 */
export async function fetchCatalogueInPage(channelId: string): Promise<any> {
  const ORIGIN = 'https://studio.youtube.com';
  const ENDPOINT = 'https://studio.youtube.com/youtubei/v1/creator/list_creator_videos?alt=json';
  const PAGE_SIZE = 100; // server clamps above this
  const MAX_PAGES = 400;

  const fail = (kind: string, message: string, status?: number) => ({ ok: false, kind, message, status });

  const readCookie = (name: string): string | null => {
    for (const pair of (document.cookie ? document.cookie.split('; ') : [])) {
      const eq = pair.indexOf('=');
      if ((eq === -1 ? pair : pair.slice(0, eq)) === name) {
        return eq === -1 ? '' : decodeURIComponent(pair.slice(eq + 1));
      }
    }
    return null;
  };
  const sapisid = readCookie('SAPISID') || readCookie('__Secure-3PAPISID');
  if (!sapisid) return fail('no-sapisid', 'SAPISID cookie absent — not signed in to Studio.');

  const sha1Hex = async (input: string): Promise<string> => {
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(input)));
    let hex = '';
    for (const b of bytes) hex += b.toString(16).padStart(2, '0');
    return hex;
  };

  const cfg = (window as any).ytcfg;
  if (!cfg || typeof cfg.get !== 'function') return fail('ytcfg-missing', 'window.ytcfg unavailable.');
  const innertube = cfg.get('INNERTUBE_CONTEXT');
  const clientVersion = innertube?.client?.clientVersion;
  const delegation = cfg.get('INNERTUBE_CONTEXT_SERIALIZED_DELEGATION_CONTEXT');
  if (!clientVersion || !delegation) return fail('ytcfg-missing', 'Studio context incomplete.');
  if (cfg.get('CHANNEL_ID') !== channelId) {
    return fail('channel-mismatch', `Tab is on ${cfg.get('CHANNEL_ID')}, expected ${channelId}.`);
  }
  const authUser = cfg.get('SESSION_INDEX') != null ? String(cfg.get('SESSION_INDEX')) : '0';

  const videos: any[] = [];
  let pageToken: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const ts = Math.floor(Date.now() / 1000);
    const authorization = `SAPISIDHASH ${ts}_${await sha1Hex(`${ts} ${sapisid} ${ORIGIN}`)}`;

    const body: any = {
      context: {
        client: { clientName: 62, clientVersion },
        user: { serializedDelegationContext: delegation },
      },
      // Everything on the channel. Shorts ARE collected — VideoRecord.format exists
      // precisely so downstream can separate them, and their packaging metrics are not
      // comparable with long-form, so distillation should partition rather than have the
      // collector silently drop them.
      filter: { and: { operands: [{ channelIdIs: { value: channelId } }] } },
      order: 'VIDEO_ORDER_DISPLAY_TIME_DESC',
      pageSize: PAGE_SIZE,
      mask: {
        videoId: true, title: true, privacy: true, status: true,
        lengthSeconds: true, timePublishedSeconds: true, draftStatus: true,
        origin: true, contentType: true, livestream: { all: true },
      },
    };
    if (pageToken) body.pageToken = pageToken;

    let resp: Response;
    try {
      resp = await fetch(ENDPOINT, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authorization,
          'X-Origin': ORIGIN,
          'X-Goog-AuthUser': authUser,
          'X-YouTube-Delegation-Context': delegation,
          'X-YouTube-Client-Name': '62',
          'X-YouTube-Client-Version': clientVersion,
        },
        body: JSON.stringify(body),
      });
    } catch (err: any) {
      return fail('network', `Network error: ${err?.message || String(err)}`);
    }
    if (!resp.ok) return fail('http', `list_creator_videos returned HTTP ${resp.status}.`, resp.status);

    let data: any;
    try { data = await resp.json(); } catch { return fail('shape', 'Response was not valid JSON.'); }
    if (!Array.isArray(data?.videos)) return fail('shape', 'Response contained no videos array.');

    for (const v of data.videos) {
      if (!v?.videoId) continue;
      const seconds = Number(v.timePublishedSeconds || 0);
      videos.push({
        videoId: v.videoId,
        title: typeof v.title === 'string' ? v.title : '',
        // 0 means never published — emit '' so the caller can reject it rather than
        // silently recording a 1970 date.
        publishedAt: seconds > 0 ? new Date(seconds * 1000).toISOString() : '',
        durationSec: Number(v.lengthSeconds || 0),
        privacy: String(v.privacy || ''),
        isLive: !!v.livestream,
        isShort: String(v.contentType || '').includes('SHORTS'),
      });
    }

    pageToken = data.nextPageToken || null;
    if (!pageToken) break;
  }

  return { ok: true, videos };
}

/**
 * Injected: A/B experiment results for the given videos.
 *
 * Returns only FINISHED, decided experiments — a running or undecided test has no
 * learning to contribute, and recording one as a result would teach the prompt that a
 * coin-flip was a win.
 */
export async function fetchExperimentsInPage(channelId: string, videoIds: string[]): Promise<any> {
  const ORIGIN = 'https://studio.youtube.com';
  const ENDPOINT = 'https://studio.youtube.com/youtubei/v1/creator/get_creator_videos?alt=json';
  const BATCH = 50; // 100 returns HTTP 400

  const fail = (kind: string, message: string, status?: number) => ({ ok: false, kind, message, status });

  const readCookie = (name: string): string | null => {
    for (const pair of (document.cookie ? document.cookie.split('; ') : [])) {
      const eq = pair.indexOf('=');
      if ((eq === -1 ? pair : pair.slice(0, eq)) === name) {
        return eq === -1 ? '' : decodeURIComponent(pair.slice(eq + 1));
      }
    }
    return null;
  };
  const sapisid = readCookie('SAPISID') || readCookie('__Secure-3PAPISID');
  if (!sapisid) return fail('no-sapisid', 'SAPISID cookie absent.');

  const sha1Hex = async (input: string): Promise<string> => {
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(input)));
    let hex = '';
    for (const b of bytes) hex += b.toString(16).padStart(2, '0');
    return hex;
  };

  const cfg = (window as any).ytcfg;
  const innertube = cfg?.get('INNERTUBE_CONTEXT');
  const clientVersion = innertube?.client?.clientVersion;
  const delegation = cfg?.get('INNERTUBE_CONTEXT_SERIALIZED_DELEGATION_CONTEXT');
  if (!clientVersion || !delegation) return fail('ytcfg-missing', 'Studio context incomplete.');
  const authUser = cfg.get('SESSION_INDEX') != null ? String(cfg.get('SESSION_INDEX')) : '0';

  const armIndex = (arm: string): number => Number(String(arm || '').match(/ARM_(\d+)$/)?.[1] || 0);
  const tests: any[] = [];
  /** Distinct `resultState` values this run did not recognise. Non-empty means we stop. */
  const unrecognized = new Set<string>();

  for (let i = 0; i < videoIds.length; i += BATCH) {
    const chunk = videoIds.slice(i, i + BATCH);
    const ts = Math.floor(Date.now() / 1000);
    const authorization = `SAPISIDHASH ${ts}_${await sha1Hex(`${ts} ${sapisid} ${ORIGIN}`)}`;

    let resp: Response;
    try {
      resp = await fetch(ENDPOINT, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authorization,
          'X-Origin': ORIGIN,
          'X-Goog-AuthUser': authUser,
          'X-YouTube-Delegation-Context': delegation,
          'X-YouTube-Client-Name': '62',
          'X-YouTube-Client-Version': clientVersion,
        },
        body: JSON.stringify({
          context: {
            client: { clientName: 62, clientVersion },
            user: { serializedDelegationContext: delegation },
          },
          videoIds: chunk,
          mask: { videoId: true, videoCreatorExperiment: { all: true } },
        }),
      });
    } catch (err: any) {
      return fail('network', `Network error: ${err?.message || String(err)}`);
    }
    if (!resp.ok) return fail('http', `get_creator_videos returned HTTP ${resp.status}.`, resp.status);

    let data: any;
    try { data = await resp.json(); } catch { return fail('shape', 'Response was not valid JSON.'); }

    for (const v of data?.videos || []) {
      const exp = v?.videoCreatorExperiment;
      const result = exp?.result;
      if (!v?.videoId || !exp || !result) continue;

      const variants: string[] = (exp.experimentArmData || [])
        .map((a: any) => a?.title?.textSegments?.[0]?.text)
        .filter((t: any) => typeof t === 'string');

      const shares: number[] = [];
      for (const arm of result.armResults || []) {
        const idx = armIndex(arm.arm);
        if (idx > 0 && typeof arm.watchtimeFraction === 'number') {
          shares[idx - 1] = Number((arm.watchtimeFraction * 100).toFixed(2));
        }
      }

      // WHETHER THIS TEST WAS DECIDED IS A FACT THE RESPONSE STATES. Read it, do not infer it.
      //
      // This used to be inferred from `winnerArm` alone: an unset arm meant undecided. That
      // was correct only by coincidence of Studio's behaviour, and the coincidence is not
      // safe — the A/B exporter, reading the SAME endpoint, sees `winnerArm` populated with
      // the tie-break arm on tests YouTube declared NO_WINNER. On that reading an undecided
      // test walks straight past a `winnerArm` check and is stored as a win, with whatever
      // arm YouTube nominated as the "winner". Those reach the generator through
      // abLearnings as "Winner: <title>", which is the highest-leverage text in the system:
      // the loop would be teaching the model that a coin flip won.
      //
      // `resultState` is the field that says it outright, and it has been documented in this
      // file's own header since the day the loop was written (see the endpoint notes above).
      // It was simply never read.
      // The wire format, finally captured live on 2026-08-23 by the fail-loud guard below:
      // every value carries the CREATOR_EXPERIMENT_RESULT_STATE_ prefix. Observed set:
      // WINNER, NO_WINNER, NOT_CONCLUSIVE_YET, NOT_ENOUGH_DATA. Stripping the prefix (rather
      // than matching prefixed strings) also keeps a bare value working should Studio ever
      // drop the prefix the way its already-normalized copies do.
      const state = String(result.resultState).replace(/^CREATOR_EXPERIMENT_RESULT_STATE_/, '');
      // Decided-without-a-winner and the two still-undecided states all mean the same thing
      // here: there is no winner to record. Only a genuinely unknown value stops the run.
      if (state === 'NO_WINNER' || state === 'NOT_CONCLUSIVE_YET' || state === 'NOT_ENOUGH_DATA') continue;
      if (state !== 'WINNER') {
        unrecognized.add(String(result.resultState));
        continue;
      }
      const winnerIdx = armIndex(result.winnerArm);
      // Kept as fail-loud backstops behind the state check, not as the decision itself.
      if (winnerIdx < 1 || !variants[winnerIdx - 1] || shares.length !== variants.length) continue;

      const winnerShare = shares[winnerIdx - 1] ?? 0;
      const bestLoser = Math.max(...shares.filter((_, i) => i !== winnerIdx - 1), 0);

      tests.push({
        videoId: v.videoId,
        channelId,
        variants,
        winner: variants[winnerIdx - 1],
        // Points of watch-time share over the nearest rival — how decisively it won.
        liftPct: Number((winnerShare - bestLoser).toFixed(2)),
        method: 'test-compare',
        decidedAt: exp.experimentFinishTime?.seconds
          ? new Date(Number(exp.experimentFinishTime.seconds) * 1000).toISOString()
          : new Date().toISOString(),
        shares,
      });
    }
  }

  // An enum this build does not recognise FAILS THE RUN rather than being skipped quietly.
  //
  // This is the deliberate choice and it costs something, so it is written down: failing here
  // aborts the whole collection pass, not just the A/B half, because the caller treats a
  // non-ok result as fatal. The alternative — return the tests we did understand and mention
  // the rest — is worse in the case that actually matters. If the live enum turns out to be
  // prefixed, EVERY test is unrecognised, `tests` is empty, and "collected 0 A/B tests, all
  // fine" is indistinguishable from "this channel ran no tests". The loop would go quiet and
  // nobody would know why, which is the failure this guard exists to prevent, arriving by a
  // different door.
  //
  // Loud and total is recoverable in one Studio visit. Silent and partial is not recoverable
  // at all, because nothing would ever say it happened.
  if (unrecognized.size > 0) {
    return fail(
      'unrecognized-result-state',
      `get_creator_videos returned resultState value(s) this build does not recognise: ` +
      `${[...unrecognized].map((s) => JSON.stringify(s)).join(', ')}. Known values (with or ` +
      `without the CREATOR_EXPERIMENT_RESULT_STATE_ prefix, which is stripped before ` +
      `comparison): WINNER, NO_WINNER, NOT_CONCLUSIVE_YET, NOT_ENOUGH_DATA. No A/B results ` +
      `were recorded from this pass — YouTube has grown a new state and ` +
      `extension/src/catalogue.ts needs to learn what it means.`,
    );
  }

  return { ok: true, tests };
}

/**
 * Turn catalogue entries into VideoRecords the ingest server will accept.
 *
 * Drops anything without a real publishedAt: ContentStudio's validateVideoRecord rejects
 * an unparseable date, and inventing one would corrupt the age-matched percentiles that
 * the whole verdict system rests on.
 */
export function toVideoRecords(videos: CatalogueVideo[], channelId: string): VideoRecord[] {
  const out: VideoRecord[] = [];
  for (const v of videos) {
    if (!v.publishedAt) continue;
    out.push({
      videoId: v.videoId,
      channelId,
      publishedAt: v.publishedAt,
      durationSec: v.durationSec,
      // From YouTube's contentType rather than duration: a length cut-off mislabels
      // genuinely short long-form videos as Shorts.
      format: v.isLive ? 'live' : v.isShort ? 'short' : 'long',
      titleHistory: [{ title: v.title, from: v.publishedAt, to: null, origin: 'upload' }],
    });
  }
  return out;
}
