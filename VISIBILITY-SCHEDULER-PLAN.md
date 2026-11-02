# Visibility scheduler: plan

Status: plan, not built. Written 2026-11-02 from Owen's asks the same day.

## What it is for

YouTube can only schedule private → public. Owen wants what TubeBuddy had: change a
video's visibility from whatever it is to anything else at a set time. Unlisted → public is
the sponsor case (they review the real video before release); public → unlisted and
→ private on a date are useful too ("regardless of what that was", Owen 2026-11-02).

## Rulings so far (Owen, 2026-11-02)

- It runs on **Triton** (the DigitalOcean droplet that serves owenmorgan.com), as its own
  service. **Not a WordPress plugin**: WordPress's cron only runs on page loads, and its
  attack surface should never sit next to tokens that can change every video.
- **No home-made login.** Everything is behind a Google login (his account only).
- **Its own subdomain, `contentstudio.owenmorgan.com`**; the scheduler is one section of
  it (`/scheduler`), and the root can link to it later. It is used programmatically by
  ContentStudio (and the extension); the only page is for one-time setup. Bots finding it
  would not matter, but it should still be kept from being scanned and indexed.
- **ContentStudio and the extension can both create, see and cancel changes.**
- A change is **any visibility → any visibility**.

## What Triton has (surveyed 2026-11-02, read-only)

- Debian 12, 2 vCPU, 3.8 GB RAM (~2.5 GB free), disk 79% (24 GB free), clock UTC and synced.
- Node 24 + pm2 (`pm2-owenmorgan` enabled at boot) already run `fireside-backend` /
  `fireside-stage` on 8420/8421. **Port 8430 is free.**
- HestiaCP owns nginx (nginx :443 → Apache :8080 → WordPress). Hestia regenerates the vhost,
  but keeps `conf/web/<domain>/nginx.ssl.conf_*` includes: Fireside's
  `nginx.ssl.conf_api_proxy` is the working precedent. Upstreams / http-level config live in
  `/etc/nginx/conf.d/` (`fireside-upstream.conf`).
- `owenmorgan.com/contentstudio/` holds the privacy and terms pages for ContentStudio's
  Google Cloud project, whose consent screen is in Production (refresh tokens have lasted
  months). They stay where they are: the consent screen points at them.
- Hestia runs DNS for owenmorgan.com (named on Triton, ns1/ns2.owenmorgan.com; no wildcard
  record), so adding a Hestia web domain adds its A record. A CAA record exists.
- Hestia custom proxy templates are already in use (`headscale.tpl/.stpl` sends the whole
  `headscale.owenmorgan.com` domain to a local port).
- fail2ban runs (7 jails: ssh, exim, dovecot, hestia, recidive, …).
- exim4 runs (can send mail). Triton, the Mac Studio, `blip` and `owens-pc` are on the
  Headscale tailnet (Triton hosts Headscale).

## Shape

```
 ContentStudio (Mac) ──┐  device key
 Extension (Studio) ───┼──────────►  contentstudio.owenmorgan.com/scheduler/api  ──► YouTube
 Setup page ───────────┘  Google login        (Triton, pm2, :8430)              Data API
```

Triton is the **only** store of changes. ContentStudio and the extension each talk to it
directly, never through each other, so the extension works with ContentStudio closed and
both always show the same list.

### Code location

`server/visibility-scheduler/` in this repo (TypeScript, Hono, `node:sqlite`, which is built
into Node 24 — no database server). `deploy.sh` builds on the Mac, rsyncs to
`/home/owenmorgan/apps/visibility-scheduler/`, `npm ci --omit=dev`, `pm2 restart`. Data in
`/home/owenmorgan/apps/visibility-scheduler-data/` (mode 700), outside every web root.

### The subdomain

