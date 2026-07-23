# Studio Analytics Collector — Reverse-Engineered Contract

Verified live against studio.youtube.com on 2026-07-22 (channel Owen Morgan / Telltale,
UCgIi12EA6BQ8HKL8QUccsOQ, 393k subs, 500+ videos). This is the exact mechanism the
extension's `collectChannel()` must implement. Every claim below was executed and returned
real data, not inferred.

## The endpoint

`POST https://studio.youtube.com/youtubei/v1/yta_web/join?alt=json`

This is the single internal analytics endpoint Studio's "Advanced mode" analytics screens
call. It is a batched graph-query: request carries `{context, nodes:[{key, value:{query}}]}`,
response carries `{results:[{key, value:{resultTable}}]}`. One request can hold multiple
query nodes (Studio sends a timeline node + a table node together); we only need the table node.

## Auth — fully self-serve from the page context (NO OAuth, NO capture needed)

A content script running on studio.youtube.com at `document_start` has everything:

1. **SAPISIDHASH** — computed from the `SAPISID` cookie (readable via `document.cookie`):
   ```
   ts = floor(Date.now()/1000)
   hash = SHA1(`${ts} ${SAPISID} https://studio.youtube.com`)  // hex
   Authorization: `SAPISIDHASH ${ts}_${hash}`
   X-Origin: https://studio.youtube.com
   fetch(..., { credentials: 'include' })   // cookies ride along
   ```
2. **Context** — read straight from `window.ytcfg`, no request interception:
   - `ytcfg.get('INNERTUBE_CONTEXT').client.clientVersion`  → e.g. `"1.20260721.02.00"`
   - `ytcfg.get('CHANNEL_ID')`  → the active channel's UC… id
   - `ytcfg.get('INNERTUBE_CONTEXT_SERIALIZED_DELEGATION_CONTEXT')`  → **the load-bearing
     per-channel credential** (40-char opaque string). This is REQUIRED; a request without it
     403s. It is what scopes the query to a specific one of the user's channels.

   The minimal working context is exactly:
   ```json
   { "client": { "clientName": 62, "clientVersion": "<from ytcfg>" },
     "user":   { "serializedDelegationContext": "<from ytcfg>" } }
   ```
   (clientName 62 = YouTube Studio. A constructed `delegationContext` object does NOT work —
   only the pre-serialized string from ytcfg is accepted.)

### Multi-channel note
`ytcfg` reflects the channel whose Studio tab is loaded. To collect all three channels the
extension either (a) loads each channel's Studio URL (`/channel/<ID>/...`) in turn and reads
that page's ytcfg, or (b) enumerates via `POST /youtubei/v1/creator/get_creator_channels`
(fires naturally on load; capture its request with a document_start hook to learn the mask —
its response lists every channel with a per-channel `serializedDelegationContext`). Option (a)
is simpler and was the proven path. Manual channel-ID entry in the options page already exists
as the user-facing config.

## The query (table node) — proven working

```json
{
  "dimensions": [{ "type": "VIDEO" }],
  "metrics": [
    { "type": "VIDEO_THUMBNAIL_IMPRESSIONS" },
    { "type": "VIDEO_THUMBNAIL_IMPRESSIONS_VTR" },   // <-- impressions CTR, %  (THE gap metric)
    { "type": "EXTERNAL_VIEWS" },
    { "type": "EXTERNAL_WATCH_TIME" },               // hours
    { "type": "SUBSCRIBERS_NET_CHANGE" },
    { "type": "AVERAGE_WATCH_PERCENTAGE" }
  ],
  "restricts": [{ "dimension": { "type": "USER" }, "inValues": ["<CHANNEL_ID>"] }],
  "orders": [{ "metric": { "type": "EXTERNAL_VIEWS" }, "direction": "ANALYTICS_ORDER_DIRECTION_DESC" }],
  "timeRange": { "dateIdRange": { "inclusiveStart": 20080101, "exclusiveEnd": <YYYYMMDD tomorrow> } },
  "limit": { "pageSize": 500, "pageOffset": 0 },
  "currency": "USD",
  "returnDataInNewFormat": true,
  "limitedToBatchedData": false
}
```

- **Lifetime cumulative counters**: an all-time `timeRange` (start 2008-01-01) returns each
  video's lifetime totals — exactly matching the Snapshot contract. For windowed values, diff
  two snapshots (never trust a windowed query to be the cumulative value).
- **Pagination**: `pageSize` 500 returned all 500 of this channel's videos in one call. Page via
  `pageOffset` for channels with more. (Studio's own UI uses pageSize 50.)
- `includeTotal:true` on a metric was NOT reliably populated (`total` came back undefined) —
  do not depend on server totals; sum client-side if needed.

## Response shape — proven

```
results[] → find the one whose key contains "TABLE_QUERY" → .value.resultTable
  .dimensionColumns[0].strings.values   → string[] of videoIds   (row order)
  .metricColumns[]                      → one per requested metric, in request order-ish;
                                          MATCH BY .metric.type, do not assume index
    each column:  .counts.values[]       (integer metrics: impressions, views, subs)
                  .percentages.values[]  (rate metrics: *_VTR, AVERAGE_WATCH_PERCENTAGE)
                  .milliUsd / .doubles   (money / float metrics)
  Column arrays are parallel to dimensionColumns[0] by index → row i = (videoId[i], metric.values[i]).
