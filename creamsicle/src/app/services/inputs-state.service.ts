import { Injectable, signal } from '@angular/core';

export interface InputItem {
  type: string;
  path: string;
  displayName: string;
  icon: string;
  selected: boolean;
  promptSet: string;
  aiModel?: string;  // Optional - if not set, uses default from settings
  notes?: string;
  generateChapters?: boolean;
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
  inputItems = signal<InputItem[]>([]);
  compilationMode = signal(false);
  masterPromptSet = signal('sample-youtube');
  masterAiModel = signal<string | null>(null);  // null means use settings default

  generationState = signal<GenerationState>({
    isGenerating: false,
    generationStartTime: 0,
    elapsedTime: '0s',
    generationProgress: 0,
    currentlyProcessing: ''
  });

  private settingsLoaded = false;

  addItem(item: InputItem) {
    console.log('[InputsState] addItem called with:', item);
    this.inputItems.update(items => {
      const newItems = [...items, item];
      console.log('[InputsState] Updated items array:', newItems);
      return newItems;
    });
    console.log('[InputsState] inputItems signal value after update:', this.inputItems());
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
