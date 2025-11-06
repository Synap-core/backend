/**
 * @initiativ/storage
 * Storage layer for Initiativ Core
 * 
 * Hybrid approach:
 * - .md files: Git-friendly, human-readable source of truth
 * - SQLite cache: Fast queries, full-text search, rebuilds from .md
 */

import { randomUUID } from 'crypto';
import { FileStorage } from './files.js';
import { DatabaseCache } from './db.js';
import {
  Note,
  StorageConfig,
  SearchOptions,
  SearchResult,
  StorageStats
} from './types.js';

export class Storage {
  private files: FileStorage;
  private cache: DatabaseCache;
  private config: StorageConfig;

  constructor(config: StorageConfig) {
    this.config = config;
    this.files = new FileStorage(config.basePath);
    this.cache = new DatabaseCache(config.basePath);
  }

  /**
   * Initialize storage (create directories, rebuild cache if needed)
   */
  async init(): Promise<void> {
    // Ensure base directory exists first
    const fs = await import('fs/promises');
    await fs.mkdir(this.config.basePath, { recursive: true });
    
    await this.files.init();

    if (this.config.autoRebuild !== false) {
      await this.rebuildCache();
    }
  }

  /**
   * Create a new note
   */
  async createNote(content: string, options?: {
    title?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<Note> {
    const now = new Date();
    const note: Note = {
      id: randomUUID(),
      title: options?.title || this.extractTitle(content),
      content,
      tags: options?.tags,
      createdAt: now,
      updatedAt: now,
      metadata: options?.metadata
    };

    // Save to file
    await this.files.saveNote(note);

    // Update cache
    this.cache.upsertNote(note);

    return note;
  }

  /**
   * Get note by ID
   */
  async getNote(noteId: string): Promise<Note> {
    // Try cache first
    const cached = this.cache.getNote(noteId);
    if (cached) {
      return cached;
    }

    // Fallback to file
    const note = await this.files.loadNote(noteId);
    this.cache.upsertNote(note);
    return note;
  }

  /**
   * Update a note
   */
  async updateNote(noteId: string, updates: {
    content?: string;
    title?: string;
    tags?: string[];
    gitCommitHash?: string;
    metadata?: Record<string, unknown>;
  }): Promise<Note> {
    const existing = await this.getNote(noteId);

    const updated: Note = {
      ...existing,
      ...updates,
      updatedAt: new Date()
    };

    // Save to file
    await this.files.saveNote(updated);

    // Update cache
    this.cache.upsertNote(updated);

    return updated;
  }

  /**
   * Delete a note
   */
  async deleteNote(noteId: string): Promise<void> {
    await this.files.deleteNote(noteId);
    this.cache.deleteNote(noteId);
  }

  /**
   * Search notes using full-text search
   */
  searchNotes(query: string, options?: SearchOptions): SearchResult[] {
    return this.cache.searchNotes(query, options);
  }

  /**
   * Get all notes (with optional filters)
   */
  getAllNotes(options?: SearchOptions): Note[] {
    return this.cache.getAllNotes(options);
  }

  /**
   * Rebuild cache from .md files
   */
  async rebuildCache(): Promise<void> {
    const notes = await this.files.loadAllNotes();
    await this.cache.rebuildCache(notes);
  }

  /**
   * Get storage statistics
   */
  getStats(): StorageStats {
    const dbStats = this.cache.getStats();

    return {
      totalNotes: dbStats.totalNotes,
      totalTags: dbStats.totalTags,
      diskSizeBytes: 0, // TODO: Calculate from files
      cacheSizeBytes: 0, // TODO: Get from DB file size
    };
  }

  /**
   * Close storage connections
   */
  close(): void {
    this.cache.close();
  }

  /**
   * Extract title from content (first line or first 50 chars)
   */
  private extractTitle(content: string): string {
    const firstLine = content.split('\n')[0].trim();
    
    // Remove markdown heading markers
    const title = firstLine.replace(/^#+\s*/, '');
    
    if (title.length > 0 && title.length <= 100) {
      return title;
    }

    // Fallback: first 50 chars
    return content.substring(0, 50).trim() + (content.length > 50 ? '...' : '');
  }
}

// Export types
export type {
  Note,
  NoteMetadata,
  StorageConfig,
  SearchOptions,
  SearchResult,
  StorageStats
} from './types.js';

// Export components
export { FileStorage } from './files.js';
export { DatabaseCache } from './db.js';

