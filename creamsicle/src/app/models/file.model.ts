export interface FileNode {
  id: string;
  name: string;
  type: 'file' | 'folder';
  size?: number;
  modifiedDate?: Date;
  children?: FileNode[];
  expanded?: boolean;
  selected?: boolean;
  path: string;
  icon?: string;
  extension?: string;
}

export interface ContextMenuAction {
  label: string;
  icon: string;
  action: string;
  divider?: boolean;
  disabled?: boolean;
  children?: ContextMenuAction[];
}

export interface ContextMenuPosition {
  x: number;
  y: number;
}

// Cascade List Types
export interface CascadeItem {
  id: string;
  name: string;
  subtitle?: string;
  icon?: string;
  status?: 'pending' | 'active' | 'complete' | 'error';
  progress?: number;
  metadata?: string;
  tags?: string[];
}

export interface CascadeGroup {
  label: string;
  items: CascadeItem[];
  expanded?: boolean;
}

export interface ItemProgress {
  value: number;
  color?: string;
  label?: string;
  indeterminate?: boolean;
}
