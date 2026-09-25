#!/usr/bin/env node
/**
 * ONE FAKE CRUCIBLE FOR CONTENTSTUDIO'S KEEPERS (CRUCIBLE-MIGRATION-PLAN.md
 * section 17), and a standalone one for a running app:
 *
 *   node tools/fake-crucible.js [port]   serve one until Ctrl-C, printing its connect code
 *
 * WHERE IT CAME FROM. This is Briefcase's `backend/test/fake-crucible/fake-crucible.ts`
 * (itself a TypeScript port of BookForge's `tools/fake-crucible.js`), compiled to
 * plain CommonJS with tsc (target es2022, no esModuleInterop, comments kept) so
 * ContentStudio's keepers run it under plain Node, and then edited by hand in
 * the few places marked `ContentStudio:` below. Briefcase's copy is the newer
 * of the two fakes (1.0.25's nullable fields, device-code pairing, the decide
 * door, the 1.0.29 asr lineup), so it is the one ported rather than
 * BookForge's older JavaScript. Its long comment below is Briefcase's, kept,
 * because what it says the fake holds is still true of this file.
 *
 * WHAT A KEEPER PASSES `startFakeCrucible(options)` (the typed original's
 * `FakeCrucibleOptions`; every field optional):
 *   omit, name ('crucible@fake'), version, backend, platform, arch, token,
 *   role ('engine' | 'orchestrator'), engine ({url, name?, backend?} | null),
 *   pairing ('open' | 'approval'), pairingVersion, pairingExpiresIn,
 *   upstreams ({anthropic: {key}}), faults ({refuse, resetAfterBytes, connectDelay}),
 *   installedJobTypes (['echo']), catalog, disabledClasses, failModuleWith,
 *   models, resident, loadMs, upstreamModels, chatReplies, asrInstalled, asr,
 *   decideProbs, decideMaxOptions, decideSelected, contextCeilings,
 *   localModelChoices, and ContentStudio's own `legacyActs`, `port` and
 *   `setupUrls` (below).
 *
 * WHAT IT ANSWERS (the typed original's `FakeCrucible`): url, token, name,
 * requests, faults, leases, settingsPuts, pairings, tasks, catalog,
 * installedJobTypes, jobs, uploads; inject(named), decidePairing(id, allow),
 * expirePairings(), requestsTo(prefix, method?), resident(), setResident(),
 * expireLease(), openLease(), leaseAsOther(), chatBodies(), heldBlobs(),
 * forgetBlobs(), setAsr(), setDecideProbs(), decideBodies(), residentContext(),
 * setOmit(), close(). The named faults `inject()` takes: serverBusy, leased,
 * unauthorized, apiVersion2, stallMs, cardHeld, taskBusy, chatDelayMs and the
 * rest of `NamedFaults` in the original.
 *
 * ContentStudio adds, and nothing more yet (P2+ add what their seams need):
 *  - `legacyActs: true`, a server that predates 1.0.24: its `/v1/capability`
 *    lists no `generate` and no `decide` row, so the per-server act detection
 *    (plan section 6.4) is driven both ways;
 *  - the catalog rows ContentStudio's module names (`qwen3-asr-1.7b`,
 *    `qwen3.8-27b-4bit`), and `stockedForContentStudio()`;
 *  - `GET /v1/setup` (the addresses another machine dials; `setupUrls`, where
 *    `[]` plays a loopback bind), for "this machine's connect code";
 *  - `port`, and the standalone mode above, so the app itself can be pointed
 *    at a fake;
 *  - P7: a `denoise` job (`postDenoise` below) with the two separators'
 *    catalog rows, `options.denoise` / `setDenoise()` for its script, and
 *    `denoise` in the stocked job types.
 *
 * Not a keeper itself: `tools/check-crucible.js` runs the `test-crucible-*` files.
 */
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.INFORMATIONAL_FIELDS = void 0;
exports.defaultFakeTranscript = defaultFakeTranscript;
exports.informationalExcept = informationalExcept;
exports.defaultFakeCatalog = defaultFakeCatalog;
exports.stockedForContentStudio = stockedForContentStudio;
exports.promptTokensOf = promptTokensOf;
exports.startFakeCrucible = startFakeCrucible;
exports.startNotCrucible = startNotCrucible;
exports.unusedLoopbackUrl = unusedLoopbackUrl;
/**
 * A FAKE CRUCIBLE FOR JEST — a real `http.Server` on an ephemeral loopback
 * port, started per spec file, speaking the routes the SDK actually calls in
 * the shapes the SDK actually parses.
 *
 * A TypeScript port of BookForge's `tools/fake-crucible.js`, without its
 * Electron stub (Briefcase's Crucible code runs in NestJS and takes its paths
 * by injection). What was kept, because each one was a bug somewhere once:
 *
 *  - every route answers in the SERVER's spelling (snake_case, `key_hint`,
 *    the `{"error": {code, message, details}}` envelope), because the seam
 *    under test is the SDK reading exactly that;
 *  - auth is enforced: every route but ping and pairing needs the bearer token
 *    AND `X-Crucible-Api: 1`, and a wrong token is a 401 exactly as a real
 *    server answers it — so "bad token" can be told from "nothing there";
 *  - EVERY request is recorded (`fake.requests`) with its method, path,
 *    headers and parsed body, so a spec can assert what crossed and what did
 *    not;
 *  - one lease per server, refused `409 leased` for a second take;
 *  - a key is write-only: settings keeps it and answers with `key_hint`;
 *  - the fault layer: `refuse`, `resetAfterBytes` and `connectDelay` rules,
 *    each `{match: {method?, path?}, times?}`, plus `inject()` for the named
 *    faults the plan lists.
 *
 * P2 adds the operator side coordination reads and writes: `GET /v1/catalog`,
 * and `POST /v1/tasks {type: "module"}` with `GET /v1/tasks`, `/v1/tasks/{id}`
 * and the task SSE stream. A module is validated the way the server's
 * `validate_module` does it (an unknown key, such as the generated `backends`,
 * is `invalid_module`; a subject this backend's catalog does not list is
 * `unknown_subject`), and a finished module installs what it named, so the
 * next coordination read finds it stocked.
 *
 * P3 adds the LLM side: `GET /v1/models` from a configurable list with ONE
 * resident model, `load-model` jobs (`POST /v1/jobs`, `GET /v1/jobs/{id}`, the
 * job SSE stream with ids, `DELETE /v1/jobs/{id}`) that make a model resident
 * and take a lease on load when asked, leases that need a resident model, and
 * `POST /v1/openai/chat/completions`: residency enforced for local models
 * (`409 model_not_resident`), upstream prefixes forwarded only when that
 * upstream is configured (`409 upstream_unconfigured`), canned replies per
 * model, `X-Crucible-Sampling` on every answer, and a `chatDelayMs` fault a
 * cancel can land in. `chat_queue_full` + `Retry-After` is a `refuse` rule.
 *
 * P5 adds transcription: `POST /v1/uploads` (multipart, the `file` part, the
 * blob kept with its filename and sha256), `asr` jobs validated the way the
 * 1.0.29 server does it (the lineup: `qwen3-asr-1.7b`, `whisper-large-v3-turbo`,
 * `whisper-tiny`, one id each on every backend; exactly `language`,
 * `vad_filter`, `word_timestamps`; an installed model; `vad_filter: true`
 * refused for Qwen and for whisper on mlx-darwin; Qwen's language one of its
 * eleven, and its word timestamps needing `qwen3-aligner` installed; exactly
 * one input naming an uploaded blob), progress frames with `{stage,
 * processed_s, total_s, cues}` (decoding first, driving no fraction), `done
 * {artifacts: ['transcript.json']}` and the artifact itself. A running asr job
 * can be held mid-file until it is DELETEd (cooperative cancel). `/v1/info`
 * lists the three asr rows, and the aligner under `align` when that job type
 * is installed.
 *
 * P6 adds `POST /v1/decide` (PHASE22): the door's refusals in its order
 * (act, unknown keys, model, upstream, missing mode, too many options,
 * residency, the engine's option cap as `503 decide_not_served`), then one
 * reading per question from `decideProbs` (raw probabilities; an option left
 * out is outside the top-K), renormalised over the labels returned, with
 * `logprobs`, `label_mass` and — in report mode only — `missing_labels`.
 * Load-model takes `params.context` (refused `context_over_limit` above the
 * ceiling), `/v1/capability` carries `work`, `context_ceilings`, the
 * `generate` and `decide` classes and the `?class=&context_tokens=` sizing,
 * and an `ollama/` chat answers `X-Crucible-Context` on 1.0.24+.
 *
 * 1.0.25 ("any Crucible that answers works") makes the SDK read every
 * INFORMATIONAL field as null when a server leaves it out. `omit` (see
 * {@link INFORMATIONAL_FIELDS}) strips named fields from this fake's answers —
 * JSON bodies and SSE frames alike — so a spec can play an older or leaner
 * server and pin what Briefcase does with each absence.
 */
const http = require("http");
const crypto_1 = require("crypto");
/** Aligner items (no punctuation), one per word of `text`, spread over [start, end]. */
function alignedWords(start, end, text) {
    const items = text.trim().split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}']+/gu, '').replace(/'/g, ''));
    const step = (end - start) / items.length;
    return items.map((word, i) => ({ start: +(start + i * step).toFixed(3), end: +(start + (i + 1) * step).toFixed(3), word, probability: null }));
}
/**
 * A small transcript.json in absolute time, as a Qwen3-ASR job with word
 * timestamps writes it: pieces (a piece may hold several sentences), words
 * from the aligner with no punctuation.
 */
function defaultFakeTranscript(model = 'qwen3-asr-0.6b-mlx') {
    const piece = (start, end, text) => ({ start, end, text, words: alignedWords(start, end, text) });
    return {
        model,
        revision: '7278e1e70fe2b4f5f4b0d4fd9e8d3a4c2b1a0f9e',
        language: 'en',
        language_requested: 'en',
        duration_s: 3600,
        segments: [
            piece(0.0, 9.8, 'Welcome back to the show. Today we are talking about the news.'),
            piece(3605.5, 3610.25, 'Thanks for watching.'),
        ],
    };
}
/** The asr ids a 1.0.32 server lists (crucible/asr/*.toml); the `-mlx` ports on mlx-darwin only. */
const ASR_IDS = ['qwen3-asr-1.7b', 'qwen3-asr-0.6b', 'whisper-large-v3-turbo', 'whisper-tiny'];
const ASR_IDS_MLX_ONLY = ['qwen3-asr-1.7b-mlx', 'qwen3-asr-0.6b-mlx'];
const QWEN_LANGUAGES = new Set(['en', 'de', 'fr', 'es', 'it', 'pt', 'ru', 'ja', 'ko', 'zh', 'yue']);
/**
 * Every field `@crucible/client` 1.0.25 reads as INFORMATIONAL (null when
 * absent) on the routes Briefcase calls — what a leaner or older server may
 * leave out without the SDK refusing it. Load-bearing fields (ids, states,
 * decide answers, resident/loadable/modalities, capability enabled/selected,
 * chat content) are never here. Some are load-bearing to one of Briefcase's
 * paths ("informational to the read, load-bearing to YOUR path"): `host.backend`
 * / `backend_kind` (the module is filtered to them), chat
 * `usage.prompt_tokens` (countTokens) and a model's context (analysis sizing)
 * are refused by name there; decide `logprobs` is read from `probabilities`.
 * Keep any back with {@link informationalExcept}.
 */