- `v-add-web-domain owenmorgan contentstudio.owenmorgan.com` (adds the A record in
  Hestia's zone), then `v-add-letsencrypt-domain` and force-SSL.
- A Hestia proxy template `contentstudio.tpl/.stpl`, modelled on `headscale.tpl`, sends the
  **whole domain** to `127.0.0.1:8430`. No Apache, no WordPress, no static-file rules on
  this domain; Node answers everything. Selected with `v-change-web-domain-proxy-tpl`, so a
  Hestia rebuild regenerates it from the template rather than overwriting a hand edit.
- `/etc/nginx/conf.d/contentstudio-ratelimit.conf`: the `limit_req_zone` (http context);
  the template applies it.
- The service binds 127.0.0.1 only. `nginx -t` before every reload.
- Layout: `/scheduler/…` is the scheduler (setup page and `/scheduler/api`); `/` is reserved
  for a future ContentStudio landing page that can link to it.

### Keeping it from being scanned

Honest limit: issuing the Let's Encrypt certificate publishes the name in Certificate
Transparency logs, and scanners watch those, so the name will be probed within hours of
going live. It cannot be hidden; it can be made to give a scanner nothing and to ban one
that keeps trying.

- `/robots.txt` is `Disallow: /`; every response carries `X-Robots-Tag: noindex, nofollow,
  noarchive`.
- `/` and every unknown path: a bare `404` with no body worth reading, no server or
  framework name in the headers (`server_tokens off`, no `X-Powered-By`).
- The API without a valid key or session: a bare `401`, the same for a wrong key and a
  missing one.
- The setup page at `/scheduler/` shows only "Sign in with Google" until signed in.
- nginx `limit_req` on the whole domain (generous for real use, e.g. 10 r/s burst 20).
- A fail2ban jail on the domain's nginx log: 20 × 401/404 in 10 minutes bans the IP for a
  day (feeds `recidive` for repeat offenders). The tailnet range `100.64.0.0/10` is in
  `ignoreip`; Owen's home IP is not fixed, so the threshold is set high enough that a
  mistyped key cannot ban him.

## Who gets in

| Client | How |
|---|---|
| Setup page | Google Identity Services "Sign in with Google" → ID token → server verifies it (`google-auth-library` `verifyIdToken`: audience = the web client ID, `email_verified`, email in the allowlist) → session cookie (HttpOnly, Secure, SameSite=Strict, host-only on `contentstudio.owenmorgan.com`, path `/scheduler`, 30 days, stored server-side). Before sign-in the page shows only the button. |
| ContentStudio | A **device key** made on the settings page, pasted in once. `Authorization: Bearer <key>`. |
| Extension | Its own device key, same way. |

Device keys: 32 random bytes, shown once, stored as SHA-256. Each has a name, created and
last-used times, and can be revoked alone. Only a Google-signed-in session can make one.

Why not reuse ContentStudio's Google tokens: they are brand-channel tokens with no
`openid email` scope, so they cannot prove "this is Owen". (Corrected 2026-11-02.)

No CORS headers at all: the page is same-origin, ContentStudio calls from its main process,
and the extension calls from its service worker under a host permission.

## YouTube access

- A **Web** OAuth client in ContentStudio's existing Google Cloud project (Production), redirect
  `https://contentstudio.owenmorgan.com/scheduler/oauth/callback` (and the subdomain as an
  authorised JavaScript origin for the sign-in button), scope `youtube`, `access_type=offline`,
  `prompt=consent`. Owen connects each of the three channels once from the settings page;
  `channels.list(mine=true)` says which brand channel was picked. The page shows each
  channel's state, and a channel whose token Google refuses is shown as "reconnect".
- Refresh tokens live in the SQLite file (mode 600). Honest note: encrypting them with a key
  on the same box adds little, so the protection is file permissions and the box itself.
- Quota is shared with ContentStudio: ~51 units per change (one read, one update, one
  read-back) against 10,000 a day.

## A change ("job")

```
id, channelId, videoId, videoTitle (at creation, for display),
target: 'public' | 'unlisted' | 'private',
runAt: UTC ISO (shown in the viewer's local time everywhere),
note (e.g. "Sponsor: X review"), createdAt, createdBy (device name or "web"),
state: 'pending' | 'done' | 'failed' | 'cancelled',
result: { before, after, ranAt, lateByMs, clearedYouTubeSchedule, attempts[], error }
```

Rules at creation (refused with a reason, never adjusted):
- runAt at least one minute in the future;
- the video belongs to a connected channel (checked with `videos.list` at creation);
- no other pending change for the same video in the same minute;
- if the video has a YouTube-native `publishAt`, the response carries a warning that the
  change will cancel it (see below), and the clients show it before saving.

A video can carry any number of pending changes (unlisted now, public Tuesday, unlisted in
90 days). A pending change can be edited (target, runAt, note) or cancelled; cancelled and
finished changes stay in the history.

## Running a change

An in-process loop checks every 30 s for pending changes whose runAt has passed:

1. `videos.list(part=status)`, record `before`.
2. If `before` already equals the target: `done`, result "already <target>, nothing changed".
3. If the video has a YouTube `publishAt`: remove it in the same update and set
   `clearedYouTubeSchedule`. (Exactly how the API wants a schedule removed is checked
   against a test video in phase 1, not assumed.)
4. `videos.update(part=status)` with **the whole status object read in step 1**, only
   `privacyStatus` changed. Sending only `privacyStatus` lets YouTube reset `embeddable`,
   `license`, `publicStatsViewable`, `selfDeclaredMadeForKids` to defaults.
5. Read back; `after` must equal the target or the change is `failed`.

Errors: a network error or 5xx is retried (same action, no other path) at 1, 2, 5 and 10
minutes, every attempt logged; after the last one it is `failed`. A refused token or a 4xx is
`failed` at once, with Google's message. A failed change emails Owen (exim on Triton) with
the video, the target and the error; the clients show it in red.

Late changes: if the service was down at runAt, the change runs when it comes back and
records `lateByMs`; the clients say "ran N minutes late". Never skipped.

## API (all under `/scheduler/api`, session or device key)

```
GET    /channels                       connected channels and their state
GET    /jobs?videoId=&channelId=&state=&from=&to=
POST   /jobs                           { videoId, target, runAt, note } → job (+ warnings)
PATCH  /jobs/:id                       pending only: { target?, runAt?, note? }
DELETE /jobs/:id                       pending only: cancels (kept in history)
GET    /video/:videoId                 current visibility + YouTube publishAt (for the forms)
GET    /health                         loop alive, last tick, next due
```

## Setup page (`contentstudio.owenmorgan.com/scheduler/`)

Day-to-day use is ContentStudio and the extension. The page exists because two things need
a browser and Google once: connecting the channels and making device keys. It has: sign in;
connected channels (connect / reconnect); device keys (make, name, revoke); and a read-only
list of every change (pending first, by time; history below, failures marked), so there is
somewhere to look when the Mac is off. Creating and editing changes is the clients' job.

## ContentStudio

- Settings: the scheduler address and device key (stored in userData, mode 600, never
  logged), with a "test" button that calls `/health` and `/channels`.
- On a pushed video: a **Visibility changes** panel listing its pending and past changes, with
  add / edit / cancel. The publish flow gets "Unlisted now, then public at…", which uploads
  unlisted (no publishAt) and creates the change in one step; if creating the change fails,
  the panel says so plainly on the item (the upload is not undone).
- Calendar: a pending change shows as a small badge on its day ("→ public 10:00",
  "→ unlisted 9 Jan"); a failed one in red.
- Reads the list while the panel or calendar is open; no background polling.

## Extension (next minor version, 0.3.0)

- `host_permissions` gains `https://contentstudio.owenmorgan.com/*`; Options gains the device
  key.
- The Studio shelf gets a **Visibility** section for the open video: its current visibility,
  its pending changes, add (visibility + date/time in local time + note), edit, cancel.
- Calls go through the service worker (content scripts are bound by Studio's CORS), the same
  route the existing ContentStudio calls take.
- Works with ContentStudio closed. If no key is set, the section says so and links to
  Options.

## Phases

1. **Server** — subdomain, certificate, proxy template, fail2ban jail; jobs, loop, YouTube
   calls, Google sign-in, device keys, setup page; deploy. Owen connects the three channels. Checks: pure tests for the job rules
   and the status-object merge. Live check (Owen's go-ahead first): a throwaway unlisted
   video, change to public then back to unlisted a few minutes apart; also a private video
   with a YouTube publishAt, to settle step 3.
2. **ContentStudio** — settings, panel, publish-flow option, calendar badge.
3. **Extension** — shelf section, options, 0.3.0.

One LEDGER entry per phase.

## Open questions for Owen

- Failure notices: email from Triton (suggested), or a push service.
- Backups of the jobs file: does Triton have DigitalOcean backups on, or should the Mac pull
  a nightly copy into `/Volumes/Callisto/backups`?
- Known risk: whether YouTube gives a video made public from unlisted the same subscriber
  notifications and early push as a normal release is unknown. Only changes **to public**
  carry it.
