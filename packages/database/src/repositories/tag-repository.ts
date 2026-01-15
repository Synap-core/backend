/**
 * Tag Repository
 * 
 * Handles all tag CRUD operations with automatic event emission
 */

import { eq, and } from 'drizzle-orm';
import { tags } from '../schema/tags.js';
import { BaseRepository } from './base-repository.js';
import type { EventRepository } from './event-repository.js';
import type { Tag, NewTag } from '../schema/tags.js';

export interface CreateTagInput {
  name: string;
  color?: string;
  userId: string;
}

export interface UpdateTagInput {
  name?: string;
  color?: string;
}

export class TagRepository extends BaseRepository<Tag, CreateTagInput, UpdateTagInput> {
  constructor(db: any, eventRepo: EventRepository) {
    super(db, eventRepo, { subjectType: 'tag' });
  }

  /**
   * Create a new tag
   * Emits: tags.create.completed
   */
  async create(data: CreateTagInput, userId: string): Promise<Tag> {
    // Check for duplicate name
    const existing = await this.db.query.tags.findFirst({
      where: and(
        eq(tags.userId, userId),
        eq(tags.name, data.name),
      ),
    });

    if (existing) {
      throw new Error(`Tag with name "${data.name}" already exists`);
    }

    const [tag] = await this.db
      .insert(tags)
      .values({
        userId,
        name: data.name,
        color: data.color || '#gray',
      } as NewTag)
      .returning();

    // Emit completed event
    await this.emitCompleted('create', tag, userId);

    return tag;
  }

  /**
   * Update an existing tag
   * Emits: tags.update.completed
   */
  async update(id: string, data: UpdateTagInput, userId: string): Promise<Tag> {
    const [tag] = await this.db
      .update(tags)
      .set({
        name: data.name,
        color: data.color,
      } as Partial<NewTag>)
      .where(and(eq(tags.id, id), eq(tags.userId, userId)))
      .returning();

    if (!tag) {
      throw new Error('Tag not found');
    }

    // Emit completed event
    await this.emitCompleted('update', tag, userId);

    return tag;
  }

  /**
   * Delete a tag
   * Emits: tags.delete.completed
   */
  async delete(id: string, userId: string): Promise<void> {
    const result = await this.db
      .delete(tags)
      .where(and(eq(tags.id, id), eq(tags.userId, userId)))
      .returning({ id: tags.id });

    if (result.length === 0) {
      throw new Error('Tag not found');
    }

    // Emit completed event
    await this.emitCompleted('delete', { id }, userId);
  }
}
