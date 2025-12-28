import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    redirectTo: 'inputs',
    pathMatch: 'full'
  },
  {
    path: 'inputs',
    loadComponent: () => import('./pages/inputs/inputs.component').then(m => m.InputsComponent),
    title: 'Inputs | ContentStudio'
  },
  {
    path: 'metadata-reports',
    loadComponent: () => import('./pages/metadata-reports/metadata-reports.component').then(m => m.MetadataReportsComponent),
    title: 'Metadata Reports | ContentStudio'
  },
  {
    path: 'prompts',
    loadComponent: () => import('./pages/prompts/prompts.component').then(m => m.PromptsComponent),
    title: 'Prompts | ContentStudio'
  },
  {
    path: 'history',
    loadComponent: () => import('./pages/history/history.component').then(m => m.HistoryComponent),
    title: 'History | ContentStudio'
  },
  {
    path: 'settings',
    loadComponent: () => import('./pages/settings/settings.component').then(m => m.SettingsComponent),
    title: 'Settings | ContentStudio'
  },
  {
    path: '**',
    redirectTo: 'inputs',
    pathMatch: 'full'
  }
];
