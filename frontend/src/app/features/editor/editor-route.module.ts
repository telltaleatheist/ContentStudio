// src/app/features/editor/editor-route.module.ts
//
// The lazy boundary around the timeline editor, and the only host file that knows
// EditorModule exists.
//
// Why an NgModule and not `loadComponent`: everything under components/editor/ is
// `standalone: false` (it is a ported NgModule feature), and `loadComponent` only accepts a
// standalone component. `loadChildren` onto this module is the wiring that compiles without
// touching a single line of the ported tree.
//
// Why lazy at all: editor.component.ts is ~230 KB of source and its stylesheet ~30 KB, none of
// which the MAIN window ever renders. Eager-importing EditorModule in app.config.ts would put
// all of it in the main window's initial bundle for a window that never shows it.
//
// EDITOR_HOST is provided HERE rather than in app.config.ts for the same reason: binding the
// token at the root would drag EditorHostAdapter — and through it the whole editor type
// surface — into the root injector's chunk. Scoped to this route, the editor window gets the
// host it needs and the main window pays nothing.

import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';

import { EditorComponent } from '../../components/editor/editor.component';
import { EditorModule } from '../../components/editor/editor.module';
import { EDITOR_HOST } from '../../components/editor/editor-host';
import { EditorHostAdapter } from '../../services/editor-host.adapter';

const routes: Routes = [
  { path: '', component: EditorComponent }
];

@NgModule({
  imports: [EditorModule, RouterModule.forChild(routes)],
  providers: [
    // The editor injects this token and nothing else from the host application.
    { provide: EDITOR_HOST, useClass: EditorHostAdapter }
  ]
})
export class EditorRouteModule { }
