import { Component } from '@angular/core';
import { EnvironmentSetupService } from '../../services/environment-setup';
import { CrucibleServers } from '../settings/crucible-servers';

/**
 * The setup gate: the Settings › Crucible Servers pane, shown modally until a Crucible server is
 * connected and ready (LEDGER #221). The service decides when it is open; this only draws it.
 */
@Component({
  selector: 'environment-setup-dialog',
  standalone: true,
  imports: [CrucibleServers],
  templateUrl: './environment-setup-dialog.html',
  styleUrl: './environment-setup-dialog.scss',
})
export class EnvironmentSetupDialog {
  constructor(public setup: EnvironmentSetupService) {}
}
