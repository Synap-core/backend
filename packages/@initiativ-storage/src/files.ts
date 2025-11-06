/**
 * File system operations for .md notes
 * Handles reading/writing notes with YAML frontmatter
 */

import fs from 'fs/promises';
import path from 'path';
import matter from 'gray-matter';
import { Note, NoteMetadata } from './types.js';

export class FileStorage {
  private notesPath: string;

  constructor(basePath: string) {
    this.notesPath = path.join(basePath, 'notes');
  }

  /**
   * Initialize file storage (create directories)
   */
  async init(): Promise<void> {
    await fs.mkdir(this.notesPath, { recursive: true });
  }

  /**
   * Save a note as .md file with frontmatter
   */
  async saveNote(note: Note): Promise<string> {
    // Build frontmatter, excluding undefined values
    const frontmatter: Record<string, unknown> = {
      id: note.id,
      title: note.title,
      createdAt: note.createdAt.toISOString(),
      updatedAt: note.updatedAt.toISOString()
    };

    // Add optional fields only if they exist
    if (note.tags && note.tags.length > 0) {
      frontmatter.tags = note.tags;
    }
    if (note.gitCommitHash) {
      frontmatter.gitCommitHash = note.gitCommitHash;
    }
    if (note.metadata) {
      // Add metadata fields, filtering out undefined values
      Object.entries(note.metadata).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          frontmatter[key] = value;
        }
      });
    }

    const fileContent = matter.stringify(note.content, frontmatter);
    const filename = this.getFilename(note.id);
    const filepath = path.join(this.notesPath, filename);

    await fs.writeFile(filepath, fileContent, 'utf-8');
    return filepath;
  }

  /**
   * Load a note from .md file
   */
  async loadNote(noteId: string): Promise<Note> {
    const filename = this.getFilename(noteId);
    const filepath = path.join(this.notesPath, filename);

    try {
      const fileContent = await fs.readFile(filepath, 'utf-8');
      return this.parseNote(fileContent, noteId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Note not found: ${noteId}`);
      }
      throw error;
    }
  }

  /**
   * Load all notes from directory
   */
  async loadAllNotes(): Promise<Note[]> {
    try {
      const files = await fs.readdir(this.notesPath);
      const mdFiles = files.filter(f => f.endsWith('.md'));

      const notes: Note[] = [];
      for (const file of mdFiles) {
        const filepath = path.join(this.notesPath, file);
        const fileContent = await fs.readFile(filepath, 'utf-8');
        const noteId = file.replace('.md', '');
        
        try {
          const note = this.parseNote(fileContent, noteId);
          notes.push(note);
        } catch (error) {
          console.warn(`Failed to parse note ${file}:`, error);
          // Continue loading other notes
        }
      }

      return notes;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return []; // Directory doesn't exist yet
      }
      throw error;
    }
  }

  /**
   * Delete a note file
   */
  async deleteNote(noteId: string): Promise<void> {
    const filename = this.getFilename(noteId);
    const filepath = path.join(this.notesPath, filename);

    try {
      await fs.unlink(filepath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // Already deleted, ignore
        return;
      }
      throw error;
    }
  }

  /**
   * Check if note file exists
   */
  async noteExists(noteId: string): Promise<boolean> {
    const filename = this.getFilename(noteId);
    const filepath = path.join(this.notesPath, filename);

    try {
      await fs.access(filepath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Parse note from markdown content
   */
  private parseNote(fileContent: string, noteId: string): Note {
    const parsed = matter(fileContent);
    const metadata = parsed.data as NoteMetadata;

    return {
      id: metadata.id || noteId,
      title: metadata.title || 'Untitled',
      content: parsed.content,
      tags: metadata.tags,
      createdAt: metadata.createdAt ? new Date(metadata.createdAt) : new Date(),
      updatedAt: metadata.updatedAt ? new Date(metadata.updatedAt) : new Date(),
      gitCommitHash: metadata.gitCommitHash,
      metadata: Object.keys(metadata)
        .filter(k => !['id', 'title', 'tags', 'createdAt', 'updatedAt', 'gitCommitHash'].includes(k))
        .reduce((acc, k) => ({ ...acc, [k]: metadata[k] }), {})
    };
  }

  /**
   * Get filename for note ID
   */
  private getFilename(noteId: string): string {
    return `${noteId}.md`;
  }

  /**
   * Get notes directory path
   */
  getNotesPath(): string {
    return this.notesPath;
  }
}

