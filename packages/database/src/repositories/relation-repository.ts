/**
 * Relation Repository
 *
 * Handles all entity relation CRUD operations with automatic event emission
 */

import { eq, and } from "drizzle-orm";
import { relations } from "../schema/relations.js";
import { BaseRepository } from "./base-repository.js";
import type { EventRepository } from "./event-repository.js";
import type { Relation, NewRelation } from "../schema/relations.js";

export interface CreateRelationInput {
  id?: string;
  sourceEntityId: string;
  targetEntityId: string;
  type: string;
  userId: string;
}

export interface UpdateRelationInput {
  type?: string;
}

export class RelationRepository extends BaseRepository<
  Relation,
  CreateRelationInput,
  UpdateRelationInput
> {
  constructor(db: any, eventRepo: EventRepository) {
    super(db, eventRepo, { subjectType: "relation", pluralName: "relations" });
  }

  /**
   * Create a new relation between entities
   * Emits: relations.create.completed
   */
  async create(data: CreateRelationInput, userId: string): Promise<Relation> {
    const [relation] = await this.db
      .insert(relations)
      .values({
        id: data.id,
        sourceEntityId: data.sourceEntityId,
        targetEntityId: data.targetEntityId,
        type: data.type,
        userId: data.userId,
      } as NewRelation)
      .returning();

    // Emit completed event
    await this.emitCompleted("create", relation, userId);

    return relation;
  }

  /**
   * Update an existing relation
   * Emits: relations.update.completed
   */
  async update(
    id: string,
    data: UpdateRelationInput,
    userId: string
  ): Promise<Relation> {
    const [relation] = await this.db
      .update(relations)
      .set({
        type: data.type,
      } as Partial<NewRelation>)
      .where(and(eq(relations.id, id), eq(relations.userId, userId)))
      .returning();

    if (!relation) {
      throw new Error("Relation not found");
    }

    // Emit completed event
    await this.emitCompleted("update", relation, userId);

    return relation;
  }

  /**
   * Delete a relation
   * Emits: relations.delete.completed
   */
  async delete(id: string, userId: string): Promise<void> {
    const result = await this.db
      .delete(relations)
      .where(and(eq(relations.id, id), eq(relations.userId, userId)))
      .returning({ id: relations.id });

    if (result.length === 0) {
      throw new Error("Relation not found");
    }

    // Emit completed event
    await this.emitCompleted("delete", { id }, userId);
  }
}
