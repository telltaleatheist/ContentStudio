import { Routes } from '@angular/router';
import { Inputs } from './components/inputs/inputs';
import { Settings } from './components/settings/settings';
import { MetadataReports } from './components/metadata-reports/metadata-reports';
import { Prompts } from './components/prompts/prompts';
import { History } from './components/history/history';
import { MasterAnalysis } from './components/master-analysis/master-analysis';
import { MasterReports } from './components/master-reports/master-reports';

export const routes: Routes = [
  { path: '', redirectTo: '/inputs', pathMatch: 'full' },
  { path: 'inputs', component: Inputs },
  { path: 'master-analysis', component: MasterAnalysis },
  { path: 'master-reports', component: MasterReports },
  { path: 'metadata-reports', component: MetadataReports },
  { path: 'prompts', component: Prompts },
  { path: 'history', component: History },
  { path: 'settings', component: Settings }
];
