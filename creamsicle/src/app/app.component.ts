import { Component, OnInit, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ThemeService } from './services/theme.service';
import { NavDockComponent } from './core/nav-dock/nav-dock.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    RouterOutlet,
    NavDockComponent,
  ],
  template: `
    <div class="app-container" [attr.data-theme]="themeService.currentTheme()">
      <main class="main-content">
        <router-outlet />
      </main>

      <!-- Floating Dock Navigation -->
      <app-nav-dock />
    </div>
  `,
  styles: [`
    .app-container {
      height: 100vh;
      background: var(--bg-primary);
      color: var(--text-primary);
      transition: background-color 0.3s ease, color 0.3s ease;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }

    .main-content {
      flex: 1;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      padding-bottom: 80px; /* Space for dock */
    }
  `]
})
export class AppComponent implements OnInit {
  themeService = inject(ThemeService);

  ngOnInit() {
    this.themeService.initializeTheme();
  }
}
