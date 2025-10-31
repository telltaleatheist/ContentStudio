import { Routes } from '@angular/router';
import { Inputs } from './components/inputs/inputs';
import { Settings } from './components/settings/settings';

export const routes: Routes = [
  { path: '', redirectTo: '/inputs', pathMatch: 'full' },
  { path: 'inputs', component: Inputs },
  { path: 'settings', component: Settings }
];