exports.INFORMATIONAL_FIELDS = {
    'GET /v1/info': ['server.version', 'host.platform', 'host.arch', 'host.backend', 'host.gpu',
        'capabilities[].models[].revision', 'capabilities[].models[].source', 'capabilities[].models[].vram_bytes'],
    'GET /v1/activity': ['server.version', 'server.api_version', 'server.backend', 'server.uptime_s',
        'resident.since', 'resident.memory_bytes_estimate', 'chat', 'slots.accelerated.busy', 'slots.accelerated.of',
        'slots.accelerated.queue_depth', 'running[].progress', 'running[].created', 'queued[].progress', 'queued[].created',
        'lease.since', 'lease.expires_at'],
    'GET /v1/models': ['[].family', '[].params_b', '[].revision', '[].fingerprint', '[].backend_supported', '[].installed',
        '[].reason', '[].memory_bytes_estimate', '[].context_default', '[].max_model_len'],
    'GET /v1/capability': ['backend_kind', 'total_bytes', 'desktop_allowance_bytes', 'classes[].reason',
        'classes[].shortfall_bytes', 'classes[].work', 'classes[].context_ceilings'],
    'GET /v1/settings': ['local_models', 'local_model_choices', 'desktop_allowance_bytes', 'backend_kind'],
    'POST /v1/uploads': ['bytes', 'sha256'],
    'GET /v1/jobs/:id': ['progress', 'created'],
    'GET /v1/tasks/:id': ['request', 'created', 'started', 'finished'],
    'POST /v1/decide': ['model', 'engine', 'timing_ms', 'tokens', 'answers.*.confidence', 'answers.*.logprobs'],
    'POST /v1/openai/chat/completions': ['id', 'model', 'usage'],
    'job-event:queued': ['position'],
    'job-event:warming': ['message'],
    'job-event:progress': ['fraction', 'message'],
    'task-event:step': ['name', 'index', 'total'],
    'task-event:progress': ['bytes_total', 'file'],
    'task-event:skipped': ['reason'],
};
/** {@link INFORMATIONAL_FIELDS} less the paths in `keep` (route → paths still sent). */
function informationalExcept(keep) {
    const out = {};
    for (const [route, paths] of Object.entries(exports.INFORMATIONAL_FIELDS)) {
        const kept = new Set(keep[route] ?? []);
        out[route] = paths.filter((p) => !kept.has(p));
    }
    return out;
}
/** Delete one dotted path (see {@link FieldOmissions}) from a parsed document, in place. */
function omitPath(doc, segments) {
    if (segments.length === 0 || doc === null || typeof doc !== 'object')
        return;
    const [head, ...rest] = segments;
    if (head === '[]') {
        if (Array.isArray(doc))
            for (const item of doc)
                omitPath(item, rest);
        return;
    }
    if (head === '*') {
        for (const value of Object.values(doc))
            omitPath(value, rest);
        return;
    }
    const isArray = head.endsWith('[]');
    const key = isArray ? head.slice(0, -2) : head;
    const record = doc;
    if (!(key in record))
        return;
    if (rest.length === 0 && !isArray) {
        delete record[key];
        return;
    }
    const next = record[key];
    if (isArray) {
        if (Array.isArray(next))
            for (const item of next)
                omitPath(item, rest);
    }
    else {
        omitPath(next, rest);
    }
}
function omitAll(doc, paths) {
    if (paths === undefined || paths.length === 0)
        return doc;
    for (const p of paths)
        omitPath(doc, p.split('.'));
    return doc;
}
/** The {@link FieldOmissions} key for a request: its method and path, ids as `:id`. */
function routeKey(method, path) {
    const generic = path
        .replace(/^\/v1\/jobs\/[^/]+$/, '/v1/jobs/:id')
        .replace(/^\/v1\/tasks\/[^/]+$/, '/v1/tasks/:id');
    return `${method} ${generic}`;
}
/** The default catalog of a fresh mlx-darwin engine. */
function defaultFakeCatalog() {
    return [
        { kind: 'model', id: 'qwen3.5-9b', name: 'Qwen3.5 9B', jobType: 'llm', installed: false, expectedBytes: null },
        { kind: 'model', id: 'qwen3-asr-0.6b', name: 'Qwen3-ASR 0.6B', jobType: 'asr', installed: false, expectedBytes: null },
        { kind: 'model', id: 'qwen3-asr-0.6b-mlx', name: 'Qwen3-ASR 0.6B (MLX)', jobType: 'asr', installed: false, expectedBytes: null },
        { kind: 'model', id: 'whisper-large-v3-turbo', name: 'Whisper large-v3 turbo', jobType: 'asr', installed: false, expectedBytes: null },
        { kind: 'model', id: 'qwen3-aligner', name: 'Qwen3 forced aligner', jobType: 'align', installed: false, expectedBytes: null },
        // ContentStudio: the transcriber and the capable model its module names (LEDGER #203, plan 6.2).
        { kind: 'model', id: 'qwen3-asr-1.7b', name: 'Qwen3-ASR 1.7B', jobType: 'asr', installed: false, expectedBytes: null },
        { kind: 'model', id: 'qwen3.8-27b-4bit', name: 'Qwen3.8 27B 4-bit', jobType: 'llm', installed: false, expectedBytes: null },
        // ContentStudio P7: the two separators a 1.0.24+ server ships under `denoise` (LEDGER #200).
        { kind: 'denoise', id: 'denoise-roformer', name: 'Mel-Band Roformer Denoise', jobType: 'denoise', installed: false, expectedBytes: null },
        { kind: 'denoise', id: 'vocals-roformer', name: 'Mel-Band Roformer Vocals (Kimberley Jensen)', jobType: 'denoise', installed: false, expectedBytes: null },
    ];
}
/** ContentStudio: every job type and subject its module names, installed, as a stocked mlx-darwin engine has them. */
function stockedForContentStudio() {
    const named = new Set(['qwen3.5-9b', 'qwen3-asr-1.7b', 'qwen3-aligner', 'qwen3.8-27b-4bit', 'vocals-roformer']);
    return {
        // `denoise` is what `rvc`'s install turns on (P7): the module names rvc, the server lists denoise.
        installedJobTypes: ['echo', 'llm', 'asr', 'align', 'denoise'],
        catalog: defaultFakeCatalog().map((row) => ({ ...row, installed: named.has(row.id) })),
    };
}
const UPSTREAM_NAMES = ['anthropic', 'openai', 'ollama'];
const LLM_CLASSES = ['clean', 'translate', 'simplify', 'analysis'];
const PUBLIC_PATHS = new Set(['/v1/ping', '/v1/pairing/start', '/v1/pairing/poll']);
function send(res, status, body, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
}
/** Numeric version compare for the fake's own gates. */
function compareFakeVersions(a, b) {
    const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
    const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d !== 0)
            return d;
    }
    return 0;
}
/**
 * The fake's token count for a chat: 10 for the template, plus one per
 * whitespace-separated word of every message (a stand-in tokenizer a spec can
 * compute by hand).
 */
