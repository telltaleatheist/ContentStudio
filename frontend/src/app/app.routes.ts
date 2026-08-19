import { Routes } from '@angular/router';
import { Inputs } from './components/inputs/inputs';
import { Settings } from './components/settings/settings';
import { MetadataReports } from './components/metadata-reports/metadata-reports';
import { Prompts } from './components/prompts/prompts';
import { History } from './components/history/history';
import { Analytics } from './components/analytics/analytics';

export const routes: Routes = [
  { path: '', redirectTo: '/inputs', pathMatch: 'full' },
  { path: 'inputs', component: Inputs },
  { path: 'metadata-reports', component: MetadataReports },
  { path: 'analytics', component: Analytics },
  { path: 'prompts', component: Prompts },
  { path: 'history', component: History },
  { path: 'settings', component: Settings },
  // The timeline editor, in its own BrowserWindow. Lazy on purpose: the main window never
  // renders it, and eager wiring would put ~260 KB of editor source in its initial bundle.
  // See features/editor/editor-route.module.ts for why it is a module and not loadComponent.
  {
    path: 'editor',
    loadChildren: () => import('./features/editor/editor-route.module').then(m => m.EditorRouteModule)
  }
];
