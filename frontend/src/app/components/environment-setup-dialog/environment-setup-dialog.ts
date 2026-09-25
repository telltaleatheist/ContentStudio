import { Component, computed, signal } from '@angular/core';
import { EnvironmentSetupService } from '../../services/environment-setup';

@Component({
  selector: 'environment-setup-dialog',
  standalone: true,
  imports: [],
  templateUrl: './environment-setup-dialog.html',
  styleUrl: './environment-setup-dialog.scss',
})
export class EnvironmentSetupDialog {
  selectedWhisper = signal('whisper-small');
  whisperQueued = signal(false);
  needsAI = computed(() => this.setup.readiness()?.ai.ready === false);
  needsWhisper = computed(() => this.setup.readiness()?.transcription.selectedModelInstalled === false);

  constructor(public setup: EnvironmentSetupService) {
    const recommended = setup.whisperModels().find((item) => item.component.recommended);
    if (recommended) this.selectedWhisper.set(recommended.component.id);
  }

  formatBytes(bytes: number): string {
    return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
  }

  async downloadWhisper(): Promise<void> {
    await this.setup.chooseWhisperModel(this.selectedWhisper());
    this.whisperQueued.set(true);
    if (!this.needsAI()) this.setup.closeOptionalDialog();
  }

}
