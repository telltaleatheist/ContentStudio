export type ComponentCategory = 'tool' | 'whisper';
export type ComponentState = 'available' | 'installed' | 'incompatible';
export type InstallPhase = 'resolve' | 'download' | 'verify' | 'extract' | 'done' | 'error';

export interface ComponentArtifact {
  platform: NodeJS.Platform;
  arch: string;
  kind: 'file' | 'archive';
  url: string;
  sha256?: string;
  bytes: number;
  fileName?: string;
  entry?: string;
}

export interface OptionalComponent {
  id: string;
  name: string;
  description: string;
  category: ComponentCategory;
  required?: boolean;
  recommended?: boolean;
  sizeBytes: number;
  entryPath: string;
  version: string;
  artifacts: ComponentArtifact[];
}

export interface InstalledRecord {
  id: string;
  version: string;
  path: string;
  entryPath: string;
  sha256?: string;
  bytes?: number;
  installedAt: string;
}

export interface InstalledManifest {
  components: Record<string, InstalledRecord>;
}

export interface ComponentStatus {
  component: OptionalComponent;
  state: ComponentState;
  installed?: InstalledRecord;
  reason?: string;
}

export interface InstallProgress {
  id: string;
  phase: InstallPhase;
  pct: number;
  receivedBytes?: number;
  totalBytes?: number;
  message?: string;
}

export interface InstallResult {
  id: string;
  ok: boolean;
  record?: InstalledRecord;
  error?: string;
}
