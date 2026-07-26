/**
 * On-page progress overlay.
 *
 * The scan drives a tab through many page loads, so the popup is usually closed and the
 * user is looking at Studio. This puts the controls where they're actually looking:
 * live progress, a Stop button, and a way to grab the partial CSV without waiting for
 * the run to finish.
 *
 * Re-injected automatically on every navigation (it's a content script), so it survives
 * the constant page changes the scan causes. It stays hidden until a run is active, so
 * it never sits on top of Studio during normal use.
 */

(() => {
  const HOST_ID = 'ab-exporter-overlay';
  if (document.getElementById(HOST_ID)) return;

  const host = document.createElement('div');
  host.id = HOST_ID;
  const root = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    .card {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
      width: 300px; font: 13px/1.45 Roboto, system-ui, -apple-system, sans-serif;
      color: #f1f1f1; background: #212121; border: 1px solid #383838;
      border-radius: 12px; box-shadow: 0 8px 28px rgba(0,0,0,.55); overflow: hidden;
      display: none;
    }
    .card.on { display: block; }
    .head {
      display: flex; align-items: center; gap: 8px; padding: 9px 12px;
      background: #282828; border-bottom: 1px solid #383838;
    }
    .head strong { flex: 1; font-size: 11px; letter-spacing: .05em; text-transform: uppercase; color: #ff6b35; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #ff6b35; animation: pulse 1.2s infinite; }
    @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .25 } }
    .body { padding: 11px 12px; }
    .msg { font-size: 12px; color: #ddd; margin-bottom: 7px; word-break: break-word; }
    .bar { height: 6px; background: #333; border-radius: 999px; overflow: hidden; }
    .bar > i { display: block; height: 100%; background: #ff6b35; width: 0; transition: width .3s; }
    .counts { font-size: 11px; color: #999; margin-top: 6px; }
    .actions { display: flex; gap: 6px; margin-top: 10px; }
    button {
      flex: 1; padding: 8px; border-radius: 8px; cursor: pointer; font-size: 12px;
      border: 1px solid #454545; background: #303030; color: #f1f1f1;
    }
    button.stop { background: #b3261e; border-color: #b3261e; color: #fff; font-weight: 600; }
    button:hover { border-color: #ff6b35; }
    button:disabled { opacity: .45; cursor: default; }
    .done { color: #7ddc7d; }
  `;

  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <div class="head"><span class="dot"></span><strong>A/B Exporter</strong></div>
    <div class="body">
      <div class="msg">Starting…</div>
      <div class="bar"><i></i></div>
      <div class="counts"></div>
      <div class="actions">
        <button class="stop">Stop</button>
        <button class="grab">Download CSV</button>
      </div>
    </div>
  `;

  root.append(style, card);
  document.documentElement.appendChild(host);

  const el = {
    card,
    msg: card.querySelector('.msg'),
    bar: card.querySelector('.bar > i'),
    counts: card.querySelector('.counts'),
    stop: card.querySelector('.stop'),
    grab: card.querySelector('.grab'),
    dot: card.querySelector('.dot'),
  };

  el.stop.addEventListener('click', () => {
    el.stop.disabled = true;
    el.msg.textContent = 'Stopping after this video…';
    chrome.runtime.sendMessage({ type: 'cancel' }).catch(() => {});
  });

  el.grab.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'download' }).catch(() => {});
  });

  function render(state) {
    if (!state) return;

    const active = state.running;
    const finished = ['done', 'cancelled', 'error'].includes(state.phase);

    // Show while running, and keep showing after a stop so the CSV is still grabbable.
    el.card.classList.toggle('on', active || (finished && state.rowCount > 0));
    el.dot.style.display = active ? '' : 'none';

    el.msg.textContent = state.error || state.message || '';
    el.msg.className = state.phase === 'done' ? 'msg done' : 'msg';

    el.bar.style.width = state.total ? `${Math.round((state.scanned / state.total) * 100)}%` : '0';
    el.counts.textContent = state.total
      ? `${state.scanned} / ${state.total} videos · ${state.rowCount} rows`
      : state.rowCount
        ? `${state.rowCount} rows`
        : '';

    el.stop.disabled = !active;
    el.stop.textContent = active ? 'Stop' : 'Stopped';
    el.grab.disabled = !state.rowCount;
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'progress') render(message.state);
  });

  // A navigation mid-run drops the previous overlay, so ask for current state on load.
  chrome.runtime.sendMessage({ type: 'get-state' }).then(render).catch(() => {});
})();
