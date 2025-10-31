import { Injectable, signal } from '@angular/core';

export interface InputItem {
  type: string;
  path: string;
  displayName: string;
  icon: string;
  selected: boolean;
  platform: 'youtube' | 'spreaker';
  mode: 'individual' | 'compilation';
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
  selectedPlatform = signal('youtube');
  selectedMode = signal('individual');

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

  updateGenerationState(state: Partial<GenerationState>) {
    this.generationState.update(current => ({ ...current, ...state }));
  }

  setPlatform(platform: string) {
    this.selectedPlatform.set(platform);
  }

  setMode(mode: string) {
    this.selectedMode.set(mode);
  }

  hasLoadedSettings(): boolean {
    return this.settingsLoaded;
  }

  markSettingsLoaded() {
    this.settingsLoaded = true;
  }
}
