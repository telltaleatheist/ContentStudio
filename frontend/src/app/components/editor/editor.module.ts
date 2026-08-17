// src/app/components/editor/editor.module.ts
//
// The timeline editor as a self-contained Angular feature module. Everything the
// editor declares lives under this folder; the host app only has to import
// EditorModule (EditorComponent is exported for the router).
import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { EditorComponent } from './editor.component';
import { ProjectSidebarComponent } from './project-sidebar/project-sidebar.component';
import { ProjectSetupModalComponent } from './project-setup-modal/project-setup-modal.component';
import { ActivityDockComponent } from './activity-dock/activity-dock.component';
import { ExportModalsComponent } from './export-modals/export-modals.component';
import { TranscriptPaneComponent } from './transcript-pane/transcript-pane.component';
import { RelinkModalComponent } from './relink-modal/relink-modal.component';
import { EnvironmentModalComponent } from './environment-modal/environment-modal.component';
import { ProjectsService } from './services/projects.service';
import { ArchiveService } from './services/archive.service';

@NgModule({
  declarations: [
    EditorComponent,
    ProjectSidebarComponent,
    ProjectSetupModalComponent,
    ActivityDockComponent,
    ExportModalsComponent,
    TranscriptPaneComponent,
    RelinkModalComponent,
    EnvironmentModalComponent
  ],
  imports: [
    CommonModule,
    FormsModule
  ],
  exports: [
    EditorComponent,
    ProjectSidebarComponent,
    ProjectSetupModalComponent,
    ActivityDockComponent,
    ExportModalsComponent,
    TranscriptPaneComponent,
    RelinkModalComponent,
    EnvironmentModalComponent
  ],
  // Module-scoped, not providedIn: 'root' — same reason as ProjectsService. These belong to
  // the editor and have to travel with it; a root provider would keep resolving through the
  // host app's injector, which is the dependency this folder exists to be free of.
  providers: [ProjectsService, ArchiveService]
})
export class EditorModule { }
