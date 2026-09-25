/**
 * A RAW-FETCH Crucible client for P5's acceptance runs — NOT the app's client.
 *
 * electron/crucible/asr.ts takes its client by injection (`AsrCrucibleClient`, a structural
 * subset of the vendored SDK's `CrucibleClient`). P1 vendors the SDK and builds the registry in
 * parallel and is not merged yet, so the acceptance tools need something that speaks the same
 * eight calls over plain `fetch`. This is it, and it goes when P1 lands (docs/crucible/P5.md):
 * the tools then take P1's client instead, and the app never loads this file.
 *
 * It throws the SDK's error SHAPES, because asr.ts reads errors structurally: `name`
 * (`CrucibleUnreachable` for a dead socket or a stream that ended without a terminal event,
 * `CrucibleBusy` for 409 server_busy, `CrucibleRefused` for any other refusal) and, for a
 * refusal, `code`, `serverMessage` and `details`.
 *
 *   const { pairedVenue } = require('./crucible-raw-client');
 *   const venue = pairedVenue();            // ~/.crucible/pairing: the Mac's own server
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

function unreachable(url, message) {
  const err = new Error(`${url}: ${message}`);
  err.name = 'CrucibleUnreachable';
  return err;
}

async function refusal(response, url) {
  let body = null;
  const text = await response.text().catch(() => '');
  try { body = JSON.parse(text); } catch { /* not JSON: the text is the message */ }
  const error = body && typeof body === 'object' && body.error && typeof body.error === 'object' ? body.error : null;
  const code = error && typeof error.code === 'string' ? error.code : `http_${response.status}`;
  const message = error && typeof error.message === 'string' ? error.message : (text || response.statusText);
  const err = new Error(`${url} answered ${response.status} ${code}: ${message}`);
  err.name = code === 'server_busy' ? 'CrucibleBusy' : code === 'leased' ? 'CrucibleLeased' : response.status === 401 ? 'CrucibleAuthError' : 'CrucibleRefused';
  err.code = code;
  err.status = response.status;
  err.serverMessage = message;
  err.details = error && error.details !== undefined ? error.details : null;
  if (err.name === 'CrucibleBusy') {
    err.busyLine = message;
    err.jobId = err.details && typeof err.details.job_id === 'string' ? err.details.job_id : null;
  }
  if (err.name === 'CrucibleLeased') err.leasedLine = message;
  return err;
}

class RawCrucibleClient {
  constructor({ url, token }) {
    if (!url || !token) throw new Error('RawCrucibleClient needs { url, token }');
    this.url = url.replace(/\/+$/, '');
    this.token = token;
  }