```

Real rows pulled (lifetime):
```
Hm2INWMyv7A: views=1,399,480  imp=11,026,125  ctr=7.50%  avgViewed=54.21%
XK13ZJOOAc4: views=1,263,772  imp=26,925,814  ctr=3.19%  avgViewed=49.92%
3grkl0RjeEA: views=  884,872  imp=36,089,084  ctr=1.71%  avgViewed=42.33%
```
Note the inverse imp↔ctr relationship (a big browse push inflates impressions and depresses
CTR) — this is exactly why the schema scores CTR×retention within an age cohort, never raw CTR.

## Enrichment metrics — CONFIRMED LIVE 2026-07-22 (same endpoint, same auth)

### Traffic-source share + per-source CTR  →  schema `trafficShare` + `ctrBySource`
Dimension enum is **`TRAFFIC_SOURCE_TYPE`** (NOT the public API's `INSIGHT_TRAFFIC_SOURCE_TYPE`).
Query: dimensions `[{type:'TRAFFIC_SOURCE_TYPE'}]`, metrics EXTERNAL_VIEWS +
VIDEO_THUMBNAIL_IMPRESSIONS + VIDEO_THUMBNAIL_IMPRESSIONS_VTR, restrict USER==channelId.
The source labels come back in **`dimensionColumns[0].enumValues.values`** (NOT `.strings`).
13 enum values observed with real per-source CTR populated (impression-bearing surfaces only):
```
SUBSCRIBER, YT_SEARCH, YT_RELATED, PLAYLIST, UNKNOWN_MOBILE_OR_DIRECT, YT_CHANNEL,
YT_OTHER_PAGE, NOTIFICATION, EXT_URL, SHORTS, END_SCREEN, ANNOTATION, HASHTAGS
```
Sources without thumbnail impressions (NOTIFICATION, EXT_URL, direct, SHORTS…) report 0 impressions.
Suggested mapping → schema buckets {browse, suggested, search, external, notifications, other}:
- search ← YT_SEARCH
- suggested ← YT_RELATED, END_SCREEN, ANNOTATION
- browse ← SUBSCRIBER, YT_CHANNEL, PLAYLIST, SHORTS, HASHTAGS
- notifications ← NOTIFICATION
- external ← EXT_URL, UNKNOWN_MOBILE_OR_DIRECT
- other ← YT_OTHER_PAGE + any future/unmapped enum
(trafficShare = per-source views ÷ total views, fractions summing to ~1. ctrBySource takes the
VTR for the browse/search/suggested rows.)

### Search terms  →  schema `topSearchTerms`
Dimension **`TRAFFIC_SOURCE_DETAIL`** with TWO restricts: USER==channelId AND
**`TRAFFIC_SOURCE_TYPE`==`YT_SEARCH`**. metric EXTERNAL_VIEWS, order desc, pageSize ~15.
Values in `dimensionColumns[0].strings.values`, each prefixed `"YT_SEARCH."` — strip the prefix.
Confirmed live: returned real queries ("owen morgan", "caleb and sophia", "exjw",
"jehovah's witnesses", …) with view counts. This is the direct title/tag-mining fuel.

### Early retention at 30s/60s  →  schema `retention.at30s/at60s`  (EXTENSION-OPTIONAL)
NOT captured here. `ELAPSED_VIDEO_TIME_RATIO` is rejected; the retention curve is a distinct
per-video report on the engagement tab whose exact enum wasn't nailed. **Deliberately left to
the API collector instead:** retention IS in the public YouTube Analytics API
(`audienceWatchRatio` / `elapsedVideoTimeRatio`), which the API collector already implements.
So the extension does not need retention — it's the one Studio-list metric that's also public.
If a future maintainer wants it from Studio anyway, capture the engagement-tab retention card's
join request with a document_start hook (the inline card fires it on load; it was missed here
only due to post-load hook-injection timing, which a real content script avoids).

## Mapping to the Snapshot contract
- `impressions` ← VIDEO_THUMBNAIL_IMPRESSIONS.counts
- `impressionsCtr` ← VIDEO_THUMBNAIL_IMPRESSIONS_VTR.percentages
- `views` ← EXTERNAL_VIEWS.counts   `watchHours` ← EXTERNAL_WATCH_TIME
- `avgPctViewed` ← AVERAGE_WATCH_PERCENTAGE.percentages
- `subsGained` ← SUBSCRIBERS_NET_CHANGE.counts
- `source: 'studio-extension'`, `schemaVersion: 1`, `capturedAt` = now, counters lifetime.
- Any metric not returned for a row → `null`, NEVER 0.

## Failure discipline (per project rules — no fallbacks)
- Non-200, or `results[].value.resultTable` absent, or a required column missing → throw a
  distinct named error (auth vs. shape-change vs. rate-limit). The background records it
  per-channel and the popup surfaces it. Never emit a partial/guessed Snapshot.
- If `serializedDelegationContext` is missing from ytcfg → the tab isn't a signed-in Studio
  channel context; throw, don't proceed.
