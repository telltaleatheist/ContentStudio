/**
 * A `DenoiseClient` (electron/crucible/denoise.ts) over raw `fetch`, for P7's
 * keeper and its live acceptance run. NOT the app's client: the transport and
 * the lanes are P3's, and in the app the SDK's own `CrucibleClient` fills this
 * seam (docs/crucible/P7.md). This one exists so the door is proven against an
 * implementation that shares no code with the SDK, and says in one short file
 * exactly what the real client has to do on the wire.
 *
 *   const { rawDenoiseClient, rawDenoiseSession } = require('./crucible-raw-denoise-client');
 *   const client = rawDenoiseClient({ url, token, clientName });
 *   const session = await rawDenoiseSession({ url, token, clientName, onQueue });   // {client, release}
 *
 * Every request carries the bearer token, `X-Crucible-Api: 1` and
 * `X-Crucible-Client` (what `/v1/activity` names as the holder), and a session's
 * client `X-Crucible-Session` (Crucible 1.0.76 queue sessions, LEDGER #255).
 * Answers are turned into the SDK's shapes (camelCase, a done frame's other keys
 * under `extra`), and a refusal is thrown as the SDK's own error class
 * (`CrucibleSessionClosed` for an ended session, which the door names).
 */
'use strict';
const {
  CrucibleBusy,
  CrucibleRefused,
  CrucibleSessionClosed,
  CrucibleSessionHeld,
  CrucibleServerError,
  CrucibleProtocolError,
  CrucibleUnreachable,
} = require('@crucible/client');

/** The server's `{error: {code, message, details}}` envelope, as the SDK's class for it. */
async function refusalOf(response, where) {
  const text = await response.text();
  let envelope;
  try {
    envelope = JSON.parse(text).error;
  } catch {
    return new CrucibleProtocolError(`${where}: HTTP ${response.status} is not a crucible error: ${text.slice(0, 200)}`);
  }
  const { code, message } = envelope;
  const details = envelope.details ?? null;
  const d = details ?? {};
  const opt = (v) => (v === undefined ? null : v);
  if (response.status >= 500) return new CrucibleServerError(response.status, code, message, details);
  if (code === 'server_busy') {
    return new CrucibleBusy(response.status, code, message, details, {
      holder: opt(d.holder), jobId: opt(d.job_id), jobType: opt(d.type), model: opt(d.model),
      jobStatus: opt(d.status), since: opt(d.since), progress: opt(d.progress), jobMessage: opt(d.message),
    });
  }
  if (code === 'session_closed') {
    return new CrucibleSessionClosed(response.status, message, details, {
      sessionId: opt(d.session_id ?? d.queue_session_id), reason: opt(d.reason),
    });
  }
  if (code === 'session_open') {
    return new CrucibleSessionHeld(response.status, code, message, details, {
      holder: opt(d.holder), sessionId: opt(d.session_id), act: opt(d.act), model: opt(d.model),
      sessionStatus: opt(d.status), since: opt(d.since),
    });
  }
  return new CrucibleRefused(response.status, code, message, details);
}

/** One SSE frame's data, in the SDK's `JobEvent` shape. */
function eventOf(id, event, data) {
  switch (event) {
    case 'warming':
      return { id, event, data: { message: data.message ?? null } };
    case 'progress': {
      const { fraction, message, ...extra } = data;
      return { id, event, data: { fraction: fraction ?? null, message: message ?? null, extra } };
    }
    case 'done': {
      const { artifacts, resident, ...extra } = data;
      return { id, event, data: { ...(artifacts === undefined ? {} : { artifacts }), ...(resident === undefined ? {} : { resident }), extra } };
    }
    case 'failed':
      return { id, event, data: { error: { code: data.error.code, message: data.error.message } } };
    default:
      return { id, event, data };
  }
}

