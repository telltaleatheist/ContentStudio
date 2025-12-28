import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import { ThemeService } from '../../services/theme.service';

@Component({
  selector: 'app-nav-dock',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './nav-dock.component.html',
  styleUrls: ['./nav-dock.component.scss']
})
export class NavDockComponent {
  themeService = inject(ThemeService);
  router = inject(Router);

  hoveredIndex = signal<number | null>(null);

  navLinks = [
    { path: '/inputs', label: 'Inputs', icon: '📥' },
    { path: '/metadata-reports', label: 'Reports', icon: '📊' },
    { path: '/prompts', label: 'Prompts', icon: '✨' },
    { path: '/history', label: 'History', icon: '🕐' },
    { path: '/settings', label: 'Settings', icon: '⚙️' }
  ];

  setHovered(index: number | null) {
    this.hoveredIndex.set(index);
  }

  getScale(index: number): number {
    const hovered = this.hoveredIndex();
    if (hovered === null) return 1;

    const distance = Math.abs(index - hovered);
    if (distance === 0) return 1.4;
    if (distance === 1) return 1.2;
    if (distance === 2) return 1.1;
    return 1;
  }

  getTranslateY(index: number): number {
    const hovered = this.hoveredIndex();
    if (hovered === null) return 0;

    const distance = Math.abs(index - hovered);
    if (distance === 0) return -12;
    if (distance === 1) return -6;
    if (distance === 2) return -2;
    return 0;
  }

  toggleTheme() {
    this.themeService.toggleTheme();
  }

  isActive(path: string): boolean {
    return this.router.url === path || this.router.url.startsWith(path + '/');
  }
}