function promptTokensOf(body) {
    const messages = Array.isArray(body['messages']) ? body['messages'] : [];
    let words = 0;
    for (const m of messages) {
        const text = typeof m['content'] === 'string' ? m['content'] : '';
        words += text.split(/\s+/).filter(Boolean).length;
    }
    return 10 + words;
}
function refusal(res, status, code, message, details = null, headers = {}) {
    send(res, status, { error: { code, message, details } }, headers);
}
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (d) => chunks.push(d));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}
function faultMatches(rule, method, pathname) {
    const m = rule.match;
    if (m === undefined)
        return true;
    if (m.method !== undefined && m.method !== method)
        return false;
    if (m.path === undefined)
        return true;
    if (m.path instanceof RegExp)
        return m.path.test(pathname);
    return pathname.startsWith(m.path);
}
function takeFault(list, method, pathname) {
    if (!Array.isArray(list))
        return null;
    for (const rule of list) {
        if (rule.times !== undefined && rule.times <= 0)
            continue;
        if (!faultMatches(rule, method, pathname))
            continue;
        if (rule.times !== undefined)
            rule.times -= 1;
        return rule;
    }
    return null;
}
/** Wrap `res.write`/`res.end` so the socket dies after exactly `afterBytes` bytes reached it. */
function armReset(res, afterBytes) {
    if (afterBytes <= 0) {
        res.socket?.destroy();
        return;
    }
    let written = 0;
    let dead = false;
    const write = res.write.bind(res);
    const end = res.end.bind(res);
    const kill = () => {
        dead = true;
        res.socket?.destroy();
    };
    res.write = (chunk) => {
        if (dead)
            return false;
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        if (written + buf.length < afterBytes) {
            written += buf.length;
            return write(buf);
        }
        const room = Math.max(0, afterBytes - written);
        if (room > 0)
            write(buf.subarray(0, room));
        written = afterBytes;
        kill();
        return false;
    };
    res.end = (chunk) => {
        if (dead)
            return res;
        if (chunk !== undefined && typeof chunk !== 'function') {
            res.write(chunk);
            if (dead)
                return res;
        }
        return end();
    };
}
async function startFakeCrucible(options = {}) {
    const name = options.name ?? 'crucible@fake';
    const token = options.token ?? (0, crypto_1.randomBytes)(32).toString('base64url');
    const role = options.role ?? 'engine';
    const backend = options.backend ?? 'mlx-darwin';
    const startedAt = Date.now();
    const requests = [];
    const faults = options.faults ?? {};
    let named = {};
    const leases = { taken: [], released: [] };
    let openLease = null;
    let nextLease = 1;
    const settingsPuts = [];
    const upstreams = JSON.parse(JSON.stringify(options.upstreams ?? {}));
    const routes = {};
    const pairingRows = new Map();
    const pairings = [];
    const installedJobTypes = [...(options.installedJobTypes ?? ['echo'])];
    const catalog = (options.catalog ?? defaultFakeCatalog()).map((row) => ({ ...row }));
    const tasks = [];
    const taskListeners = new Map();
    let nextTask = 1;
    const disabledClasses = options.disabledClasses ?? {};
    let omit = options.omit ?? {};
    const models = (options.models ?? [{ id: 'qwen3.5-9b', paramsB: 9, installed: true }]).map((m) => ({ ...m }));
    let resident = options.resident ?? null;
    /** The context the resident model was loaded with (`params.context`); null: its default. */
    let residentCtx = null;
    let decideProbs = options.decideProbs;
    const jobs = [];
    const jobListeners = new Map();
    let nextJob = 1;
    const uploads = [];
    const blobs = new Map();
    const consumedBlobs = new Map();
    let asrScript = { ...(options.asr ?? {}) };
    const asrInstalled = () => new Set(options.asrInstalled
        ?? catalog.filter((row) => row.jobType === 'asr' && row.installed).map((row) => row.id));
    const asrRows = () => {
        const installed = asrInstalled();
        return [...ASR_IDS, ...(backend === 'mlx-darwin' ? ASR_IDS_MLX_ONLY : [])].map((id) => ({
            id, revision: 'f'.repeat(40), source: `hf:fake/${id}`, installed: installed.has(id), resident: false, vram_bytes: 1_000_000_000,
        }));
    };
    // ContentStudio P7: the denoise job's script, and its rows as `/v1/info` lists them.
    let denoiseScript = { ...(options.denoise ?? {}) };
    const denoiseRows = () => catalog.filter((row) => row.jobType === 'denoise').map((row) => ({
        id: row.id, revision: '9'.repeat(40), source: `hf:fake/${row.id}`, installed: row.installed === true, resident: resident === row.id, vram_bytes: 2_523_719_636,
    }));
    const alignerInstalled = () => catalog.some((row) => row.id === 'qwen3-aligner' && row.installed);
    const alignRows = () => [
        { id: 'qwen3-aligner', revision: 'a'.repeat(40), source: 'hf:fake/qwen3-aligner', installed: alignerInstalled(), resident: false, vram_bytes: 500_000_000 },
    ];
    const apiVersion = () => (named.apiVersion2 ? 2 : 1);
    const configured = (upstream) => {
        const u = upstreams[upstream];
        if (u === undefined)
            return false;
        return upstream === 'ollama' ? typeof u.url === 'string' && u.url !== '' : typeof u.key === 'string' && u.key !== '';
    };
    const infoDoc = () => ({
        server: { name, version: options.version ?? '1.0.24', api_version: apiVersion() },
        role,
        ...(role === 'engine'
            ? { managed_by: null }
            : {
                engine: options.engine === undefined || options.engine === null
                    ? null
                    : { name: options.engine.name ?? null, url: options.engine.url, backend: options.engine.backend ?? null, owner: 'host' },
            }),
        host: {
            platform: options.platform ?? 'darwin',
            arch: options.arch ?? 'arm64',
            backend: role === 'orchestrator' ? 'orchestrator' : backend,
            gpu: { vendor: 'apple', name: 'Fake M1 Ultra', vram_bytes: 68719476736 },
        },
        job_types: role === 'orchestrator' ? [] : [...installedJobTypes, 'load-model', 'unload-model'],
        capabilities: role === 'orchestrator' ? [] : installedJobTypes.map((jobType) => ({ job_type: jobType, models: jobType === 'asr' ? asrRows() : jobType === 'align' ? alignRows() : jobType === 'denoise' ? denoiseRows() : [] })),
    });
    const activityDoc = () => {
        const busy = named.serverBusy;
        // P4: this fake's own jobs still on the lane, as the sweep and the
        // preflight read them (a load in progress, a job nobody cancelled).
        const ownJob = (j) => ({
            job_id: j.jobId, type: j.type, model: j.model, status: j.status, position: j.status === 'queued' ? 0 : null,
            progress: 0, message: null, created: '2026-09-23T01:00:00Z', started: j.status === 'running' ? '2026-09-23T01:00:01Z' : null,
            client: j.client,
        });
        const ownRunning = jobs.filter((j) => j.status === 'running').map(ownJob);
        const ownQueued = jobs.filter((j) => j.status === 'queued').map(ownJob);
        const job = busy === undefined ? null : {
            job_id: 'job-held',
            type: busy.type,
            model: busy.model ?? null,
            status: 'running',
            position: null,
            progress: busy.progress,
            message: null,
            created: '2026-09-23T01:00:00Z',
            started: '2026-09-23T01:00:01Z',
            client: busy.client,
        };
        return {
            server: { name, version: options.version ?? '1.0.24', api_version: apiVersion(), backend, uptime_s: Math.round((Date.now() - startedAt) / 1000) },
            resident: resident === null ? null : {
                kind: 'llm', id: resident, since: '2026-09-23T01:00:00Z', memory_bytes_estimate: null,
                held_by: openLease === null ? null : {
                    fact: 'a lease', who: openLease.client ?? 'unknown',
                    details: { lease_id: openLease.leaseId, kind: 'llm', client: openLease.client, act: openLease.act, since: '2026-09-23T01:00:00+00:00', expires_at: '2026-09-23T01:02:00+00:00' },
                },
                unclaimed_since: openLease === null ? '2026-09-23T01:00:00Z' : null,
            },
            stopping: null,
            warming: null,
            claim: null,
            streaming: null,
            lease: openLease === null ? null : {
                lease_id: openLease.leaseId, kind: 'llm', client: openLease.client, act: openLease.act,
                since: '2026-09-23T01:00:00+00:00', expires_at: '2026-09-23T01:02:00+00:00',
            },
            chat: { in_flight: 0, max_in_flight: null, max_in_flight_basis: null, rows: [] },
            slots: {
                accelerated: {
                    busy: job === null && ownRunning.length === 0 ? 0 : 1, of: 1, queue_depth: ownQueued.length,
                    // ContentStudio (P3): a lease does NOT change accepts_work on a real server
                    // (crucible v1.0.34 api.py: "It does NOT change `accepts_work` below. A lease
                    // is not a reservation"), and the queue's leased-park waits on `lease`, not on
                    // this. The typed original counted the lease here; that was a fake-only fact.
                    accepts_work: job === null && ownRunning.length === 0 && (named.cardHeld === undefined || named.cardHeld.times === 0),
                },
            },
            running: [...(job === null ? [] : [job]), ...ownRunning],
            queued: ownQueued,
        };
    };
    const settingsDoc = () => {
        const routeDoc = {};
        for (const c of LLM_CLASSES) {
            const value = routes[c];
            routeDoc[c] = value === undefined ? { route: 'local', model: 'qwen3.5-9b' } : { route: 'upstream', model: value };
        }
        const upstreamDoc = {};
        for (const up of UPSTREAM_NAMES) {
            const u = upstreams[up];
            upstreamDoc[up] = up === 'ollama'
                ? { configured: configured(up), url: u?.url ?? null }
                : { configured: configured(up), key_hint: configured(up) ? `…${String(u?.key).slice(-4)}` : null };
        }
        const localModels = {};
        const choices = {};
        const servable = models
            .filter((m) => m.backendSupported !== false && (m.modalities ?? ['text']).includes('text') && !/^dots/.test(m.id))
            .map((m) => m.id);
        for (const c of LLM_CLASSES) {
            localModels[c] = 'qwen3.5-9b';
            choices[c] = (options.localModelChoices?.[c] ?? servable).map((id) => {
                const m = models.find((row) => row.id === id);
                return { id, memory_bytes_estimate: 20950548480, fits: true, installed: m?.installed ?? true };
            });
        }
        return {
            routes: routeDoc,
            upstreams: upstreamDoc,
            local_models: localModels,
            local_model_choices: choices,
            desktop_allowance_bytes: 3221225472,
            backend_kind: backend,
        };
    };
    const work = (tokens, concurrency, from = 'default') => ({ tokens, concurrency, source: 'fake', from });
    const ceilings = (concurrency) => models
        .filter((m) => m.backendSupported !== false && (m.modalities ?? ['text']).includes('text') && m.weightsOf == null && !/^dots/.test(m.id))
        .map((m) => {
        const tokens = options.contextCeilings?.[m.id] ?? 131072;
        return { model: m.id, tokens, bound_by: 'served', served_context: tokens, memory_context: null, concurrency };
    });
    const capabilityDoc = (query = new URLSearchParams()) => {
        const sizedClass = query.get('class');
        const sizedTokens = query.get('context_tokens');
        const sizedConcurrency = query.get('concurrency');
        if ((sizedTokens !== null || sizedConcurrency !== null) && sizedClass === null) {
            return { status: 400, body: { error: { code: 'capability_class_required', message: 'a size needs ?class=', details: null } } };
        }
        if (sizedClass !== null && sizedClass !== 'generate' && (sizedTokens !== null || sizedConcurrency !== null)) {
            return { status: 400, body: { error: { code: 'capability_not_client_sized', message: `${sizedClass} is not client-sized`, details: null } } };
        }
        const genTokens = sizedTokens === null ? 8192 : Number(sizedTokens);
        const genConcurrency = sizedConcurrency === null ? 1 : Number(sizedConcurrency);
        const genCeilings = ceilings(genConcurrency);
        if (sizedTokens !== null && genCeilings.every((c) => c.tokens < genTokens)) {
            return { status: 400, body: { error: { code: 'context_over_limit', message: `${genTokens} tokens is over every ceiling`, details: null } } };
        }
        const rows = [
            ...LLM_CLASSES.map((c) => (disabledClasses[c] !== undefined ? {
                capability: c,
                enabled: false,
                selected: '',
                reason: disabledClasses[c],
                shortfall_bytes: 1,
                route: 'local',
                work: work(4096, 4),
                context_ceilings: null,
            } : {
                capability: c,
                enabled: true,
                selected: routes[c] ?? 'qwen3.5-9b',
                reason: routes[c] ? `routed to ${routes[c].split('/')[0]}` : 'qwen3.5-9b fits',
                shortfall_bytes: 0,
                route: routes[c] ? 'upstream' : 'local',
                work: work(4096, 4),
                context_ceilings: null,
            })),
            disabledClasses['generate'] !== undefined
                ? { capability: 'generate', enabled: false, selected: '', reason: disabledClasses['generate'], shortfall_bytes: 1, route: 'local', work: work(genTokens, genConcurrency, sizedTokens === null ? 'default' : 'request'), context_ceilings: genCeilings }
                : { capability: 'generate', enabled: true, selected: 'qwen3.5-9b', reason: 'qwen3.5-9b fits', shortfall_bytes: 0, route: 'local', work: work(genTokens, genConcurrency, sizedTokens === null ? 'default' : 'request'), context_ceilings: genCeilings },
            disabledClasses['decide'] !== undefined
                ? { capability: 'decide', enabled: false, selected: '', reason: disabledClasses['decide'], shortfall_bytes: 1, route: 'local', work: work(8192, 2), context_ceilings: null }
                : { capability: 'decide', enabled: true, selected: options.decideSelected ?? 'qwen3.5-9b', reason: 'fits', shortfall_bytes: 0, route: 'local', work: work(8192, 2), context_ceilings: null },
            { capability: 'asr', enabled: true, selected: 'qwen3-asr-1.7b', reason: 'installed', shortfall_bytes: 0, route: 'local', work: null, context_ceilings: null },
        ];
        if (options.models?.some((m) => /^dots/.test(m.id))) {
            rows.push({ capability: 'pages', enabled: true, selected: options.models.find((m) => /^dots/.test(m.id)).id, reason: 'fits', shortfall_bytes: 0, route: 'local', work: work(32768, 12), context_ceilings: null });
        }
        // ContentStudio: a server from before 1.0.24 has neither class (plan 6.4).
        if (options.legacyActs === true) {
            for (let i = rows.length - 1; i >= 0; i -= 1) {
                if (rows[i].capability === 'generate' || rows[i].capability === 'decide')
                    rows.splice(i, 1);
            }
        }
        return {
            status: 200,
            body: {
                backend_kind: backend,
                total_bytes: 68719476736,
                desktop_allowance_bytes: 3221225472,
                classes: rows,
            },
        };
    };
    // ── tasks ────────────────────────────────────────────────────────────
    const foreignTask = {
        taskId: 'task-foreign', type: 'module', request: { type: 'module', module: { name: 'bookforge' } },
        state: 'running', events: [{ id: 1, event: 'started', data: { type: 'module' } }], unmet: [],
    };
    let foreignFinishTimer = null;
    const listedTasks = () => (named.taskBusy !== undefined ? [foreignTask, ...tasks] : [...tasks]);
    const findTask = (id) => listedTasks().find((task) => task.taskId === id);
    const taskStatusDoc = (task) => ({
        task_id: task.taskId,
        type: task.type,
        request: task.request,
        state: task.state,
        error: task.state === 'failed'
            ? { code: String(task.events.at(-1)?.data['code'] ?? 'failed'), message: String(task.events.at(-1)?.data['message'] ?? '') }
            : null,
        created: '2026-09-23T01:00:00Z',
        started: '2026-09-23T01:00:00Z',
        finished: task.state === 'running' ? null : '2026-09-23T01:05:00Z',
        unmet: task.unmet,
    });
    const pushTaskEvent = (task, event, data) => {
        task.events.push({ id: task.events.length + 1, event, data });
        for (const wake of taskListeners.get(task.taskId) ?? [])
            wake();
    };
    function streamTask(req, res, id) {
        const task = findTask(id);
        if (task === undefined) {
            refusal(res, 404, 'unknown_task', `no task ${id}`);
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        let sent = Number(req.headers['last-event-id'] ?? 0) || 0;
        const flush = () => {
            while (sent < task.events.length) {
                const ev = task.events[sent];
                sent += 1;
                res.write(`id: ${ev.id}\nevent: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
                if (ev.event === 'done' || ev.event === 'failed' || ev.event === 'cancelled') {
                    taskListeners.get(task.taskId)?.delete(flush);
                    res.end();
                    return;
                }
            }
        };
        if (!taskListeners.has(task.taskId))
            taskListeners.set(task.taskId, new Set());
        taskListeners.get(task.taskId)?.add(flush);
        res.on('close', () => taskListeners.get(task.taskId)?.delete(flush));
        flush();
    }
    /** The server's `validate_module`, the parts a client can get wrong. */
    function validateModule(module) {
        if (module === null || typeof module !== 'object')
            return { code: 'invalid_module', message: 'module must be an object' };
        const m = module;
        const jobTypes = Array.isArray(m['job_types']) ? m['job_types'] : [];
        const subjects = Array.isArray(m['subjects']) ? m['subjects'] : [];
        for (const [index, entry] of jobTypes.entries()) {
            const extra = Object.keys(entry).filter((k) => k !== 'type' && k !== 'narrator_engine');
            if (extra.length > 0)
                return { code: 'invalid_module', message: `job_types[${index}]: unknown key(s) ${JSON.stringify(extra)}` };
        }
        for (const [index, entry] of subjects.entries()) {
            const extra = Object.keys(entry).filter((k) => k !== 'kind' && k !== 'id');
            if (extra.length > 0)
                return { code: 'invalid_module', message: `subjects[${index}]: unknown key(s) ${JSON.stringify(extra)}` };
            if (!catalog.some((row) => row.kind === entry['kind'] && row.id === entry['id'])) {
                return { code: 'unknown_subject', message: `subjects[${index}]: this server has no ${String(entry['kind'])} called '${String(entry['id'])}' for ${backend}` };
            }
        }
        return null;
    }
    function postTask(res, body) {
        const held = named.cardHeld;
        if (held !== undefined && (held.times === undefined || held.times > 0)) {
            if (held.times !== undefined)
                held.times -= 1;
            refusal(res, 409, 'server_busy', `the card is held by ${held.fact}`, { fact: held.fact, who: held.who });
            return;
        }
        if (named.taskBusy !== undefined && foreignTask.state === 'running') {
            refusal(res, 409, 'task_busy', `task ${foreignTask.taskId} is running`, { task_id: foreignTask.taskId, type: named.taskBusy.type });
            return;
        }
        if (body['type'] !== 'module') {
            refusal(res, 400, 'invalid_task', `this fake runs module tasks only, not ${String(body['type'])}`);
            return;
        }
        const invalid = validateModule(body['module']);
        if (invalid !== null) {
            refusal(res, 400, invalid.code, invalid.message);
            return;
        }
        const module = body['module'];
        const task = { taskId: `task-${nextTask++}`, type: 'module', request: body, state: 'running', events: [], unmet: [] };
        tasks.push(task);
        send(res, 201, { task_id: task.taskId });
        runModule(task, module);
    }
    /** Walk the module a few milliseconds apart, the way the server streams it. */
    function runModule(task, module) {
        const steps = [];
        const total = module.job_types.length + module.needs.length + module.subjects.length + 1;
        let index = 0;
        steps.push(() => pushTaskEvent(task, 'started', { type: 'module' }));
        for (const entry of module.job_types) {
            steps.push(() => {
                index += 1;
                pushTaskEvent(task, 'step', { name: `install ${entry.type}`, index, total });
                if (installedJobTypes.includes(entry.type)) {
                    pushTaskEvent(task, 'skipped', { reason: `${entry.type} is installed` });
                    return;
                }
                pushTaskEvent(task, 'progress', { line: `Installing the ${entry.type} environment` });
                installedJobTypes.push(entry.type);
            });
        }
        for (const need of module.needs) {
            steps.push(() => {
                index += 1;
                pushTaskEvent(task, 'step', { name: `resolve ${need.class}`, index, total });
                if (disabledClasses[need.class] !== undefined) {
                    task.unmet.push({ class: need.class, reason: disabledClasses[need.class] });
                    return;
                }
                const selected = routes[need.class] ?? 'qwen3.5-9b';
                const row = catalog.find((r) => r.id === selected);
                if (row !== undefined && !row.installed) {
                    pushTaskEvent(task, 'progress', { bytes_done: 512, bytes_total: 1024, file: `${selected}/model.safetensors` });
                    row.installed = true;
                }
            });
        }
        for (const subject of module.subjects) {
            steps.push(() => {
                index += 1;
                pushTaskEvent(task, 'step', { name: `pull ${subject.id}`, index, total });
                const row = catalog.find((r) => r.kind === subject.kind && r.id === subject.id);
                if (row === undefined || row.installed) {
                    pushTaskEvent(task, 'skipped', { reason: `${subject.id} is installed` });
                    return;
                }
                pushTaskEvent(task, 'progress', { bytes_done: 1024, bytes_total: 1024, file: `${subject.id}/weights.npz` });
                row.installed = true;
            });
        }
        steps.push(() => {
            if (options.failModuleWith !== undefined) {
                task.state = 'failed';
                pushTaskEvent(task, 'failed', { code: options.failModuleWith.code, message: options.failModuleWith.message });
                return;
            }
            index += 1;
            pushTaskEvent(task, 'step', { name: 'reload', index, total, job_types: [...installedJobTypes] });
            task.state = 'done';
            pushTaskEvent(task, 'done', {});
        });
        let at = 0;
        const tick = () => {
            if (task.state === 'cancelled')
                return;
            const next = steps[at];
            at += 1;
            if (next === undefined)
                return;
            next();
            setTimeout(tick, 5).unref?.();
        };
        setTimeout(tick, 5).unref?.();
    }
    // ── jobs ─────────────────────────────────────────────────────────────
    const jobStatusDoc = (job) => ({
        job_id: job.jobId,
        type: job.type,
        model: job.model,
        status: job.status,
        progress: job.status === 'done' ? 1 : 0,
        position: job.status === 'queued' ? 0 : null,
        error: job.status === 'failed'
            ? { code: String(job.events.at(-1)?.data['error']?.['code'] ?? 'failed'),
                message: String(job.events.at(-1)?.data['error']?.['message'] ?? '') }
            : null,
        artifacts: Object.keys(job.artifacts ?? {}),
        created: '2026-09-23T01:00:00Z',
        started: job.status === 'queued' ? null : '2026-09-23T01:00:01Z',
        finished: job.status === 'done' || job.status === 'failed' || job.status === 'cancelled' ? '2026-09-23T01:00:02Z' : null,
        lease_id: job.leaseId,
        client_ref: job.clientRef ?? null,
        interrupted_at: null,
        chunks_done: [],
        chunks_total: null,
        chunk_at: null,
    });
    const pushJobEvent = (job, event, data) => {
        job.events.push({ id: job.events.length + 1, event, data });
        for (const wake of jobListeners.get(job.jobId) ?? [])
            wake();
    };
    function streamJob(req, res, id) {
        const job = jobs.find((j) => j.jobId === id);
        if (job === undefined) {
            refusal(res, 404, 'unknown_job', `no job ${id}`);
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        let sent = Number(req.headers['last-event-id'] ?? 0) || 0;
        const flush = () => {
            while (sent < job.events.length) {
                const ev = job.events[sent];
                sent += 1;
                res.write(`id: ${ev.id}\nevent: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
                if (ev.event === 'done' || ev.event === 'failed' || ev.event === 'cancelled') {
                    jobListeners.get(job.jobId)?.delete(flush);
                    res.end();
                    return;
                }
            }
        };
        if (!jobListeners.has(job.jobId))
            jobListeners.set(job.jobId, new Set());
        jobListeners.get(job.jobId)?.add(flush);
        res.on('close', () => jobListeners.get(job.jobId)?.delete(flush));
        flush();
    }
    function busyDetails(busy) {
        return {
            holder: busy.client, job_id: 'job-held', type: busy.type, model: busy.model ?? null,
            status: 'running', since: '2026-09-23T01:00:01Z', progress: busy.progress, message: null,
        };
    }
    function postJob(req, res, body) {
        const type = String(body['type'] ?? '');
        if (named.serverBusy !== undefined) {
            const busy = named.serverBusy;
            refusal(res, 409, 'server_busy', `the lane is busy with ${busy.client}'s ${busy.type}`, busyDetails(busy));
            return;
        }
        if (type === 'asr') {
            postAsr(req, res, body);
            return;
        }
        if (type === 'denoise') {
            postDenoise(req, res, body);
            return;
        }
        if (type !== 'load-model' && type !== 'unload-model') {
            refusal(res, 400, 'unknown_job_type', `this fake runs load-model, unload-model and asr jobs, not ${type}`);
            return;
        }
        const model = typeof body['model'] === 'string' ? body['model'] : null;
        const info = models.find((m) => m.id === model);
        if (type === 'load-model') {
            if (info === undefined) {
                refusal(res, 404, 'unknown_model', `no model '${String(model)}'`);
                return;
            }
            if (info.installed === false) {
                refusal(res, 409, 'model_not_installed', `'${info.id}' is not installed`);
                return;
            }
            if (openLease !== null && openLease.model !== model) {
                refusal(res, 409, 'leased', `'${openLease.model}' is leased by '${openLease.client}' for '${openLease.act}'`, {
                    lease_id: openLease.leaseId, kind: 'llm', client: openLease.client, act: openLease.act,
                    since: '2026-09-23T01:00:00+00:00', expires_at: '2026-09-23T01:02:00+00:00',
                });
                return;
            }
            const wanted = (body['params'] ?? {})['context'];
            if (wanted !== undefined) {
                const ceiling = options.contextCeilings?.[info.id] ?? 131072;
                if (typeof wanted !== 'number' || !Number.isInteger(wanted) || wanted < 2048) {
                    refusal(res, 400, 'invalid_params', `context must be a whole number >= 2048, got ${JSON.stringify(wanted)}`);
                    return;
                }
                if (wanted > ceiling) {
                    refusal(res, 400, 'context_over_limit', `${info.id} serves at most ${ceiling} tokens here; ${wanted} was asked`, { ceiling, asked: wanted });
                    return;
                }
            }
        }
        const params = (body['params'] ?? {});
        const client = req.headers['x-crucible-client'] ?? null;
        const job = {
            jobId: `job-${nextJob++}`, type, model, params, status: 'queued', leaseId: null, events: [], client,
            clientRef: typeof body['client_ref'] === 'string' ? body['client_ref'] : null,
        };
        jobs.push(job);
        send(res, 202, { job_id: job.jobId });
        pushJobEvent(job, 'queued', { position: 0 });
        const finish = () => {
            if (job.status === 'cancelled')
                return;
            if (type === 'load-model' && named.failLoadWith !== undefined) {
                job.status = 'failed';
                pushJobEvent(job, 'failed', { error: { code: named.failLoadWith.code, message: named.failLoadWith.message } });
                return;
            }
            if (type === 'unload-model') {
                resident = null;
                residentCtx = null;
                job.status = 'done';
                pushJobEvent(job, 'done', { resident: null });
                return;
            }
            resident = model;
            residentCtx = typeof params['context'] === 'number' ? params['context'] : null;
            const lease = params['lease'];
            if (lease !== undefined) {
                const leaseId = `lease-${nextLease++}`;
                openLease = { leaseId, model: model, client, act: String(lease.act ?? '') };
                leases.taken.push({ leaseId, model: model, act: lease.act, ttlSeconds: lease.ttl_seconds });
                job.leaseId = leaseId;
            }
            job.status = 'done';
            pushJobEvent(job, 'done', { resident: model, ...(job.leaseId ? { lease_id: job.leaseId } : {}) });
        };
        setTimeout(() => {
            if (job.status === 'cancelled')
                return;
            job.status = 'running';
            pushJobEvent(job, 'warming', { message: `loading ${String(model)}` });
            if (named.holdLoads && type === 'load-model')
                return;
            setTimeout(finish, Math.max(1, (options.loadMs ?? 20) / 2)).unref?.();
        }, Math.max(1, (options.loadMs ?? 20) / 2)).unref?.();
    }
    // ── asr (P5) ─────────────────────────────────────────────────────────
    function postAsr(req, res, body) {
        if (!installedJobTypes.includes('asr')) {
            refusal(res, 400, 'job_type_disabled', 'asr is not installed on this server');
            return;
        }
        const model = typeof body['model'] === 'string' ? body['model'] : null;
        if (model === null) {
            refusal(res, 400, 'model_required', 'asr names its model; there is no default');
            return;
        }
        const row = asrRows().find((r) => r['id'] === model);
        if (row === undefined) {
            refusal(res, 400, 'unknown_model', `no asr model '${model}'`, { model, offered: asrRows().map((r) => r['id']) });
            return;
        }
        const qwen = String(model).startsWith('qwen3-asr-');
        if (row['installed'] !== true) {
            refusal(res, 409, 'model_not_installed', `'${model}' is not installed`);
            return;
        }
        const params = (body['params'] ?? {});
        const keys = Object.keys(params).filter((key) => key !== 'context').sort();
        if (keys.join(',') !== 'language,vad_filter,word_timestamps') {
            refusal(res, 400, 'invalid_params', `asr params are language, vad_filter, word_timestamps and an optional context; got ${Object.keys(params).sort().join(', ') || 'none'}`);
            return;
        }
        // 1.0.32+: Qwen's optional `context`, refused on whisper, blank, over 8192 characters or with the chat template's control tokens.
        if ('context' in params && params['context'] !== null) {
            const context = params['context'];
            if (!qwen) {
                refusal(res, 400, 'context_unsupported_by_engine', `${model} is whisper, which has no context`);
                return;
            }
            if (typeof context !== 'string' || context.trim() === '' || context.length > 8192 || /<\|[^|]*\|>|<asr_text>/.test(context)) {
                refusal(res, 400, 'invalid_params', 'context must be plain, non-blank text of at most 8192 characters');
                return;
            }
        }
        if (typeof params['language'] !== 'string' || typeof params['vad_filter'] !== 'boolean' || typeof params['word_timestamps'] !== 'boolean') {
            refusal(res, 400, 'invalid_params', 'asr params have the wrong types');
            return;
        }
        if (params['vad_filter'] === true && (qwen || backend !== 'cuda-linux')) {
            refusal(res, 400, 'vad_unsupported_by_engine', `${model} has no voice-activity filter here; send vad_filter false`);
            return;
        }
        if (qwen && !QWEN_LANGUAGES.has(String(params['language']))) {
            refusal(res, 400, 'language_unsupported_by_engine', `${model} takes one of ${[...QWEN_LANGUAGES].join(', ')}, not '${String(params['language'])}'`);
            return;
        }
        if (qwen && params['word_timestamps'] === true && !alignerInstalled()) {
            refusal(res, 409, 'model_not_installed', "word timestamps need the aligner 'qwen3-aligner': it is not installed", { model: 'qwen3-aligner' });
            return;
        }
        const inputs = (body['inputs'] ?? {});
        const names = Object.keys(inputs);
        if (names.length !== 1 || typeof inputs[names[0]]?.blob_id !== 'string') {
            refusal(res, 400, 'invalid_inputs', 'asr takes exactly one input naming an uploaded blob');
            return;
        }
        // As the real server: an upload is MOVED into the job that names it, so a
        // blob is consumed once (409 blob_consumed naming the job), and one this
        // server never had (or lost) is 400 unknown_blob.
        const blobId = inputs[names[0]].blob_id;
        const takenBy = consumedBlobs.get(blobId);
        if (takenBy !== undefined) {
            refusal(res, 409, 'blob_consumed', `blob '${blobId}' was consumed by job ${takenBy}. Upload them again for this job`, { blob_id: blobId, job_id: takenBy });
            return;
        }
        if (!blobs.has(blobId)) {
            refusal(res, 400, 'unknown_blob', `input '${names[0]}' names blob '${blobId}', which this server does not hold`);
            return;
        }
        const client = req.headers['x-crucible-client'] ?? null;
        const job = {
            jobId: `job-${nextJob++}`, type: 'asr', model, params, status: 'queued', leaseId: null, events: [], client,
            inputs: { [names[0]]: blobId },
            clientRef: typeof body['client_ref'] === 'string' ? body['client_ref'] : null,
        };
        blobs.delete(blobId);
        consumedBlobs.set(blobId, job.jobId);
        jobs.push(job);
        send(res, 202, { job_id: job.jobId });
        pushJobEvent(job, 'queued', { position: 0 });
        runAsr(job, { ...asrScript });
    }
    function runAsr(job, script) {
        const stepMs = script.stepMs ?? 5;
        const totalS = script.totalS ?? 3600;
        const decodeFrames = script.decodeFrames ?? 2;
        const transcribeFrames = script.transcribeFrames ?? 4;
        const steps = [];
        steps.push(() => {
            job.status = 'running';
            pushJobEvent(job, 'warming', { message: `loading ${String(job.model)} — mlx: weights mapped` });
        });
        for (let i = 1; i <= decodeFrames; i++) {
            steps.push(() => pushJobEvent(job, 'progress', {
                fraction: 0, message: 'decoding audio', stage: 'decoding', processed_s: Math.round((totalS * i) / decodeFrames), total_s: totalS, cues: 0,
            }));
        }
        if (script.failWith !== undefined) {
            steps.push(() => {
                job.status = 'failed';
                pushJobEvent(job, 'failed', { error: { ...script.failWith } });
                return true;
            });
        }
        else {
            for (let i = 1; i <= transcribeFrames; i++) {
                steps.push(() => {
                    pushJobEvent(job, 'progress', {
                        fraction: i / transcribeFrames, message: `transcribing window ${i}`, stage: 'transcribing',
                        processed_s: Math.round((totalS * i) / transcribeFrames), total_s: totalS, cues: i * 10,
                    });
                    // Held mid-file: nothing more until a DELETE wakes it (and it ends cancelled).
                    if (script.holdAfterFrames !== undefined && i >= script.holdAfterFrames)
                        return 'hold';
                });
            }
            steps.push(() => {
                const doc = script.transcript ?? defaultFakeTranscript(String(job.model));
                job.artifacts = { 'transcript.json': Buffer.from(typeof doc === 'string' ? doc : JSON.stringify(doc), 'utf-8') };
                job.status = 'done';
                pushJobEvent(job, 'done', { artifacts: ['transcript.json'] });
                return true;
            });
        }
        let at = 0;
        const tick = () => {
            if (job.status === 'cancelled')
                return;
            const step = steps[at];
            at += 1;
            if (step === undefined)
                return;
            const outcome = step();
            if (outcome === true)
                return;
            if (outcome === 'hold')
                return; // running, held mid-file, until a DELETE cancels it
            setTimeout(tick, stepMs).unref?.();
        };
        setTimeout(tick, stepMs).unref?.();
    }
    // ── denoise (ContentStudio P7) ───────────────────────────────────────
    //
    // Validated in the real server's order (crucible/jobs/denoise/__init__.py
    // `preflight`, v1.0.34): the type, the model, `params` (`extra="forbid"`:
    // anything but `{}` is `invalid_params`), the env (`409 env_missing`, rvc's),
    // the two model files (`409 denoise_model_missing` naming the pull command),
    // a lease on something else (`409 leased`), then exactly one input blob. The
    // job warms, reports `progress 0.0 separating`, refuses a non-44.1 kHz input
    // AFTER the upload as the worker does (`failed worker_failed`), and otherwise
    // publishes ONE stem, `(vocals)` in its name, the same length as the input
    // (here, the input's own bytes), with `primary_stem` and `load_seconds` on
    // `done`. The card then holds the separator, so a lease can name it.
    // `denoise` script: {stepMs, failWith, holdAfterWarming, envMissing}.
    function wavRateOf(bytes) {
        if (bytes.length < 12 || bytes.toString('ascii', 8, 12) !== 'WAVE')
            return null;
        let at = 12;
        while (at + 8 <= bytes.length) {
            const id = bytes.toString('ascii', at, at + 4);
            const length = bytes.readUInt32LE(at + 4);
            if (id === 'fmt ')
                return { rate: bytes.readUInt32LE(at + 12), channels: bytes.readUInt16LE(at + 10) };
            at += 8 + length + (length % 2);
        }
        return null;
    }
    function postDenoise(req, res, body) {
        if (!installedJobTypes.includes('denoise')) {
            refusal(res, 400, 'job_type_disabled', 'denoise is not enabled on this server');
            return;
        }
        const model = typeof body['model'] === 'string' ? body['model'] : null;
        if (model === null) {
            refusal(res, 400, 'model_required', 'denoise needs a model');
            return;
        }
        const row = denoiseRows().find((r) => r.id === model);
        if (row === undefined) {
            refusal(res, 400, 'unknown_model', `no denoise manifest for '${model}'; this build ships ${JSON.stringify(denoiseRows().map((r) => r.id))}`);
            return;
        }
        const params = body['params'] ?? {};
        if (typeof params !== 'object' || params === null || Object.keys(params).length > 0) {
            refusal(res, 400, 'invalid_params', `denoise takes no params — every separation knob is an engine default this server does not put on the wire (PHASE4-AUDIO.md section 4.2): ${Object.keys(params ?? {}).join(', ')}: Extra inputs are not permitted`);
            return;
        }
        if (denoiseScript.envMissing) {
            refusal(res, 409, 'env_missing', `cannot run '${model}': the rvc env is not installed (denoise shares the rvc env)`, { model, env: '/fake/.crucible/envs/rvc' });
            return;
        }
        if (!row.installed) {
            refusal(res, 409, 'denoise_model_missing', `audio-separator needs the model files for '${model}' and they are not there. \`crucible denoise pull ${model}\` places them`);
            return;
        }
        if (openLease !== null && openLease.model !== model) {
            refusal(res, 409, 'leased', `'${openLease.model}' is leased by '${openLease.client}' for '${openLease.act}'`, {
                lease_id: openLease.leaseId, kind: 'llm', client: openLease.client, act: openLease.act,
                since: '2026-09-23T01:00:00+00:00', expires_at: '2026-09-23T01:02:00+00:00',
            });
            return;
        }
        const inputs = (body['inputs'] ?? {});
        const names = Object.keys(inputs);
        if (names.length !== 1 || typeof inputs[names[0]]?.blob_id !== 'string') {
            refusal(res, 400, 'invalid_inputs', 'denoise takes exactly one audio file');
            return;
        }
        const blobId = inputs[names[0]].blob_id;
        const takenBy = consumedBlobs.get(blobId);
        if (takenBy !== undefined) {
            refusal(res, 409, 'blob_consumed', `blob '${blobId}' was consumed by job ${takenBy}. Upload them again for this job`, { blob_id: blobId, job_id: takenBy });
            return;
        }
        const file = blobs.get(blobId);
        if (file === undefined) {
            refusal(res, 400, 'unknown_blob', `input '${names[0]}' names blob '${blobId}', which this server does not hold`);
            return;
        }
        const client = req.headers['x-crucible-client'] ?? null;
        const job = {
            jobId: `job-${nextJob++}`, type: 'denoise', model, params, status: 'queued', leaseId: null, events: [], client,
            inputs: { [names[0]]: blobId },
            clientRef: typeof body['client_ref'] === 'string' ? body['client_ref'] : null,
        };
        blobs.delete(blobId);
        consumedBlobs.set(blobId, job.jobId);
        jobs.push(job);
        send(res, 202, { job_id: job.jobId });
        pushJobEvent(job, 'queued', { position: 0 });
        runDenoise(job, names[0], file.data, { ...denoiseScript });
    }
    function runDenoise(job, name, bytes, script) {
        const stepMs = script.stepMs ?? 5;
        const wav = wavRateOf(bytes);
        const base = name.replace(/\.[^.]+$/, '');
        const stem = `${base}_(vocals)_vocals_mel_band_roformer.wav`;
        const steps = [
            () => {
                job.status = 'running';
                pushJobEvent(job, 'warming', { message: `${name}: ${wav === null ? '?' : wav.channels}-channel audio at ${wav === null ? '?' : wav.rate} Hz, through Mel-Band Roformer Vocals (Kimberley Jensen)` });
                if (script.holdAfterWarming)
                    return 'hold';
            },
            () => pushJobEvent(job, 'progress', { fraction: 0, message: `separating ${name} through vocals_mel_band_roformer.ckpt`, stage: 'separating' }),
            () => {
                const failure = wav === null || wav.rate !== 44100
                    ? { code: 'worker_failed', message: `this input is ${wav === null ? 'unreadable' : `${wav.rate} Hz`} and vocals_mel_band_roformer.ckpt is 44100 Hz native. Nothing was resampled` }
                    : script.failWith;
                if (failure !== undefined) {
                    job.status = 'failed';
                    pushJobEvent(job, 'failed', { error: { ...failure } });
                    return true;
                }
                const loaded = resident === job.model ? 0.0 : 1.5;
                resident = job.model;
                residentCtx = null;
                job.artifacts = { [stem]: Buffer.from(bytes) };
                pushJobEvent(job, 'artifact', { name: stem });
                pushJobEvent(job, 'progress', { fraction: 1, message: `2 stem(s) from ${name}`, stage: 'separating' });
                job.status = 'done';
                pushJobEvent(job, 'done', {
                    artifacts: [stem], primary_stem: stem, stems: [stem, `${base}_(other)_vocals_mel_band_roformer.wav`],
                    sample_rate: 44100, frames: null, separate_seconds: 0.01, load_seconds: loaded, resident: job.model,
                });
                return true;
            },
        ];
        let at = 0;
        const tick = () => {
            if (job.status === 'cancelled')
                return;
            const step = steps[at];
            at += 1;
            if (step === undefined)
                return;
            const outcome = step();
            if (outcome === true || outcome === 'hold')
                return;
            setTimeout(tick, stepMs).unref?.();
        };
        setTimeout(tick, stepMs).unref?.();
    }
    /** Parse a multipart body's `file` part: its filename and its bytes. */
    function multipartFile(req, raw) {
        const type = String(req.headers['content-type'] ?? '');
        const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(type);
        if (!type.startsWith('multipart/form-data') || m === null)
            return null;
        const boundary = Buffer.from(`--${m[1] ?? m[2]}`);
        let at = raw.indexOf(boundary);
        while (at >= 0) {
            const headStart = at + boundary.length + 2;
            const headEnd = raw.indexOf('\r\n\r\n', headStart);
            if (headEnd < 0)
                return null;
            const head = raw.subarray(headStart, headEnd).toString('utf-8');
            const next = raw.indexOf(boundary, headEnd);
            if (next < 0)
                return null;
            if (/name="file"/.test(head)) {
                const filename = /filename="([^"]*)"/.exec(head)?.[1] ?? '';
                return { filename, data: raw.subarray(headEnd + 4, next - 2) };
            }
            at = next;
        }
        return null;
    }
    // ── chat ─────────────────────────────────────────────────────────────
    async function chat(req, res, body) {
        const model = String(body['model'] ?? '');
        const upstreamMatch = /^(anthropic|openai|ollama)\/(.+)$/.exec(model);
        if (upstreamMatch) {
            if (!configured(upstreamMatch[1])) {
                refusal(res, 409, 'upstream_unconfigured', `the ${upstreamMatch[1]} upstream is not configured on this server`, { upstream: upstreamMatch[1] });
                return;
            }
        }
        else if (resident !== model) {
            refusal(res, 409, 'model_not_resident', `'${model}' is not resident${resident ? `; '${resident}' is` : '; nothing is'}`, { resident });
            return;
        }
        if (named.chatDelayMs !== undefined) {
            const aborted = await new Promise((resolve) => {
                const t = setTimeout(() => resolve(false), named.chatDelayMs);
                res.on('close', () => { clearTimeout(t); resolve(true); });
            });
            if (aborted || res.destroyed)
                return;
        }
        const canned = options.chatReplies?.[model] ?? options.chatReplies?.['*'] ?? '{"ok":true}';
        const reply = typeof canned === 'function' ? canned(body) : canned;
        const shaped = typeof reply === 'string' ? { content: reply } : reply;
        const sources = {};
        for (const key of ['temperature', 'top_p', 'top_k', 'max_tokens', 'seed']) {
            sources[key] = key in body ? 'request' : upstreamMatch ? 'engine' : 'manifest';
        }
        if (upstreamMatch?.[1] === 'anthropic' && !('max_tokens' in body))
            sources['max_tokens'] = 'upstream default 4096';
        const kwargs = body['chat_template_kwargs'];
        sources['thinking'] = kwargs && 'enable_thinking' in kwargs ? (upstreamMatch ? 'dropped' : 'request') : upstreamMatch ? 'engine' : 'manifest';
        const message = { role: 'assistant', content: shaped.content ?? '' };
        if (shaped.reasoning !== undefined)
            message['reasoning'] = shaped.reasoning;
        // 1.0.24: an ollama/ chat carries `context_tokens` to Ollama as options.num_ctx
        // and says what it sent; absent, the tag's own context. Older servers know nothing of it.
        const extraHeaders = {};
        const newer = compareFakeVersions(options.version ?? '1.0.24', '1.0.24') >= 0;
        if (upstreamMatch?.[1] === 'ollama' && newer) {
            const ctx = body['context_tokens'];
            extraHeaders['X-Crucible-Context'] = JSON.stringify(typeof ctx === 'number'
                ? { num_ctx: ctx, source: 'request' }
                : { num_ctx: 40960, source: 'modelfile' });
        }
        send(res, 200, {
            id: `chatcmpl-${(0, crypto_1.randomBytes)(4).toString('hex')}`,
            object: 'chat.completion',
            model,
            choices: [{ index: 0, message, finish_reason: shaped.finishReason ?? 'stop' }],
            usage: { prompt_tokens: promptTokensOf(body), completion_tokens: 7, total_tokens: promptTokensOf(body) + 7 },
        }, { 'X-Crucible-Sampling': JSON.stringify(sources), ...extraHeaders });
    }
    /** Crucible's own act vocabulary, as the server derives it from its classes. */
    const ACTS = new Set([...LLM_CLASSES, 'generate', 'decide', 'pages', 'asr', 'tts', 'align', 'rvc', 'denoise', 'echo']);
    /** `POST /v1/decide` (PHASE22 §2.2/§2.4): the door's refusals, then one reading per question. */
    async function decide(req, res, body) {
        const act = req.headers['x-crucible-act'];
        if (typeof act === 'string' && !ACTS.has(act)) {
            refusal(res, 400, 'unknown_act', `'${act}' is not a capability class`, { known: [...ACTS] });
            return;
        }
        const known = new Set(['model', 'state', 'images', 'questions', 'missing']);
        const extra = Object.keys(body).filter((k) => !known.has(k));
        if (extra.length) {
            refusal(res, 400, 'invalid_request', `unknown field(s): ${extra.join(', ')}`, { fields: extra });
            return;
        }
        const model = typeof body['model'] === 'string' ? body['model'] : '';
        if (!model) {
            refusal(res, 400, 'invalid_request', 'model is required', { field: 'model' });
            return;
        }
        if (/^(anthropic|openai|ollama)\//.test(model)) {
            refusal(res, 400, 'decide_needs_logprobs', `${model} is an upstream; no upstream returns a distribution`);
            return;
        }
        const missing = body['missing'] ?? 'refuse';
        if (missing !== 'refuse' && missing !== 'report') {
            refusal(res, 400, 'invalid_request', `missing must be 'refuse' or 'report', got ${JSON.stringify(missing)}`, { field: 'missing' });
            return;
        }
        const questionsBody = body['questions'];
        if (questionsBody === null || typeof questionsBody !== 'object' || Array.isArray(questionsBody) || Object.keys(questionsBody).length === 0) {
            refusal(res, 400, 'invalid_request', 'questions must be a non-empty object', { field: 'questions' });
            return;
        }
        const questions = [];
        for (const [name, raw] of Object.entries(questionsBody)) {
            const type = raw['type'];
            const instructions = String(raw['instructions'] ?? '');
            if (type === 'choice') {
                const opts = raw['options'];
                const labels = Object.keys(opts ?? {});
                if (labels.length > 26) {
                    refusal(res, 400, 'too_many_options', `question '${name}' has ${labels.length} options; the letters are A..Z`, { question: name });
                    return;
                }
                if (labels.length < 2) {
                    refusal(res, 400, 'invalid_request', `question '${name}' needs 2-26 options`, { field: `questions.${name}.options` });
                    return;
                }
                questions.push({ name, type, instructions, labels, descriptions: Object.values(opts) });
            }
            else if (type === 'score') {
                questions.push({ name, type, instructions, labels: [...raw['levels']] });
            }
            else if (type === 'yesno') {
                questions.push({ name, type, instructions, labels: ['Yes', 'No'] });
            }
            else {
                refusal(res, 400, 'invalid_request', `question '${name}' has an unknown type`, { field: `questions.${name}.type` });
                return;
            }
        }
        if (resident !== model) {
            refusal(res, 409, 'model_not_resident', `'${model}' is not resident${resident ? `; '${resident}' is` : '; nothing is'}`, { resident });
            return;
        }
        const cap = options.decideMaxOptions ?? 26;
        const over = questions.find((q) => q.labels.length > cap);
        if (over !== undefined) {
            refusal(res, 503, 'decide_not_served', `the engine reads at most ${cap} options; question '${over.name}' has ${over.labels.length}`, { engine: 'mlx-lm', max_options: cap, question: over.name });
            return;
        }
        if (named.chatDelayMs !== undefined) {
            const aborted = await new Promise((resolve) => {
                const t = setTimeout(() => resolve(false), named.chatDelayMs);
                res.on('close', () => { clearTimeout(t); resolve(true); });
            });
            if (aborted || res.destroyed)
                return;
        }
        const report = missing === 'report';
        const answers = {};
        const perQuestion = {};
        const tokensPer = {};
        const round = (x) => Math.round(x * 1e6) / 1e6;
        for (const q of questions) {
            const raw = decideProbs ? decideProbs(q, body['state'])
                : Object.fromEntries(q.labels.map((l, i) => [l, i === 0 ? 0.6 : 0.35 / (q.labels.length - 1)]));
            const returned = q.labels.filter((l) => typeof raw[l] === 'number' && raw[l] > 0);
            const absent = q.labels.filter((l) => !returned.includes(l));
            if (returned.length === 0 || (!report && absent.length > 0)) {
                const letter = returned.length === 0 ? null : String.fromCharCode(65 + q.labels.indexOf(absent[0]));
                refusal(res, 502, 'label_not_in_probs', `question '${q.name}': label ${letter ?? '(all)'} is not among the top tokens`, { question: q.name, letter });
                return;
            }
            const mass = returned.reduce((sum, l) => sum + raw[l], 0);
            const probs = {};
            const logprobs = {};
            for (const l of q.labels) {
                const p = returned.includes(l) ? raw[l] / mass : null;
                probs[l] = p === null ? null : round(p);
                logprobs[l] = p === null || p === 0 ? null : round(Math.log(p));
            }
            let best = returned[0];
            for (const l of returned)
                if ((probs[l] ?? 0) > (probs[best] ?? 0))
                    best = l;
            const common = { label_mass: round(mass), ...(report ? { missing_labels: absent } : {}) };
            if (q.type === 'yesno') {
                const p = probs['Yes'] ?? 0;
                answers[q.name] = { type: 'yesno', p, logprob: p > 0 ? round(Math.log(p)) : null, ...common };
            }
            else if (q.type === 'choice') {
                answers[q.name] = { type: 'choice', choice: best, probabilities: probs, logprobs, confidence: probs[best], ...common };
            }
            else {
                const score = q.labels.reduce((sum, l, i) => sum + (i + 1) * (probs[l] ?? 0), 0);
                answers[q.name] = { type: 'score', score: round(score), level: best, probabilities: probs, logprobs, confidence: probs[best], ...common };
            }
            perQuestion[q.name] = { wall_ms: 12.5, prompt_tokens: 140, cached_tokens: null };
            tokensPer[q.name] = 140;
        }
        send(res, 200, {
            model: { id: model, revision: 'abc1234', fingerprint: `${model}@abc1234` },
            engine: backend === 'cuda-linux' ? 'vllm' : 'mlx-lm',
            answers,
            timing_ms: { total: 12.5 * questions.length, per_question: perQuestion, prime: questions.length > 1 ? { wall_ms: 30, prompt_tokens: 100, cached_tokens: null } : null },
            tokens: { per_question: tokensPer, images: Array.isArray(body['images']) ? body['images'].length : 0 },
        });
    }
    /**
     * Strip `omit`'s fields from this response: a 2xx JSON body as it is
     * ended, and each SSE frame as it is written. Refusals are never touched.
     */
    function applyOmissions(res, method, path) {
        const route = routeKey(method, path);
        const eventKind = /^\/v1\/jobs\/[^/]+\/events$/.test(path) ? 'job-event' : /^\/v1\/tasks\/[^/]+\/events$/.test(path) ? 'task-event' : null;
        const end = res.end.bind(res);
        const write = res.write.bind(res);
        res.end = ((chunk, ...rest) => {
            const paths = omit[route];
            // send() passes its headers to writeHead, so the body itself says whether it is JSON.
            if (paths !== undefined && res.statusCode >= 200 && res.statusCode < 300 && typeof chunk === 'string') {
                let doc;
                try {
                    doc = JSON.parse(chunk);
                }
                catch {
                    doc = undefined;
                }
                if (doc !== undefined)
                    chunk = JSON.stringify(omitAll(doc, paths));
            }
            return end(chunk, ...rest);
        });
        if (eventKind === null)
            return;
        res.write = ((chunk, ...rest) => {
            if (typeof chunk === 'string') {
                const frame = /^(id: [^\n]*\nevent: ([^\n]*)\ndata: )(.*)(\n\n)$/s.exec(chunk);
                const paths = frame === null ? undefined : omit[`${eventKind}:${frame[2]}`];
                if (frame !== null && paths !== undefined)
                    chunk = `${frame[1]}${JSON.stringify(omitAll(JSON.parse(frame[3]), paths))}${frame[4]}`;
            }
            return write(chunk, ...rest);
        });
    }
    const server = http.createServer((req, res) => {
        void handle(req, res).catch((err) => {
            if (!res.headersSent)
                refusal(res, 500, 'fake_crashed', String(err?.stack ?? err));
        });
    });
    async function handle(req, res) {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const method = req.method ?? 'GET';
        const path = url.pathname;
        const record = { method, path, headers: req.headers, at: Date.now() };
        requests.push(record);
        const raw = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
        if (raw.length > 0 && path === '/v1/uploads') {
            record.body = { multipartBytes: raw.length };
        }
        else if (raw.length > 0) {
            try {
                record.body = JSON.parse(raw.toString('utf-8'));
            }
            catch {
                record.body = raw.toString('utf-8');
            }
        }
        const body = (record.body ?? {});
        applyOmissions(res, method, path);
        // ── the fault layer, before any route ────────────────────────────────
        if (named.stallMs !== undefined) {
            record.fault = `stall ${named.stallMs} ms`;
            await new Promise((resolve) => {
                const t = setTimeout(resolve, named.stallMs);
                req.on('close', () => { clearTimeout(t); resolve(); });
                res.on('close', () => { clearTimeout(t); resolve(); });
            });
            res.socket?.destroy();
            return;
        }
        const reset = takeFault(faults.resetAfterBytes, method, path);
        if (reset) {
            record.fault = `reset after ${reset.afterBytes ?? 0} byte(s)`;
            armReset(res, reset.afterBytes ?? 0);
            if ((reset.afterBytes ?? 0) <= 0)
                return;
        }
        const delay = takeFault(faults.connectDelay, method, path);
        if (delay) {
            record.fault = `no answer for ${delay.ms} ms`;
            await new Promise((resolve) => {
                const t = setTimeout(resolve, delay.ms);
                res.on('close', () => { clearTimeout(t); resolve(); });
            });
            if (res.writableEnded || res.destroyed)
                return;
            if (delay.thenDestroy !== false) {
                res.socket?.destroy();
                return;
            }
        }
        const refuseRule = takeFault(faults.refuse, method, path);
        if (refuseRule) {
            record.fault = `${refuseRule.status} ${refuseRule.code}`;
            refusal(res, refuseRule.status, refuseRule.code, refuseRule.message ?? refuseRule.code, refuseRule.details ?? null, refuseRule.retryAfter === undefined ? {} : { 'Retry-After': String(refuseRule.retryAfter) });
            return;
        }
        // ── public routes ────────────────────────────────────────────────────
        if (path === '/v1/ping' && method === 'GET') {
            send(res, 200, {
                crucible: true,
                name,
                api_version: apiVersion(),
                ...(options.pairingVersion === null ? {} : { pairing_version: options.pairingVersion ?? 1 }),
            });
            return;
        }
        if (path === '/v1/pairing/start' && method === 'POST') {
            const id = `pair-${pairingRows.size + 1}`;
            const row = {
                id,
                deviceCode: (0, crypto_1.randomBytes)(16).toString('hex'),
                userCode: `${(0, crypto_1.randomBytes)(2).toString('hex').toUpperCase()}-${(0, crypto_1.randomBytes)(2).toString('hex').toUpperCase()}`,
                clientName: String(body['client_name'] ?? ''),
                status: (options.pairing === 'approval' ? 'pending' : 'approved'),
                expiresAt: Date.now() + (options.pairingExpiresIn ?? 600) * 1000,
            };
            pairingRows.set(id, row);
            pairings.push({ id, userCode: row.userCode, clientName: row.clientName, status: row.status });
            send(res, 200, {
                name,
                id,
                device_code: row.deviceCode,
                user_code: row.userCode,
                expires_in: options.pairingExpiresIn ?? 600,
                interval: 1,
                approval_required: options.pairing === 'approval',
            });
            return;
        }
        if (path === '/v1/pairing/poll' && method === 'POST') {
            const row = pairingRows.get(String(body['id']));
            if (row === undefined || row.deviceCode !== body['device_code']) {
                refusal(res, 404, 'unknown_pairing', 'no such pairing request');
                return;
            }
            if (row.status === 'pending' && Date.now() >= row.expiresAt)
                row.status = 'expired';
            const shown = pairings.find((p) => p.id === row.id);
            if (shown)
                shown.status = row.status;
            if (row.status === 'approved') {
                send(res, 200, { status: 'approved', name, token });
                return;
            }
            send(res, 200, { status: row.status });
            return;
        }
        // ── everything else is protected ─────────────────────────────────────
        if (!PUBLIC_PATHS.has(path)) {
            const auth = req.headers['authorization'];
            if (named.unauthorized || auth !== `Bearer ${token}`) {
                refusal(res, 401, 'unauthorized', 'missing or invalid bearer token');
                return;
            }
            if (req.headers['x-crucible-api'] !== String(apiVersion())) {
                refusal(res, 426, 'api_version_mismatch', `this server speaks API version ${apiVersion()}`, { server_api_version: apiVersion(), client_api_version: Number(req.headers['x-crucible-api']) || null });
                return;
            }
        }
        if (path === '/v1/info' && method === 'GET') {
            send(res, 200, infoDoc());
            return;
        }
        // ContentStudio: `GET /v1/setup` in the server's shape (crucible api.py `setup`):
        // the bind, the addresses another machine dials (`setupUrls`, default one LAN and
        // one tailnet address, as the Mac answers; [] is a loopback bind), and one
        // pairing line per address, in order.
        if (path === '/v1/setup' && method === 'GET') {
            const urls = options.setupUrls ?? ['http://192.168.1.20:7100', 'http://100.64.0.9:7100'];
            send(res, 200, {
                name,
                version: options.version ?? '1.0.24',
                backend,
                bind: urls.length === 0 ? 'http://127.0.0.1:7100' : 'http://0.0.0.0:7100',
                urls,
                token,
                pairing: urls.map((u) => `crucible://${encodeURIComponent(name)}@${new URL(u).host}/#${encodeURIComponent(token)}`),
                job_types: [...installedJobTypes],
                config_path: '/fake/.crucible/config.toml',
            });
            return;
        }
        if (path === '/v1/health' && method === 'GET') {
            send(res, 200, {
                status: named.serverBusy ? 'busy' : 'ok',
                queue_depth: 0,
                resident_models: [],
                resident_kind: null,
                stopping: null,
            });
            return;
        }
        if (path === '/v1/activity' && method === 'GET') {
            send(res, 200, activityDoc());
            return;
        }
        if (path === '/v1/capability' && method === 'GET') {
            const doc = capabilityDoc(url.searchParams);
            send(res, doc.status, doc.body);
            return;
        }
        if (path === '/v1/settings' && method === 'GET') {
            send(res, 200, settingsDoc());
            return;
        }
        if (path === '/v1/settings' && method === 'PUT') {
            settingsPuts.push(body);
            const ups = (body['upstreams'] ?? {});
            for (const up of Object.keys(ups)) {
                const value = ups[up];
                if (value === null)
                    delete upstreams[up];
                else
                    upstreams[up] = { ...(upstreams[up] ?? {}), ...value };
            }
            const rts = (body['routes'] ?? {});
            for (const cls of Object.keys(rts)) {
                if (!LLM_CLASSES.includes(cls)) {
                    refusal(res, 400, 'route_not_routable', `the "${cls}" class is not routable`, { field: `routes.${cls}` });
                    return;
                }
                const value = rts[cls];
                if (value === 'local') {
                    delete routes[cls];
                    continue;
                }
                const upstream = String(value).split('/')[0];
                if (!configured(upstream)) {
                    refusal(res, 400, 'route_upstream_unconfigured', `${upstream} has no key`, { field: `upstreams.${upstream}.key` });
                    return;
                }
                routes[cls] = value;
            }
            send(res, 200, settingsDoc());
            return;
        }
        const test = /^\/v1\/settings\/upstreams\/([^/]+)\/test$/.exec(path);
        if (test && method === 'POST') {
            const upstream = decodeURIComponent(test[1]);
            const probed = (typeof body['key'] === 'string' && body['key'] !== '') || (typeof body['url'] === 'string' && body['url'] !== '');
            if (!probed && !configured(upstream)) {
                refusal(res, 400, 'upstream_unconfigured', `${upstream} has nothing configured and the test carried nothing`);
                return;
            }
            send(res, 200, { models: options.upstreamModels?.[upstream] ?? [`${upstream}-model-a`, `${upstream}-model-b`] });
            return;
        }
        // ── the operator side: catalog and tasks (P2 coordination) ───────────
        if (path === '/v1/catalog' && method === 'GET') {
            send(res, 200, {
                rows: catalog.map((row) => ({
                    kind: row.kind, id: row.id, name: row.name ?? null, job_type: row.jobType, installed: row.installed,
                    installed_bytes: row.installed ? 1024 : null, expected_bytes: row.expectedBytes ?? null, floors: [],
                    license: null, source: `hf:fake/${row.id}`, resident: false,
                    shares_weights_of: row.sharesWeightsOf ?? null, missing_files: row.missingFiles ?? null,
                })),
            });
            return;
        }
        if (path === '/v1/tasks' && method === 'GET') {
            send(res, 200, { tasks: [...listedTasks()].reverse().map(taskStatusDoc) });
            return;
        }
        if (path === '/v1/tasks' && method === 'POST') {
            postTask(res, body);
            return;
        }
        const taskEvents = /^\/v1\/tasks\/([^/]+)\/events$/.exec(path);
        if (taskEvents && method === 'GET') {
            streamTask(req, res, decodeURIComponent(taskEvents[1]));
            return;
        }
        const taskDoc = /^\/v1\/tasks\/([^/]+)$/.exec(path);
        if (taskDoc && method === 'GET') {
            const task = findTask(decodeURIComponent(taskDoc[1]));
            if (task === undefined) {
                refusal(res, 404, 'unknown_task', `no task ${taskDoc[1]}`);
                return;
            }
            send(res, 200, taskStatusDoc(task));
            return;
        }
        if (taskDoc && method === 'DELETE') {
            const task = findTask(decodeURIComponent(taskDoc[1]));
            if (task === undefined || task.state !== 'running') {
                refusal(res, 409, 'task_not_running', `task ${taskDoc[1]} is not running`);
                return;
            }
            pushTaskEvent(task, 'cancelled', {});
            task.state = 'cancelled';
            send(res, 200, { task_id: task.taskId, status: 'cancelling' });
            return;
        }
        if (path === '/v1/models' && method === 'GET') {
            send(res, 200, models.map((m) => {
                const supported = m.backendSupported !== false;
                const installed = m.installed !== false;
                const reason = !supported ? `not served on ${backend}` : !installed ? 'weights are not installed' : m.unloadableReason ?? null;
                return {
                    id: m.id, family: m.family ?? m.id.split('-')[0], params_b: m.paramsB,
                    revision: supported ? 'abc1234' : null, fingerprint: supported ? `${m.id}@abc1234` : null,
                    modalities: m.modalities ?? ['text'], backend_supported: supported, installed, resident: resident === m.id,
                    loadable: reason === null, reason,
                    memory_bytes_estimate: supported ? 20950548480 : null,
                    context_default: m.contextDefault ?? 32768,
                    max_model_len: !supported ? null
                        : resident === m.id && residentCtx !== null ? residentCtx
                            : (m.maxModelLen === undefined ? 262144 : m.maxModelLen),
                    weights_of: m.weightsOf ?? null,
                };
            }));
            return;
        }
        // ── uploads (P5) ─────────────────────────────────────────────────────
        if (path === '/v1/uploads' && method === 'POST') {
            const file = multipartFile(req, raw);
            if (file === null) {
                refusal(res, 400, 'invalid_upload', 'the upload is multipart/form-data with a file part');
                return;
            }
            const blobId = `blob-${uploads.length + 1}`;
            const sha256 = (0, crypto_1.createHash)('sha256').update(file.data).digest('hex');
            blobs.set(blobId, file);
            uploads.push({ blobId, filename: file.filename, bytes: file.data.length, sha256 });
            record.body = { filename: file.filename, bytes: file.data.length };
            send(res, 201, { blob_id: blobId, bytes: file.data.length, sha256 });
            return;
        }
        const artifact = /^\/v1\/jobs\/([^/]+)\/artifacts\/([^/]+)$/.exec(path);
        if (artifact && method === 'GET') {
            const job = jobs.find((j) => j.jobId === decodeURIComponent(artifact[1]));
            const bytes = job?.artifacts?.[decodeURIComponent(artifact[2])];
            if (bytes === undefined) {
                refusal(res, 404, 'unknown_artifact', `no artifact ${artifact[2]} on job ${artifact[1]}`);
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
            res.end(bytes);
            return;
        }
        // ── jobs: load-model (P3), asr (P5) ──────────────────────────────────
        if (path === '/v1/jobs' && method === 'POST') {
            postJob(req, res, body);
            return;
        }
        const jobEvents = /^\/v1\/jobs\/([^/]+)\/events$/.exec(path);
        if (jobEvents && method === 'GET') {
            streamJob(req, res, decodeURIComponent(jobEvents[1]));
            return;
        }
        const jobDoc = /^\/v1\/jobs\/([^/]+)$/.exec(path);
        if (jobDoc && method === 'GET') {
            const job = jobs.find((j) => j.jobId === decodeURIComponent(jobDoc[1]));
            if (job === undefined) {
                refusal(res, 404, 'unknown_job', `no job ${jobDoc[1]}`);
                return;
            }
            send(res, 200, jobStatusDoc(job));
            return;
        }
        if (jobDoc && method === 'DELETE') {
            const job = jobs.find((j) => j.jobId === decodeURIComponent(jobDoc[1]));
            if (job === undefined) {
                refusal(res, 404, 'unknown_job', `no job ${jobDoc[1]}`);
                return;
            }
            if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
                refusal(res, 409, 'job_not_cancellable', `job ${job.jobId} is ${job.status}`);
                return;
            }
            const wasQueued = job.status === 'queued';
            job.status = 'cancelled';
            pushJobEvent(job, 'cancelled', { status: 'cancelled' });
            send(res, 200, { job_id: job.jobId, status: wasQueued ? 'cancelled' : 'cancelling' });
            return;
        }
        // ── chat (P3) ────────────────────────────────────────────────────────
        if (path === '/v1/openai/chat/completions' && method === 'POST') {
            await chat(req, res, body);
            return;
        }
        // ── decide (P6, PHASE22) ─────────────────────────────────────────────
        if (path === '/v1/decide' && method === 'POST') {
            await decide(req, res, body);
            return;
        }
        // ── leases: one per server ───────────────────────────────────────────
        const take = /^\/v1\/models\/([^/]+)\/lease$/.exec(path);
        if (take && method === 'POST') {
            const model = decodeURIComponent(take[1]);
            if (openLease !== null) {
                refusal(res, 409, 'leased', `'${openLease.model}' is leased by '${openLease.client}' for '${openLease.act}'`, {
                    lease_id: openLease.leaseId, kind: 'llm', client: openLease.client, act: openLease.act,
                    since: '2026-09-23T01:00:00+00:00', expires_at: '2026-09-23T01:02:00+00:00',
                });
                return;
            }
            if (resident !== model) {
                refusal(res, 409, 'not_resident', `'${model}' is not resident${resident ? `; '${resident}' is` : ''}`, { resident });
                return;
            }
            const leaseId = `lease-${nextLease++}`;
            const client = req.headers['x-crucible-client'] ?? null;
            openLease = { leaseId, model, client, act: String(body['act'] ?? '') };
            leases.taken.push({ leaseId, model, act: body['act'], ttlSeconds: body['ttl_seconds'] });
            send(res, 201, {
                lease_id: leaseId, subject: model, kind: 'llm', client, act: body['act'] ?? null,
                since: '2026-09-23T01:00:00+00:00', expires_at: '2026-09-23T01:02:00+00:00',
            });
            return;
        }
        const beat = /^\/v1\/leases\/([^/]+)\/heartbeat$/.exec(path);
        if (beat && method === 'POST') {
            const leaseId = decodeURIComponent(beat[1]);
            if (openLease === null || openLease.leaseId !== leaseId) {
                refusal(res, 404, 'unknown_lease', `lease ${leaseId} is no longer open`, { lease_id: leaseId });
                return;
            }
            send(res, 200, { expires_at: '2026-09-23T01:04:00+00:00' });
            return;
        }
        const give = /^\/v1\/leases\/([^/]+)$/.exec(path);
        if (give && method === 'DELETE') {
            const leaseId = decodeURIComponent(give[1]);
            leases.released.push(leaseId);
            if (openLease === null || openLease.leaseId !== leaseId) {
                refusal(res, 404, 'unknown_lease', `lease ${leaseId} is no longer open`, { lease_id: leaseId });
                return;
            }
            openLease = null;
            res.writeHead(204);
            res.end();
            return;
        }
        refusal(res, 404, 'not_found', `${method} ${path}`);
    }
    // ContentStudio: `port` pins the standalone fake to a known port; keepers take an ephemeral one.
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port ?? 0, '127.0.0.1', () => resolve());
    });
    const { port } = server.address();
    return {
        url: `http://127.0.0.1:${port}`,
        token,
        name,
        requests,
        faults,
        leases,
        settingsPuts,
        pairings,
        inject(next) {
            named = { ...next };
            if (foreignFinishTimer !== null)
                clearTimeout(foreignFinishTimer);
            foreignFinishTimer = null;
            if (next.taskBusy !== undefined) {
                foreignTask.state = 'running';
                foreignTask.events = [{ id: 1, event: 'started', data: { type: 'module' } }];
                if (next.taskBusy.finishAfterMs !== undefined) {
                    foreignFinishTimer = setTimeout(() => {
                        foreignTask.state = 'done';
                        pushTaskEvent(foreignTask, 'done', {});
                    }, next.taskBusy.finishAfterMs);
                    foreignFinishTimer.unref?.();
                }
            }
        },
        decidePairing(id, allow) {
            const row = pairingRows.get(id);
            if (row === undefined)
                throw new Error(`fake-crucible: no pairing request ${id}`);
            row.status = allow ? 'approved' : 'denied';
            const shown = pairings.find((p) => p.id === id);
            if (shown)
                shown.status = row.status;
        },
        expirePairings() {
            for (const row of pairingRows.values()) {
                if (row.status === 'pending')
                    row.status = 'expired';
            }
            for (const shown of pairings)
                if (shown.status === 'pending')
                    shown.status = 'expired';
        },
        tasks,
        catalog,
        installedJobTypes,
        jobs,
        resident: () => resident,
        setResident(model) {
            resident = model;
            residentCtx = null;
            if (openLease !== null && openLease.model !== model)
                openLease = null;
        },
        expireLease() {
            openLease = null;
        },
        openLease: () => (openLease === null ? null : { ...openLease }),
        leaseAsOther(model, client) {
            resident = model;
            openLease = { leaseId: `lease-${nextLease++}`, model, client, act: 'translate' };
        },
        chatBodies() {
            return requests.filter((r) => r.path === '/v1/openai/chat/completions' && r.method === 'POST').map((r) => r.body);
        },
        uploads,
        heldBlobs: () => [...blobs.keys()],
        forgetBlobs() {
            blobs.clear();
        },
        setAsr(script) {
            asrScript = { ...script };
        },
        /** ContentStudio P7: the next denoise jobs' script ({stepMs, failWith, holdAfterWarming, envMissing}). */
        setDenoise(script) {
            denoiseScript = { ...script };
        },
        setDecideProbs(fn) {
            decideProbs = fn;
        },
        decideBodies() {
            return requests.filter((r) => r.path === '/v1/decide' && r.method === 'POST').map((r) => r.body);
        },
        residentContext: () => residentCtx,
        setOmit: (next) => { omit = next; },
        requestsTo(prefix, m) {
            return requests.filter((r) => r.path.startsWith(prefix) && (m === undefined || r.method === m));
        },
        close() {
            if (foreignFinishTimer !== null)
                clearTimeout(foreignFinishTimer);
            return new Promise((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            });
        },
    };
}
/** Something that answers HTTP and is not a Crucible — a router's admin page, say. */
async function startNotCrucible() {
    const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body>Router admin</body></html>');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address();
    return {
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
    };
}
/** A loopback port with nothing listening on it. */
async function unusedLoopbackUrl() {
    const server = http.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address();
    await new Promise((resolve) => server.close(() => resolve()));
    return `http://127.0.0.1:${port}`;
}
/**
 * ContentStudio: the standalone fake, for pointing a running app at a server
 * that is not the Mac's real one (a Test button, the Servers pane, readiness
 * transitions) without touching the real one. It serves a stocked mlx-darwin
 * engine at 1.0.34 on 127.0.0.1:<port> (default 7199) and prints the connect
 * code to paste into Settings › Crucible Servers › Add server. Ctrl-C stops it,
 * which is also how "the server went away" is shown to the app.
 */
if (require.main === module) {
    const port = process.argv[2] === undefined ? 7199 : Number.parseInt(process.argv[2], 10);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        console.error(`fake-crucible: "${process.argv[2]}" is not a port`);
        process.exit(2);
    }
    startFakeCrucible({ port, name: 'crucible@fake', version: '1.0.34', ...stockedForContentStudio() })
        .then((fake) => {
            console.log(`fake-crucible: ${fake.name} listening at ${fake.url}`);
            console.log(`fake-crucible: connect code  crucible://${encodeURIComponent(fake.name)}@${new URL(fake.url).host}/#${encodeURIComponent(fake.token)}`);
            const stop = () => { void fake.close().then(() => process.exit(0)); };
            process.on('SIGINT', stop);
            process.on('SIGTERM', stop);
        })
        .catch((err) => {
            console.error(`fake-crucible: could not start on port ${port}: ${err.message}`);
            process.exit(1);
        });
}
