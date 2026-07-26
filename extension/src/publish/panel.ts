// The on-page confirm panel.
//
// Deliberately NOT an auto-filler. It shows what ContentStudio proposes and waits for a
// click. That human review step is what keeps this "assisted data entry by the account
// owner" rather than automation, and it's also just safer — a bad filename match never
// silently writes the wrong titles onto the wrong video.
//
// Rendered inside a shadow root so Studio's stylesheet can't reach in and ours can't
// leak out.

import { FILLERS, type FillContext, type FillId, type Filler } from './fillers';
import type { PendingFillItem } from './publish-client';

const HOST_ID = 'contentstudio-publish-panel';

const CSS = `
:host { all: initial; }
.card {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
  width: 340px; max-height: 76vh; overflow: auto;
  font: 13px/1.45 Roboto, system-ui, -apple-system, sans-serif;
  color: #f1f1f1; background: #212121;
  border: 1px solid #383838; border-radius: 12px;
  box-shadow: 0 8px 28px rgba(0,0,0,.55);
}
.head {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 12px; border-bottom: 1px solid #383838;
  background: #282828; border-radius: 12px 12px 0 0;
}
.head strong { font-size: 12px; letter-spacing: .04em; text-transform: uppercase; color: #ff6b35; flex: 1; }
.x { cursor: pointer; border: 0; background: transparent; color: #aaa; font-size: 16px; line-height: 1; padding: 2px 4px; }
.x:hover { color: #fff; }
.body { padding: 12px; }
.match { font-weight: 600; word-break: break-all; }
.reason { color: #aaa; font-size: 12px; margin-top: 2px; }
.titles { margin: 10px 0 0; padding: 0; list-style: none; }
.titles li { display: flex; gap: 8px; padding: 4px 0; align-items: flex-start; }
.n {
  flex: 0 0 18px; height: 18px; border-radius: 50%; background: #ff6b35; color: #fff;
  font-size: 11px; font-weight: 700; display: flex; align-items: center; justify-content: center;
}
.t { flex: 1; font-size: 12px; }
.actions { display: flex; flex-direction: column; gap: 6px; margin-top: 12px; }
button.act {
  cursor: pointer; text-align: left; padding: 7px 10px; font-size: 12px;
  color: #f1f1f1; background: #303030; border: 1px solid #454545; border-radius: 8px;
}
button.act:hover:not(:disabled) { border-color: #ff6b35; }
button.act:disabled { opacity: .4; cursor: default; }
button.primary { background: #ff6b35; border-color: #ff6b35; color: #fff; font-weight: 600; text-align: center; }
.log { margin-top: 10px; border-top: 1px solid #383838; padding-top: 8px; }
.line { font-size: 12px; padding: 2px 0; display: flex; gap: 6px; }
.ok { color: #7ddc7d; }
.bad { color: #ff8a80; }
.note { color: #ffcf6b; font-size: 12px; margin-top: 8px; }
.empty { color: #aaa; }
.pick { width: 100%; margin-top: 8px; padding: 6px; background: #303030; color: #f1f1f1;
        border: 1px solid #454545; border-radius: 8px; font-size: 12px; }
`;

export interface PanelCallbacks {
  onFill(ids: FillId[]): Promise<void>;
  onPickOther(jobId: string, itemIndex: number): void;
  onDismiss(): void;
}

export class PublishPanel {
  private root: ShadowRoot;
  private host: HTMLElement;
  private body: HTMLElement;
  private busy = false;

