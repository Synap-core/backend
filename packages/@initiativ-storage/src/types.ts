/**
 * Core types for storage layer
 */

export interface Note {
  id: string;
  title: string;
  content: string;
  tags?: string[];
  createdAt: Date;
  updatedAt: Date;
  gitCommitHash?: string;
  metadata?: Record<string, unknown>;
}

export interface NoteMetadata {
  id: string;
  title: string;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
  gitCommitHash?: string;
  [key: string]: unknown;
}

export interface StorageConfig {
  basePath: string;
  userId: string;
  autoRebuild?: boolean;
}

export interface SearchOptions {
  limit?: number;
  offset?: number;
  tags?: string[];
  sortBy?: 'created' | 'updated' | 'relevance';
  sortOrder?: 'asc' | 'desc';
}

export interface SearchResult {
  note: Note;
  score?: number;
  snippet?: string;
}

export interface StorageStats {
  totalNotes: number;
  totalTags: number;
  diskSizeBytes: number;
  cacheSizeBytes: number;
  lastRebuild?: Date;
}

