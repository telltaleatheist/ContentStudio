# Visibility scheduler

Changes a YouTube video's visibility (public / unlisted / private, any to any) at a set time.
Runs on Triton at `https://contentstudio.owenmorgan.com/scheduler/`. Design and rulings:
[VISIBILITY-SCHEDULER-PLAN.md](../../VISIBILITY-SCHEDULER-PLAN.md).

No runtime dependencies: Node 24's `node:http`, `node:sqlite` and `fetch`.

## Layout on Triton

| What | Where |
|---|---|
| Code (from `deploy.sh`) | `/home/owenmorgan/apps/visibility-scheduler/` |
| Data: `config.json`, `scheduler.sqlite` (tokens, keys, changes) | `/home/owenmorgan/apps/visibility-scheduler-data/` (mode 700; the service refuses to start otherwise) |
| Process | pm2 app `contentstudio-scheduler` (user owenmorgan), from `ecosystem.config.cjs`; logs `pm2 logs contentstudio-scheduler` |
| nginx | Hestia web domain `contentstudio.owenmorgan.com`, proxy template `contentstudio` (`ops/contentstudio.tpl/.stpl` → `/usr/local/hestia/data/templates/web/nginx/`); rate limit `ops/contentstudio-ratelimit.conf` → `/etc/nginx/conf.d/` |
| fail2ban | `ops/fail2ban-filter-contentstudio.conf` → `/etc/fail2ban/filter.d/contentstudio.conf`, `ops/fail2ban-jail-contentstudio.local` → `/etc/fail2ban/jail.d/contentstudio.local` |
| DNS | A record `contentstudio` in Hestia's `owenmorgan.com` zone |

The files under `ops/` are the source; edit them here and copy them over, never on the box only.

## config.json

```json
{
  "port": 8430,
  "baseUrl": "https://contentstudio.owenmorgan.com/scheduler",
  "googleClientId": "<Web client id>",
  "googleClientSecret": "<Web client secret>",
  "allowedEmail": "telltaleatheist@gmail.com",
  "displayTimeZone": "America/New_York"
}
```

The Google client is a **Web application** OAuth client in ContentStudio's Google Cloud project
(number 154105024304, consent screen in Production), with the one authorised redirect URI
`https://contentstudio.owenmorgan.com/scheduler/oauth/callback`. Scopes used: `openid email`
(sign-in) and `https://www.googleapis.com/auth/youtube` (channels).

## Deploy

`./deploy.sh` — tests, builds, rsyncs `dist/src`, `package.json`, `ecosystem.config.cjs`, then
starts or reloads the pm2 app and saves the pm2 list. It deploys but does not start when
`config.json` is missing.

## First run

1. Sign in at `/scheduler/` with the allowed Google account.
2. **Connect a channel** once per channel; pick the brand channel on Google's chooser.
3. **Make a key** for each client (ContentStudio, the extension) and paste it into that client.

## Tests

`npm test` (the pure rules in `src/rules.ts`). Node 20 can run them; the service itself needs
Node 24 for `node:sqlite`.
