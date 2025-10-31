import { Component, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatListModule } from '@angular/material/list';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { FormsModule } from '@angular/forms';
import { ElectronService } from '../../services/electron';

interface InputItem {
  type: string;
  path: string;
  displayName: string;
  icon: string;
}

@Component({
  selector: 'app-inputs',
  imports: [
    MatIconModule,
    MatButtonModule,
    MatListModule,
    MatChipsModule,
    MatFormFieldModule,
    MatSelectModule,
    MatDialogModule,
    FormsModule
  ],
  templateUrl: './inputs.html',
  styleUrl: './inputs.scss',
})
export class Inputs {
  inputItems = signal<InputItem[]>([]);
  selectedPlatform = signal('youtube');
  selectedMode = signal('individual');

  constructor(
    private dialog: MatDialog,
    private electron: ElectronService
  ) {}

  openTextSubjectDialog() {
    // TODO: Create proper dialog component
    const subjects = prompt('Enter text subjects (one per line):');
    if (subjects) {
      const lines = subjects.split('\n').filter(line => line.trim());
      lines.forEach(subject => {
        this.inputItems.update(items => [...items, {
          type: 'subject',
          path: subject.trim(),
          displayName: subject.trim(),
          icon: 'text_fields'
        }]);
      });
    }
  }

  async browseFiles() {
    const result = await this.electron.selectFiles();
    if (result.success && result.files.length > 0) {
      for (const filePath of result.files) {
        const isDir = await this.electron.isDirectory(filePath);
        const fileName = filePath.split('/').pop() || filePath;

        if (isDir) {
          this.inputItems.update(items => [...items, {
            type: 'directory',
            path: filePath,
            displayName: fileName,
            icon: 'folder'
          }]);
        } else {
          const ext = fileName.split('.').pop()?.toLowerCase() || '';
          let icon = 'description';
          let type = 'file';

          if (['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v'].includes(ext)) {
            icon = 'movie';
            type = 'video';
          } else if (ext === 'txt') {
            icon = 'text_fields';
            type = 'transcript';
          }

          this.inputItems.update(items => [...items, {
            type,
            path: filePath,
            displayName: fileName,
            icon
          }]);
        }
      }
    }
  }

  removeInput(index: number) {
    this.inputItems.update(items => items.filter((_, i) => i !== index));
  }

  async generateMetadata() {
    if (this.inputItems().length === 0) return;

    const inputs = this.inputItems().map(item => item.path);

    try {
      const result = await this.electron.generateMetadata({
        inputs,
        platform: this.selectedPlatform(),
        mode: this.selectedMode()
      });

      if (result.success) {
        console.log('Metadata generated successfully:', result);
        alert('Metadata generated successfully!');
      } else {
        console.error('Generation failed:', result.error);
        alert('Generation failed: ' + result.error);
      }
    } catch (error) {
      console.error('Error generating metadata:', error);
      alert('Error generating metadata');
    }
  }
}
