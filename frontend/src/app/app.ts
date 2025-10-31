import { Component, signal } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatListModule } from '@angular/material/list';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';

@Component({
  selector: 'app-root',
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    MatToolbarModule,
    MatSidenavModule,
    MatListModule,
    MatIconModule,
    MatButtonModule
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App {
  protected readonly title = signal('LaunchPad');
  protected readonly isDarkMode = signal(true);

  constructor() {
    // Set dark theme as default on init
    document.body.setAttribute('data-theme', 'dark');
  }

  toggleTheme() {
    this.isDarkMode.update(dark => !dark);
    document.body.setAttribute('data-theme', this.isDarkMode() ? 'dark' : 'light');
  }
}