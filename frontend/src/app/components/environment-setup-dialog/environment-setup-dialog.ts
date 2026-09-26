import { Component, computed } from '@angular/core';
import { EnvironmentSetupService } from '../../services/environment-setup';

@Component({
  selector: 'environment-setup-dialog',
  standalone: true,
  imports: [],
  templateUrl: './environment-setup-dialog.html',
  styleUrl: './environment-setup-dialog.scss',
})
export class EnvironmentSetupDialog {
  needsAI = computed(() => this.setup.readiness()?.ai.ready === false);

  constructor(public setup: EnvironmentSetupService) {}
}
