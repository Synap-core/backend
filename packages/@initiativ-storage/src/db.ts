/**
 * SQLite cache layer
 * Rebuilds from .md files, provides fast queries and FTS
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { Note, SearchOptions, SearchResult } from './types.js';

export class DatabaseCache {
  private db: Database.Database;
  private dbPath: string;

  constructor(basePath: string) {
    this.dbPath = path.join(basePath, 'cache.db');
    
    // Ensure base directory exists before opening database
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    this.db = new Database(this.dbPath);
    this.initSchema();
  }

  /**
   * Initialize database schema
   */
  private initSchema(): void {
    this.db.exec(`
      -- Main notes table (cache)
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        git_commit_hash TEXT,
        metadata TEXT
      );

      -- Full-text search index
      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
        title,
        content,
        tags,
        content='notes',
        content_rowid='rowid'
      );

      -- Triggers to keep FTS in sync
      CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
        INSERT INTO notes_fts(rowid, title, content, tags)
        VALUES (new.rowid, new.title, new.content, new.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, title, content, tags)
        VALUES('delete', old.rowid, old.title, old.content, old.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, title, content, tags)
        VALUES('delete', old.rowid, old.title, old.content, old.tags);
        INSERT INTO notes_fts(rowid, title, content, tags)
        VALUES (new.rowid, new.title, new.content, new.tags);
      END;

      -- Indices for common queries
      CREATE INDEX IF NOT EXISTS idx_notes_created_at ON notes(created_at);
      CREATE INDEX IF NOT EXISTS idx_notes_updated_at ON notes(updated_at);
    `);
  }

  /**
   * Rebuild cache from notes array
   */
  async rebuildCache(notes: Note[]): Promise<void> {
    const transaction = this.db.transaction((notesToInsert: Note[]) => {
      // Clear existing data
      this.db.prepare('DELETE FROM notes').run();

      // Insert all notes
      const insertStmt = this.db.prepare(`
        INSERT INTO notes (id, title, content, tags, created_at, updated_at, git_commit_hash, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const note of notesToInsert) {
        insertStmt.run(
          note.id,
          note.title,
          note.content,
          note.tags ? JSON.stringify(note.tags) : null,
          note.createdAt.getTime(),
          note.updatedAt.getTime(),
          note.gitCommitHash || null,
          note.metadata ? JSON.stringify(note.metadata) : null
        );
      }
    });

    transaction(notes);
  }

  /**
   * Get note by ID
   */
  getNote(noteId: string): Note | null {
    const row = this.db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId) as any;
    return row ? this.rowToNote(row) : null;
  }

  /**
   * Get all notes
   */
  getAllNotes(options?: SearchOptions): Note[] {
    const limit = options?.limit || 100;
    const offset = options?.offset || 0;
    const sortBy = options?.sortBy || 'updated';
    const sortOrder = options?.sortOrder || 'desc';

    let query = 'SELECT * FROM notes';
    const params: any[] = [];

    // Filter by tags
    if (options?.tags && options.tags.length > 0) {
      query += ' WHERE ' + options.tags.map(() => 'tags LIKE ?').join(' OR ');
      params.push(...options.tags.map(tag => `%"${tag}"%`));
    }

    // Sort
    const sortColumn = sortBy === 'created' ? 'created_at' : 'updated_at';
    query += ` ORDER BY ${sortColumn} ${sortOrder.toUpperCase()}`;

    // Pagination
    query += ' LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = this.db.prepare(query).all(...params) as any[];
    return rows.map(row => this.rowToNote(row));
  }

  /**
   * Full-text search
   */
  searchNotes(query: string, options?: SearchOptions): SearchResult[] {
    const limit = options?.limit || 10;

    // Sanitize query for FTS5:
    // 1. Remove special chars that FTS doesn't like (quotes, apostrophes, colons, etc)
    // 2. Split into words
    // 3. Filter out short words and stop words
    const sanitized = query
      .replace(/['"?!:;,()]/g, ' ') // Remove special punctuation
      .trim()
      .split(/\s+/)
      .filter(term => term.length > 2) // At least 3 chars
      .filter(term => !['que', 'est', 'les', 'des', 'une', 'the', 'and', 'are'].includes(term.toLowerCase()));

    if (sanitized.length === 0) {
      // Fallback to LIKE search
      return this.fallbackSearch(query, limit);
    }

    // Use OR to match any term
    const searchTerms = sanitized.join(' OR ');

    try {
      const rows = this.db.prepare(`
        SELECT 
          n.*,
          snippet(notes_fts, 1, '<mark>', '</mark>', '...', 64) as snippet,
          rank as score
        FROM notes n
        JOIN notes_fts ON notes_fts.rowid = n.rowid
        WHERE notes_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(searchTerms, limit) as any[];

      return rows.map(row => ({
        note: this.rowToNote(row),
        score: -row.score, // FTS rank is negative, invert for positive scores
        snippet: row.snippet || row.content?.substring(0, 200) || ''
      }));
    } catch (error) {
      // If FTS query fails, fall back to LIKE search
      console.warn('FTS search failed, using LIKE fallback:', (error as Error).message);
      return this.fallbackSearch(query, limit);
    }
  }

  /**
   * Fallback LIKE search when FTS fails
   */
  private fallbackSearch(query: string, limit: number): SearchResult[] {
    const likePattern = `%${query}%`;
    
    try {
      const rows = this.db.prepare(`
        SELECT * FROM notes
        WHERE title LIKE ? OR content LIKE ?
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(likePattern, likePattern, limit) as any[];

      return rows.map(row => {
        const note = this.rowToNote(row);
        return {
          note,
          score: 0.5,
          snippet: note.content.substring(0, 200)
        };
      });
    } catch (error) {
      console.error('Even LIKE fallback failed:', (error as Error).message);
      return [];
    }
  }

  /**
   * Upsert note to cache
   */
  upsertNote(note: Note): void {
    this.db.prepare(`
      INSERT INTO notes (id, title, content, tags, created_at, updated_at, git_commit_hash, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        content = excluded.content,
        tags = excluded.tags,
        updated_at = excluded.updated_at,
        git_commit_hash = excluded.git_commit_hash,
        metadata = excluded.metadata
    `).run(
      note.id,
      note.title,
      note.content,
      note.tags ? JSON.stringify(note.tags) : null,
      note.createdAt.getTime(),
      note.updatedAt.getTime(),
      note.gitCommitHash || null,
      note.metadata ? JSON.stringify(note.metadata) : null
    );
  }

  /**
   * Delete note from cache
   */
  deleteNote(noteId: string): void {
    this.db.prepare('DELETE FROM notes WHERE id = ?').run(noteId);
  }

  /**
   * Get statistics
   */
  getStats(): { totalNotes: number; totalTags: number; } {
    const totalNotes = this.db.prepare('SELECT COUNT(*) as count FROM notes').get() as any;
    
    // Count unique tags
    const tagsRows = this.db.prepare('SELECT tags FROM notes WHERE tags IS NOT NULL').all() as any[];
    const allTags = new Set<string>();
    
    for (const row of tagsRows) {
      try {
        const tags = JSON.parse(row.tags) as string[];
        tags.forEach(tag => allTags.add(tag));
      } catch {
        // Ignore parse errors
      }
    }

    return {
      totalNotes: totalNotes.count,
      totalTags: allTags.size
    };
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
  }

  /**
   * Convert database row to Note object
   */
  private rowToNote(row: any): Note {
    return {
      id: row.id,
      title: row.title,
      content: row.content,
      tags: row.tags ? JSON.parse(row.tags) : undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      gitCommitHash: row.git_commit_hash || undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined
    };
  }
}