  async #fetch(route, init = {}) {
    const url = `${this.url}${route}`;
    const headers = { Authorization: `Bearer ${this.token}`, 'X-Crucible-Api': '1', ...(init.headers || {}) };
    let response;
    try {
      response = await fetch(url, { ...init, headers });
    } catch (e) {
      throw unreachable(url, e && e.cause ? `${e.message} (${e.cause.code || e.cause.message})` : String(e && e.message));
    }
    if (!response.ok) throw await refusal(response, url);
    return response;
  }

  async #json(route, init) {
    return (await this.#fetch(route, init)).json();
  }

  async info() {
    const body = await this.#json('/v1/info', { method: 'GET' });
    return {
      server: { version: body.server && typeof body.server.version === 'string' ? body.server.version : null },
      host: { backend: body.host && typeof body.host.backend === 'string' ? body.host.backend : null },
      jobTypes: Array.isArray(body.job_types) ? body.job_types : [],
      capabilities: (Array.isArray(body.capabilities) ? body.capabilities : []).map((c) => ({
        jobType: c.job_type,
        models: Array.isArray(c.models) ? c.models : [],
      })),
    };
  }

  async upload(data, { filename }) {
    const form = new FormData();
    form.append('file', data, filename);
    const body = await this.#json('/v1/uploads', { method: 'POST', body: form });
    return { blobId: body.blob_id, bytes: body.bytes ?? null, sha256: body.sha256 ?? null };
  }

  async submit(request) {
    const inputs = {};
    for (const [name, input] of Object.entries(request.inputs)) inputs[name] = { blob_id: input.blobId };
    const payload = { type: request.type, params: request.params, inputs };
    if (request.model !== undefined) payload.model = request.model;
    if (request.clientRef !== undefined) payload.client_ref = request.clientRef;
    const body = await this.#json('/v1/jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    return body.job_id;
  }

  async job(jobId) {
    const body = await this.#json(`/v1/jobs/${encodeURIComponent(jobId)}`, { method: 'GET' });
    return { jobId: body.job_id, status: body.status, clientRef: typeof body.client_ref === 'string' ? body.client_ref : null };
  }

  async activity() {
    const body = await this.#json('/v1/activity', { method: 'GET' });
    const jobs = (list) => (Array.isArray(list) ? list : []).map((j) => ({ jobId: j.job_id, type: j.type }));
    const lanes = body.jobs || body;
    return { running: jobs(lanes.running), queued: jobs(lanes.queued) };
  }

  async *events(jobId, options = {}) {
    const headers = { Accept: 'text/event-stream' };
    if (options.lastEventId !== undefined) headers['Last-Event-ID'] = String(options.lastEventId);
    const url = `${this.url}/v1/jobs/${encodeURIComponent(jobId)}/events`;
    const response = await this.#fetch(`/v1/jobs/${encodeURIComponent(jobId)}/events`, { method: 'GET', headers });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let frame = { id: null, event: null, data: '' };
    try {
      for (;;) {
        let chunk;
        try {
          chunk = await reader.read();
        } catch (e) {
          throw unreachable(url, `the event stream broke: ${e && e.message}`);
        }
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).replace(/\r$/, '');
          buffer = buffer.slice(nl + 1);
          if (line === '') {
            if (frame.event !== null) {
              const data = frame.data === '' ? {} : JSON.parse(frame.data);
              const id = Number(frame.id);
              let event;
              if (frame.event === 'progress') {
                const { fraction, message, ...extra } = data;
                event = { id, event: 'progress', data: { fraction: fraction ?? null, message: message ?? null, extra } };
              } else {
                event = { id, event: frame.event, data };
              }
              yield event;
              if (['done', 'failed', 'cancelled'].includes(frame.event)) return;
            }
            frame = { id: null, event: null, data: '' };
          } else if (line.startsWith(':')) {
            // keepalive comment
          } else if (line.startsWith('id:')) frame.id = line.slice(3).trim();
          else if (line.startsWith('event:')) frame.event = line.slice(6).trim();
          else if (line.startsWith('data:')) frame.data += line.slice(5).trim();
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    throw unreachable(url, `the event stream for job ${jobId} ended without a terminal event`);
  }

  async artifact(jobId, name) {
    const response = await this.#fetch(`/v1/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(name)}`, { method: 'GET' });
    return new Uint8Array(await response.arrayBuffer());
  }

  async cancel(jobId) {
    const body = await this.#json(`/v1/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
    return { jobId: body.job_id, status: body.status };
  }
}

/**
 * This Mac's own server, from its pairing file (`crucible://<name>@<host>:<port>/#<token>`).
 * The venue's name is the machine part of the server name (`owens-mac-studio`), which is what
 * the sidecar records as `crucible:<name>:qwen3-asr-1.7b`.
 */
function pairedVenue(pairingPath = path.join(os.homedir(), '.crucible', 'pairing')) {
  const raw = fs.readFileSync(pairingPath, 'utf8').trim();
  const m = raw.match(/^crucible:\/\/([^@]*(?:%40[^@]*)?)@([^/]+)\/#(.+)$/);
  if (!m) throw new Error(`${pairingPath} is not a crucible:// pairing line`);
  const serverName = decodeURIComponent(m[1]);
  const name = serverName.includes('@') ? serverName.split('@').pop() : serverName;
  return { server: name, client: new RawCrucibleClient({ url: `http://${m[2]}`, token: m[3] }) };
}

module.exports = { RawCrucibleClient, pairedVenue };
