#!/usr/bin/env bash
# Run by cron on Triton every 5 minutes. Emails once when the scheduler stops writing its
# heartbeat (process gone, pm2 gave up, loop stuck) and once when it comes back. The other half,
# Triton itself being down, is ops/mac-watch.sh.
set -euo pipefail

DATA=${SCHEDULER_DATA_DIR:-/home/owenmorgan/apps/visibility-scheduler-data}
FROM=scheduler@owenmorgan.com
TO=$(node -p "JSON.parse(require('fs').readFileSync('$DATA/config.json','utf8')).allowedEmail")

mail_owen() {
  /usr/sbin/sendmail -i -f "$FROM" "$TO" <<MAIL
From: ContentStudio scheduler <$FROM>
To: $TO
Subject: $1

$2
MAIL
}

if [ -n "$(find "$DATA/heartbeat" -mmin -5 2>/dev/null)" ]; then
  if [ -e "$DATA/watchdog-alerted" ]; then
    rm "$DATA/watchdog-alerted"
    mail_owen "Scheduler is running again" "Heartbeat is back. Anything that came due while it was stopped runs late, on the next tick; check the scheduler page."
  fi
elif [ ! -e "$DATA/watchdog-alerted" ]; then
  touch "$DATA/watchdog-alerted"
  mail_owen "Scheduler has STOPPED" "No heartbeat from contentstudio-scheduler for over 5 minutes. Nothing will change visibility until it is back. On Triton: pm2 logs contentstudio-scheduler"
fi
