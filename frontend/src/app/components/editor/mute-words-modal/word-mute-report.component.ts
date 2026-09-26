import { Component, Input } from '@angular/core';
import { WordMuteReport } from '../model/mute-words';

/**
 * What the Mute words pass did, in plain words (LEDGER #226). Shown in the export result and in
 * the Mute words modal after Apply. Every word that was not muted is listed with its time and
 * why — a failure is never folded into a count.
 */
@Component({
  selector: 'app-word-mute-report',
  template: `
    <div class="wmr" *ngIf="report">
      <ng-container *ngIf="!report.active">
        <div class="wmr-line">Mute words: off — {{ report.reason }}<ng-container
          *ngIf="report.removedOld"> ({{ report.removedOld }} earlier {{ report.removedOld === 1 ? 'mute' : 'mutes' }} removed)</ng-container>.</div>
      </ng-container>
      <ng-container *ngIf="report.active">
        <div class="wmr-line">
          Mute words: {{ report.matches }} {{ report.matches === 1 ? 'word' : 'words' }} found,
          {{ report.muted }} muted ({{ report.mutesWritten }} {{ report.mutesWritten === 1 ? 'mute' : 'mutes' }}
          on {{ report.clips }} {{ report.clips === 1 ? 'clip' : 'clips' }})<ng-container
          *ngIf="report.leftByChoice">, {{ report.leftByChoice }} left as you chose (outside the opening window)</ng-container>.
        </div>
        <div class="wmr-groups" *ngIf="groupRows.length">
          <span *ngFor="let g of groupRows">{{ g.label }}: {{ g.muted }}/{{ g.found }}</span>
        </div>
        <div class="wmr-fail" *ngIf="failed.length">
          {{ failed.length }} {{ failed.length === 1 ? 'word was' : 'words were' }} NOT muted:
          <ul><li *ngFor="let n of failed">“{{ n.word }}” at {{ n.at || 'an unknown time' }} ({{ n.track }}) — {{ n.why }}</li></ul>
        </div>
        <div class="wmr-quiet" *ngIf="others.length">
          Not on the timeline, so nothing to mute:
          <ul><li *ngFor="let n of others">“{{ n.word }}” at {{ n.at || 'an unknown time' }} ({{ n.track }}) — {{ n.why }}</li></ul>
        </div>
      </ng-container>
    </div>`,
  styles: [`
    .wmr { font-size: 12px; color: #c4c4ca; line-height: 1.5; margin: 6px 0 12px; }
    .wmr-groups { display: flex; flex-wrap: wrap; gap: 12px; color: #9a9aa2; }
    .wmr-fail { color: #e6a597; margin-top: 6px; }
    .wmr-quiet { color: #9a9aa2; margin-top: 6px; }
    ul { margin: 4px 0 0; padding-left: 18px; max-height: 160px; overflow: auto; }
  `],
  standalone: false
})
export class WordMuteReportComponent {
  @Input() report: WordMuteReport | null = null;

  get groupRows(): Array<{ label: string; found: number; muted: number }> {
    return Object.values(this.report?.groups || {}) as Array<{ label: string; found: number; muted: number }>;
  }

  get failed() {
    return (this.report?.notMuted || []).filter((n) => n.kind === 'failed');
  }

  get others() {
    return (this.report?.notMuted || []).filter((n) => n.kind !== 'failed');
  }
}
