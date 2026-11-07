#!/usr/bin/env bash
# Writes a consistent copy of the scheduler's data to stdout as a .tar.gz, after checking it.
# ops/mac-watch.sh pulls this over ssh once a day. It holds YouTube tokens and the client secret.
set -euo pipefail

DATA=${SCHEDULER_DATA_DIR:-/home/owenmorgan/apps/visibility-scheduler-data}
WORK=$(mktemp -d "$DATA/snapshot.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1], { readOnly: true });
db.exec(\"VACUUM INTO '\" + process.argv[2] + \"'\");
const copy = new DatabaseSync(process.argv[2], { readOnly: true });
const check = copy.prepare('PRAGMA integrity_check').get().integrity_check;
if (check !== 'ok') throw new Error('integrity_check: ' + check);
" "$DATA/scheduler.sqlite" "$WORK/scheduler.sqlite" 2>/dev/null
cp "$DATA/config.json" "$WORK/config.json"
tar -C "$WORK" -czf - scheduler.sqlite config.json