function rawDenoiseClient({ url, token, clientName = 'contentstudio', session }) {
  const base = url.replace(/\/+$/, '');
  const headers = {
    Authorization: `Bearer ${token}`, 'X-Crucible-Api': '1', 'X-Crucible-Client': clientName,
    ...(session === undefined ? {} : { 'X-Crucible-Session': session }),
  };
  const call = async (path, init, where) => {
    let response;
    try {
      response = await fetch(`${base}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
    } catch (err) {
      throw new CrucibleUnreachable(base, `${where}: ${err.message}`, err);
    }
    if (!response.ok) throw await refusalOf(response, where);
    return response;
  };
  const json = async (path, init, where) => (await call(path, init, where)).json();

  return {
    async info() {
      const body = await json('/v1/info', { method: 'GET' }, 'info');
      return {
        server: { name: body.server.name, version: body.server.version ?? null, apiVersion: body.server.api_version },
        host: { platform: body.host?.platform ?? null, arch: body.host?.arch ?? null, backend: body.host?.backend ?? null, gpu: null },
        jobTypes: body.job_types,
        capabilities: body.capabilities.map((c) => ({
          jobType: c.job_type,
          models: c.models.map((m) => ({
            id: m.id, revision: m.revision ?? null, source: m.source ?? null,
            installed: m.installed === true, resident: m.resident === true, vramBytes: m.vram_bytes ?? null,
          })),
        })),
      };
    },
    async upload(data, { filename }) {
      const form = new FormData();
      form.append('file', data, filename);
      const body = await json('/v1/uploads', { method: 'POST', body: form }, 'upload');
      return { blobId: body.blob_id };
    },
    async submit(request) {
      const inputs = {};
      for (const [name, input] of Object.entries(request.inputs)) inputs[name] = { blob_id: input.blobId };
      const payload = { type: request.type, params: request.params, inputs };
      if (request.model !== undefined) payload.model = request.model;
      if (request.clientRef !== undefined) payload.client_ref = request.clientRef;
      const body = await json('/v1/jobs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      }, 'submit');
      return body.job_id;
    },
    async *events(jobId) {
      const response = await call(`/v1/jobs/${encodeURIComponent(jobId)}/events`, {
        method: 'GET', headers: { Accept: 'text/event-stream' },
      }, 'events');
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const piece of response.body) {
        buffer += decoder.decode(piece, { stream: true }).replace(/\r\n/g, '\n');
        let cut;
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          let id = 0;
          let event = 'message';
          const data = [];
          for (const line of frame.split('\n')) {
            if (line.startsWith('id:')) id = Number(line.slice(3).trim());
            else if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
          }
          if (data.length === 0) continue;
          const parsed = eventOf(id, event, JSON.parse(data.join('\n')));
          yield parsed;
          if (event === 'done' || event === 'failed' || event === 'cancelled') return;
        }
      }
      throw new CrucibleUnreachable(base, `the event stream for job ${jobId} ended without a terminal event`);
    },
    async artifact(jobId, name) {
      const response = await call(`/v1/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(name)}`, { method: 'GET' }, 'artifact');
      return new Uint8Array(await response.arrayBuffer());
    },
    async cancel(jobId) {
      return json(`/v1/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' }, 'cancel');
    },
  };
}

/**
 * A queue session over raw fetch (`POST /v1/queue/sessions`, act `denoise`, idle_s 900): its
 * state is read every second while it waits in the line (reading it is presence), `onQueue`
 * hears its place, and it resolves once open with a client that names it on every request.
 * `release` closes it (`DELETE /v1/queue/sessions/{id}`).
 */
async function rawDenoiseSession({ url, token, clientName = 'contentstudio', onQueue, signal, idleS = 900 }) {
  const base = url.replace(/\/+$/, '');
  const headers = { Authorization: `Bearer ${token}`, 'X-Crucible-Api': '1', 'X-Crucible-Client': clientName };
  const json = async (path, init, where) => {
    let response;
    try {
      response = await fetch(`${base}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
    } catch (err) {
      throw new CrucibleUnreachable(base, `${where}: ${err.message}`, err);
    }
    if (!response.ok) throw await refusalOf(response, where);
    return response.json();
  };
  let state = await json('/v1/queue/sessions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ act: 'denoise', idle_s: idleS }),
  }, 'session');
  const id = state.session_id;
  const close = () => json(`/v1/queue/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'session.close');
  while (state.status === 'queued') {
    if (signal?.aborted) {
      await close().catch(() => undefined);
      throw signal.reason ?? new Error('cancelled while waiting in the line');
    }
    if (typeof state.position === 'number') onQueue?.({ position: state.position, of: state.position });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    state = await json(`/v1/queue/sessions/${encodeURIComponent(id)}`, { method: 'GET' }, 'session.state');
  }
  if (state.status !== 'open') {
    throw new CrucibleSessionClosed(409, state.message ?? 'the session never opened', { session_id: id, reason: state.reason }, {
      sessionId: id, reason: state.reason ?? 'unknown',
    });
  }
  return {
    client: rawDenoiseClient({ url, token, clientName, session: id }),
    release: async () => { await close().catch(() => undefined); },
  };
}

module.exports = { rawDenoiseClient, rawDenoiseSession };
