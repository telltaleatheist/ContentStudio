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
- The settings page lives on owenmorgan.com and is hidden from bots.
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
  months).
- exim4 runs (can send mail). Triton, the Mac Studio, `blip` and `owens-pc` are on the
  Headscale tailnet (Triton hosts Headscale).

## Shape

```
 ContentStudio (Mac) ──┐  device key
 Extension (Studio) ───┼──────────────►  owenmorgan.com/scheduler/api  ──► YouTube Data API
 Settings page ────────┘  Google login        (Triton, pm2, :8430)          (per-channel token)
```

Triton is the **only** store of changes. ContentStudio and the extension each talk to it
directly, never through each other, so the extension works with ContentStudio closed and
both always show the same list.

### Code location

`server/visibility-scheduler/` in this repo (TypeScript, Hono, `node:sqlite`, which is built
into Node 24 — no database server). `deploy.sh` builds on the Mac, rsyncs to
`/home/owenmorgan/apps/visibility-scheduler/`, `npm ci --omit=dev`, `pm2 restart`. Data in
`/home/owenmorgan/apps/visibility-scheduler-data/` (mode 700), outside every web root.

### nginx

- `/home/owenmorgan/conf/web/owenmorgan.com/nginx.ssl.conf_scheduler`:
  `location ^~ /scheduler/ { proxy_pass http://127.0.0.1:8430/; … }`.
  **`^~` is required**: the vhost has a regex location for static extensions (css, js, png…)
  that would otherwise serve `/scheduler/app.js` from WordPress's public_html.
  Adds `X-Robots-Tag: noindex, nofollow` and `limit_req`.
- `/etc/nginx/conf.d/scheduler-ratelimit.conf`: the `limit_req_zone` (http context).
- The service binds 127.0.0.1 only. `nginx -t` before every reload.

## Who gets in

| Client | How |
|---|---|
| Settings page | Google Identity Services "Sign in with Google" → ID token → server verifies it (`google-auth-library` `verifyIdToken`: audience = the web client ID, `email_verified`, email in the allowlist) → session cookie (HttpOnly, Secure, SameSite=Strict, path `/scheduler`, 30 days, stored server-side). Before sign-in the page shows only the button. |
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
  `https://owenmorgan.com/scheduler/oauth/callback`, scope `youtube`, `access_type=offline`,
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

## Settings page (`owenmorgan.com/scheduler/`)

Sign in; connected channels (connect / reconnect); device keys (make, name, revoke); every
change as a list (pending first, by time; history below, failures marked), with the same
create / edit / cancel as the clients.

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

- `host_permissions` gains `https://owenmorgan.com/scheduler/*`; Options gains the device key.
- The Studio shelf gets a **Visibility** section for the open video: its current visibility,
  its pending changes, add (visibility + date/time in local time + note), edit, cancel.
- Calls go through the service worker (content scripts are bound by Studio's CORS), the same
  route the existing ContentStudio calls take.
- Works with ContentStudio closed. If no key is set, the section says so and links to
  Options.

## Phases

1. **Server** — jobs, loop, YouTube calls, Google sign-in, device keys, settings page, nginx
   include, deploy. Owen connects the three channels. Checks: pure tests for the job rules
   and the status-object merge. Live check (Owen's go-ahead first): a throwaway unlisted
   video, change to public then back to unlisted a few minutes apart; also a private video
   with a YouTube publishAt, to settle step 3.
2. **ContentStudio** — settings, panel, publish-flow option, calendar badge.
3. **Extension** — shelf section, options, 0.3.0.

One LEDGER entry per phase.

## Open questions for Owen

- Address: `owenmorgan.com/scheduler` (suggested; uses the site's certificate) or a
  subdomain.
- Failure notices: email from Triton (suggested), or a push service.
- Backups of the jobs file: does Triton have DigitalOcean backups on, or should the Mac pull
  a nightly copy into `/Volumes/Callisto/backups`?
- Known risk: whether YouTube gives a video made public from unlisted the same subscriber
  notifications and early push as a normal release is unknown. Only changes **to public**
  carry it.
