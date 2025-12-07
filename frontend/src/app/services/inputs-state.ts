import { Injectable, signal } from '@angular/core';

export interface InputItem {
  type: string;
  path: string;
  displayName: string;
  icon: string;
  selected: boolean;
  promptSet: string; // ID of the prompt set to use (e.g., "youtube-telltale")
  notes?: string; // Optional notes/instructions for the AI (e.g., "focus on tax fraud")
  generateChapters?: boolean; // For video files: generate YouTube chapter markers (default: true)
}

export interface GenerationState {
  isGenerating: boolean;
  generationStartTime: number;
  elapsedTime: string;
  generationProgress: number;
  currentlyProcessing: string;
}

@Injectable({
  providedIn: 'root'
})
export class InputsStateService {
  // Persistent state across component instances
  inputItems = signal<InputItem[]>([]);

  // Master controls
  compilationMode = signal(false); // If true, all items use the same prompt set
  masterPromptSet = signal('youtube-telltale'); // Default prompt set

  // Generation state
  generationState = signal<GenerationState>({
    isGenerating: false,
    generationStartTime: 0,
    elapsedTime: '0s',
    generationProgress: 0,
    currentlyProcessing: ''
  });

  // Track if initial settings have been loaded
  private settingsLoaded = false;

  constructor() {}

  addItem(item: InputItem) {
    this.inputItems.update(items => [...items, item]);
  }

  removeItem(index: number) {
    this.inputItems.update(items => items.filter((_, i) => i !== index));
  }

  clearItems() {
    this.inputItems.set([]);
  }

  reorderItems(previousIndex: number, currentIndex: number) {
    this.inputItems.update(items => {
      const result = [...items];
      const [removed] = result.splice(previousIndex, 1);
      result.splice(currentIndex, 0, removed);
      return result;
    });
  }

  updateGenerationState(state: Partial<GenerationState>) {
    this.generationState.update(current => ({ ...current, ...state }));
  }

  hasLoadedSettings(): boolean {
    return this.settingsLoaded;
  }

  markSettingsLoaded() {
    this.settingsLoaded = true;
  }
}
