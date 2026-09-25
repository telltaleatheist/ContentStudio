import { Component, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { CrucibleRefusal, CrucibleService } from '../../services/crucible';
import type { CrucibleSettingsView, KeyMigrationOutcome, UpstreamTestAnswer } from '../../features/crucible/crucible.types';

/**
 * ONE SERVER'S CLAUDE KEY (LEDGER #194: keys live in Crucible, not the app).
 *
 * Ported from Briefcase's crucible-upstreams.component, cut to the one upstream
 * ContentStudio routes to (the Anthropic key; `openai:` is being removed, #194). Paste,
 * Test, then Save: the key crosses once, on its way in, the box is emptied, and from then on
 * only the server's own `keyHint` is shown. The app holds no key (P2): P1's "copy my key"
 * button went when api-keys.json was moved, once, into the Crucible on this computer
 * (plan 6.6), since a server never hands a key back. A key for any other server is typed
 * here. When that one move found a DIFFERENT key already on this computer's server, it stopped
 * and asks here: keep the server's, or replace it with the one ContentStudio had.
 *
 * A server whose settings do not offer Anthropic (its card comes back null) shows a sentence,
 * not an input.
 */
@Component({
  selector: 'app-crucible-server-keys',
  imports: [FormsModule, MatButtonModule],
  template: `
    @if (loadError(); as error) {
      <p class="keys-warn">{{ error }}</p>
    } @else if (settings(); as doc) {
      @if (doc.upstreams.anthropic; as card) {
        <div class="keys-head">
          <span class="keys-name">Claude key on {{ server() }}</span>
          @if (card.configured) {
            <span class="keys-pill ok">Key {{ card.keyHint ?? 'set (no hint given)' }}</span>
          } @else {
            <span class="keys-pill off">No key</span>
          }
        </div>
        <div class="keys-row">
          <input
            type="password"
            class="keys-input"
            autocomplete="off"
            spellcheck="false"
            [placeholder]="card.configured ? 'Paste a new key to replace it' : 'sk-ant-…'"
            [ngModel]="draft()"
            (ngModelChange)="draft.set($event)" />
          <button mat-stroked-button [disabled]="busy() || (!draft().trim() && !card.configured)" (click)="test()">Test</button>
          <button mat-flat-button color="primary" [disabled]="busy() || !draft().trim()" (click)="save()">Save</button>
          @if (card.configured) {
            <button mat-button [disabled]="busy()" (click)="removeKey()">Remove</button>
          }
        </div>
        @if (migration(); as moved) {
          <div class="keys-row">
            <span class="keys-hint" [class.keys-warn]="moved.status !== 'migrated'">{{ moved.message }}</span>
            @if (moved.status === 'differing_key') {
              <button mat-button [disabled]="busy()" (click)="resolveMigration('keep')">Keep the server's key</button>
              <button mat-button [disabled]="busy()" (click)="resolveMigration('replace')">Replace it with ContentStudio's</button>
            }
          </div>
          @if (moved.openaiDropped) {
            <p class="keys-hint">The OpenAI key in api-keys.json was not moved: OpenAI is no longer a provider.</p>
          }
        }
      } @else {
        <p class="keys-hint">{{ server() }} does not offer Claude via Crucible.</p>
      }
      @if (result(); as line) {
        <p class="keys-result" [class.bad]="!line.ok">{{ line.text }}</p>
      }
    } @else {
      <p class="keys-hint">Reading {{ server() }}'s keys…</p>
    }
  `,
  styles: [`
    :host { display: block; }
    .keys-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
    .keys-name { font-size: 0.85rem; font-weight: 600; color: var(--text-primary); }
    .keys-pill { font-size: 0.72rem; font-weight: 700; padding: 2px 8px; border-radius: 999px; }
    .keys-pill.ok { color: var(--success-text); background: var(--success-bg); }
    .keys-pill.off { color: var(--text-secondary); background: var(--bg-secondary); }
    .keys-row { display: flex; align-items: center; gap: 8px; margin-top: 6px; flex-wrap: wrap; }
    .keys-input { flex: 1; min-width: 12rem; border: 1px solid var(--border-color); background: var(--bg-primary); color: var(--text-primary); border-radius: 8px; padding: 7px 10px; font: inherit; font-size: 0.85rem; outline: none; }
    .keys-input:focus { border-color: var(--primary-orange); }
    .keys-hint { font-size: 0.8rem; color: var(--text-secondary); }
    .keys-result { margin: 6px 0 0; font-size: 0.8rem; color: var(--text-secondary); }
    .keys-result.bad, .keys-warn { color: var(--warning-text); }
    .keys-warn { font-size: 0.8rem; margin: 0; }
  `],
})
export class CrucibleServerKeys {
  private readonly crucible = inject(CrucibleService);

  /** The registered server whose key this is. */
  readonly server = input.required<string>();

  readonly settings = signal<CrucibleSettingsView | null>(null);
  readonly loadError = signal<string | null>(null);
  readonly draft = signal('');
  readonly busy = signal(false);
  readonly result = signal<{ ok: boolean; text: string } | null>(null);
  /** What the api-keys.json move last said about THIS server, when it said anything. */
  readonly migration = signal<KeyMigrationOutcome | null>(null);

  constructor() {
    effect(() => {
      const name = this.server();
      this.settings.set(null);
      this.draft.set('');
      this.result.set(null);
      void this.load(name);
    });
  }

  private async load(name: string): Promise<void> {
    try {
      this.settings.set(await this.crucible.settings(name));
      this.loadError.set(null);
      const moved = await this.crucible.keyMigration();
      this.migration.set(moved !== null && moved.server === name && moved.status !== 'nothing' ? moved : null);
    } catch (err) {
      this.loadError.set(err instanceof CrucibleRefusal ? err.message : `Could not read ${name}'s keys.`);
    }
  }

  private async run(work: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    try {
      await work();
    } catch (err) {
      this.result.set({ ok: false, text: err instanceof CrucibleRefusal ? err.message : String(err) });
    } finally {
      this.busy.set(false);
    }
  }

  /** Test the pasted key, or with none pasted, the key the server already holds. */
  test(): Promise<void> {
    return this.run(async () => {
      const key = this.draft().trim();
      const answer = await this.crucible.testUpstream(this.server(), 'anthropic', key ? { key } : {});
      if (answer.ok) {
        const count = answer.models.length;
        this.result.set({ ok: true, text: `The key works: ${count} Claude model${count === 1 ? '' : 's'} offered.` });
      } else {
        const refused = answer as Extract<UpstreamTestAnswer, { ok: false }>;
        this.result.set({ ok: false, text: refused.message });
      }
    });
  }

  save(): Promise<void> {
    return this.run(async () => {
      const key = this.draft().trim();
      if (!key) return;
      const view = await this.crucible.saveUpstreamKey(this.server(), 'anthropic', key);
      this.settings.set(view);
      this.draft.set('');
      this.result.set({ ok: true, text: `Saved on ${this.server()}.` });
    });
  }

  removeKey(): Promise<void> {
    if (!confirm(`Remove the Claude key from ${this.server()}? Anything that server sends to Claude stops working, for every app that uses it.`)) {
      return Promise.resolve();
    }
    return this.run(async () => {
      this.settings.set(await this.crucible.removeUpstream(this.server(), 'anthropic'));
      this.result.set({ ok: true, text: `Removed from ${this.server()}.` });
    });
  }

  /** The answer to the move's one question (plan 6.6: stop and ask on a differing key). */
  resolveMigration(choice: 'keep' | 'replace'): Promise<void> {
    if (choice === 'replace' && !confirm(`Replace the Claude key on ${this.server()}? Every app that uses that server sends to Claude with the new one.`)) {
      return Promise.resolve();
    }
    return this.run(async () => {
      const outcome = await this.crucible.resolveKeyMigration(choice);
      this.result.set({ ok: outcome.status === 'migrated', text: outcome.message });
      await this.load(this.server());
    });
  }
}
