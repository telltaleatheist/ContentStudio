#!/bin/bash
# Run by launchd on the Mac every 5 minutes (ops/com.owen.scheduler-watch.plist). Everything the
# scheduler has to say reaches Owen here, as a notification: the alerts it recorded, and Triton or
# the scheduler having stopped. A stopped-type problem notifies once, until it clears.
set -u

HOST=triton
REMOTE_DATA=/home/owenmorgan/apps/visibility-scheduler-data
STATE="$HOME/Library/Application Support/scheduler-watch"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=20 "$HOST")

mkdir -p "$STATE"

notify() { # text, passed as an argument because video titles reach it
  echo "$(date) $1" >> "$STATE/alerts.log"
  osascript -e 'on run argv' \
    -e 'display notification (item 1 of argv) with title "ContentStudio scheduler" sound name "Basso"' \
    -e 'end run' "${1:0:230}" >/dev/null
}
problem() { # name, text
  [ -e "$STATE/$1" ] && return
  touch "$STATE/$1"
  notify "$2"
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

seen=$(cat "$STATE/alerts-seen" 2>/dev/null || echo 0)
if new=$("${SSH[@]}" "touch $REMOTE_DATA/alerts.log; tail -n +$((seen + 1)) $REMOTE_DATA/alerts.log" 2>/dev/null) && [ -n "$new" ]; then
  while IFS= read -r line; do
    notify "${line#* }"
    seen=$((seen + 1))
  done <<< "$new"
  echo "$seen" > "$STATE/alerts-seen"
fi
