#!/bin/sh
# The re-roll gate's remaining live calibration (docs/crucible/P9.md "What is still unrun"), in
# order, ONE process at a time, each phase's readings copied into docs/crucible/p9-calibration/
# and committed as soon as it ends, so a stop loses nothing. Run from the repo root after
# `npm run build:electron`:   sh tools/reroll-calibrate-resume.sh <scratch-dir>
set -e
OUT="$1"
[ -n "$OUT" ] || { echo "give a scratch directory"; exit 2; }
CAL=docs/crucible/p9-calibration
TRAILER='Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HLAek3CSYAZK54pVkHiPkz'
keep() {
  mkdir -p "$CAL/$1"
  cp "$OUT/$1"/*.jsonl "$CAL/$1/" 2>/dev/null || true
  node tools/reroll-calibrate.js report --out "$OUT/$1" > "$CAL/$1/report.txt" 2>/dev/null || true
  git add "$CAL/$1"
  git commit -q -m "P9 calibration: $2

Readings from the Mac's 9B through transport.decide, one process, a lease per batch
(docs/crucible/P9.md). $3

$TRAILER" || true
  echo "=== PHASE DONE: $1"
}

mkdir -p "$OUT/remeasure"
node tools/reroll-calibrate.js rules --set chapters --only-labelled --rules creator,narrates --out "$OUT/remeasure"
node tools/reroll-calibrate.js rules --set descriptions --only-labelled --rules creator,narrates --out "$OUT/remeasure"
keep remeasure "the creator and narrates statements re-measured after LEDGER #211" "The labelled chapter titles and descriptions, the two reworded rules only."

mkdir -p "$OUT/rank"
cp "$CAL/rank/rank.jsonl" "$OUT/rank/rank.jsonl"
node tools/reroll-calibrate.js rank --out "$OUT/rank"
keep rank "title ranking over the decided A/B tests" "All 177 tests, the first 4 carried over from the stopped run."

mkdir -p "$OUT/corpus"
node tools/reroll-calibrate.js rules --set chapters --limit 60 --out "$OUT/corpus"
node tools/reroll-calibrate.js rules --set descriptions --limit 60 --out "$OUT/corpus"
node tools/reroll-calibrate.js rules --set titles --limit 40 --out "$OUT/corpus"
node tools/reroll-calibrate.js rules --set thumbnails --limit 40 --out "$OUT/corpus"
node tools/reroll-calibrate.js rules --set pinned --limit 40 --out "$OUT/corpus"
keep corpus "the corpus samples with the final statements" "Labelled groups first, then a fixed-seed shuffle: 60 chapter lists, 60 descriptions, 40 title lists, 40 thumbnail lists, 40 pinned-comment lists."
echo "=== ALL LIVE BATCHES DONE"
