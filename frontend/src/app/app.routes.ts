import { Routes } from '@angular/router';
import { Inputs } from './components/inputs/inputs';
import { Settings } from './components/settings/settings';
import { MetadataReports } from './components/metadata-reports/metadata-reports';
import { Prompts } from './components/prompts/prompts';
import { History } from './components/history/history';

export const routes: Routes = [
  { path: '', redirectTo: '/inputs', pathMatch: 'full' },
  { path: 'inputs', component: Inputs },
  { path: 'metadata-reports', component: MetadataReports },
  { path: 'prompts', component: Prompts },
  { path: 'history', component: History },
  { path: 'settings', component: Settings }
];
