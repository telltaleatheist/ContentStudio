#!/bin/bash
# Run by launchd on the Mac every 15 minutes (ops/com.owen.scheduler-watch.plist). Shows a
# notification when Triton or the scheduler cannot be seen, which Triton could not email about
# itself, and pulls one verified backup a day. Each problem notifies once, until it clears.
set -u

HOST=triton
REMOTE_DATA=/home/owenmorgan/apps/visibility-scheduler-data
REMOTE_APP=/home/owenmorgan/apps/visibility-scheduler
BACKUPS=/Volumes/Callisto/backups/contentstudio-scheduler-daily
KEEP=30
STATE="$HOME/Library/Application Support/scheduler-watch"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=20 "$HOST")

mkdir -p "$STATE"

problem() { # name, text
  [ -e "$STATE/$1" ] && return
  touch "$STATE/$1"
  echo "$(date) $1: $2" >&2
  osascript -e "display notification \"$2\" with title \"ContentStudio scheduler\" sound name \"Basso\""
}
cleared() { # name
  [ -e "$STATE/$1" ] && rm "$STATE/$1"
  return 0
}

fresh=$("${SSH[@]}" "find $REMOTE_DATA/heartbeat -mmin -5" 2>/dev/null)
code=$?
if [ "$code" -eq 255 ]; then
  problem triton-unreachable "Triton cannot be reached. Scheduled changes will not run while it is down."
  exit 0
fi
cleared triton-unreachable
if [ -n "$fresh" ]; then cleared scheduler-stopped; else problem scheduler-stopped "The scheduler on Triton has stopped. Scheduled changes will not run."; fi

target="$BACKUPS/$(date +%F).tar.gz"
[ -e "$target" ] && exit 0
mkdir -p -m 700 "$BACKUPS"
partial="$target.partial"
if "${SSH[@]}" "$REMOTE_APP/ops/snapshot.sh" > "$partial" 2>/dev/null \
  && tar -tzf "$partial" 2>/dev/null | grep -qx scheduler.sqlite \
  && chmod 600 "$partial" && mv "$partial" "$target"; then
  cleared backup-failed
  ls -1t "$BACKUPS"/*.tar.gz | tail -n +$((KEEP + 1)) | while read -r old; do rm "$old"; done
else
  rm -f "$partial"
  problem backup-failed "The scheduler's daily backup failed; it will try again."
fi
