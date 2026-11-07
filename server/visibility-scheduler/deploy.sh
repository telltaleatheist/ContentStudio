#!/usr/bin/env bash
# Builds, tests and deploys the visibility scheduler to Triton, then (re)starts it under pm2.
# Run from anywhere: server/visibility-scheduler/deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

HOST=triton
APP=/home/owenmorgan/apps/visibility-scheduler
DATA=/home/owenmorgan/apps/visibility-scheduler-data

npm test

ssh "$HOST" "mkdir -p $APP/dist/src && mkdir -p -m 700 $DATA && chmod 700 $DATA"
rsync -a --delete dist/src/ "$HOST:$APP/dist/src/"
rsync -a package.json ecosystem.config.cjs "$HOST:$APP/"
ssh "$HOST" "mkdir -p $APP/ops"
rsync -a ops/snapshot.sh "$HOST:$APP/ops/"

# No config, no start: the service refuses to run without real Google credentials.
if ! ssh "$HOST" "test -f $DATA/config.json"; then
  echo "Deployed, NOT started: $DATA/config.json does not exist on $HOST yet (see README.md)." >&2
  exit 1
fi

ssh "$HOST" "cd $APP && (pm2 describe contentstudio-scheduler >/dev/null 2>&1 && pm2 reload ecosystem.config.cjs --update-env || pm2 start ecosystem.config.cjs) && pm2 save >/dev/null"
sleep 3
ssh "$HOST" "pm2 describe contentstudio-scheduler | grep -E 'status|restarts' ; pm2 logs contentstudio-scheduler --lines 5 --nostream"