  constructor(private callbacks: PanelCallbacks) {
    const existing = document.getElementById(HOST_ID);
    if (existing) existing.remove();

    this.host = document.createElement('div');
    this.host.id = HOST_ID;
    this.root = this.host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = CSS;

    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="head">
        <strong>ContentStudio</strong>
        <button class="x" title="Hide">&times;</button>
      </div>
      <div class="body"></div>
    `;
    card.querySelector('.x')!.addEventListener('click', () => {
      this.destroy();
      this.callbacks.onDismiss();
    });

    this.root.append(style, card);
    this.body = card.querySelector('.body') as HTMLElement;
    document.body.appendChild(this.host);
  }

  destroy(): void {
    this.host.remove();
  }

  /** Nothing matched: explain and offer a manual pick from the pending list. */
  renderNoMatch(reason: string, pending: PendingFillItem[]): void {
    this.body.innerHTML = '';

    const why = document.createElement('div');
    why.className = 'reason';
    why.textContent = reason;
    this.body.appendChild(why);

    if (pending.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.style.marginTop = '8px';
      empty.textContent = 'Nothing is waiting to be filled. Pick titles in ContentStudio first.';
      this.body.appendChild(empty);
      return;
    }

    const select = document.createElement('select');
    select.className = 'pick';
    select.innerHTML =
      `<option value="">Choose an item…</option>` +
      pending
        .map(
          (p, i) =>
            `<option value="${i}">${escapeHtml(p.label)} — ${p.titles.length} title(s)</option>`,
        )
        .join('');
    select.addEventListener('change', () => {
      const idx = Number(select.value);
      if (!Number.isInteger(idx) || !pending[idx]) return;
      this.callbacks.onPickOther(pending[idx].jobId, pending[idx].itemIndex);
    });
    this.body.appendChild(select);
  }

  /** A match: show it, list the variants, offer the fill actions. */
  renderMatch(item: PendingFillItem, reason: string, ctx: FillContext): void {
    this.body.innerHTML = '';

    const label = document.createElement('div');
    label.className = 'match';
    label.textContent = item.label;
    this.body.appendChild(label);

    const why = document.createElement('div');
    why.className = 'reason';
    why.textContent = reason;
    this.body.appendChild(why);

    if (item.titles.length) {
      const ul = document.createElement('ul');
      ul.className = 'titles';
      item.titles.forEach((t, i) => {
        const li = document.createElement('li');
        li.innerHTML = `<span class="n">${i + 1}</span><span class="t"></span>`;
        (li.querySelector('.t') as HTMLElement).textContent = t;
        ul.appendChild(li);
      });
      this.body.appendChild(ul);
    }

    const actions = document.createElement('div');
    actions.className = 'actions';

    const all = document.createElement('button');
    all.className = 'act primary';
    all.textContent = 'Fill everything';
    all.addEventListener('click', () => this.run(FILLERS.map((f) => f.id)));
    actions.appendChild(all);

    for (const filler of FILLERS) {
      const detected = filler.detect(ctx);
      const btn = document.createElement('button');
      btn.className = 'act';
      btn.textContent = filler.label;
      if (!detected.available) {
        btn.disabled = true;
        btn.title = detected.reason;
        btn.textContent = `${filler.label} — ${detected.reason}`;
      } else {
        btn.addEventListener('click', () => this.run([filler.id]));
      }
      actions.appendChild(btn);
    }

    this.body.appendChild(actions);

    const note = document.createElement('div');
    note.className = 'note';
    note.textContent =
      'Filling only enters text. You still press “Set test” in the A/B dialog and “Save” on the page.';
    this.body.appendChild(note);
  }

  private async run(ids: FillId[]): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.setButtonsDisabled(true);
    try {
      await this.callbacks.onFill(ids);
    } finally {
      this.busy = false;
      this.setButtonsDisabled(false);
    }
  }

  private setButtonsDisabled(disabled: boolean): void {
    this.root.querySelectorAll<HTMLButtonElement>('button.act').forEach((b) => {
      // Leave permanently-unavailable actions disabled.
      if (!disabled && b.title) return;
      b.disabled = disabled;
    });
  }

  /** Append one result line. Failures stay on screen — never silently swallowed. */
  log(ok: boolean, filler: Filler | null, message: string): void {
    let log = this.body.querySelector('.log') as HTMLElement | null;
    if (!log) {
      log = document.createElement('div');
      log.className = 'log';
      this.body.appendChild(log);
    }
    const line = document.createElement('div');
    line.className = 'line';
    line.innerHTML = `<span class="${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✕'}</span><span></span>`;
    (line.querySelector('span:last-child') as HTMLElement).textContent = filler
      ? `${filler.label}: ${message}`
      : message;
    log.appendChild(line);
    log.scrollIntoView({ block: 'nearest' });
  }

  renderError(message: string): void {
    this.body.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'bad';
    div.textContent = message;
    this.body.appendChild(div);
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}
