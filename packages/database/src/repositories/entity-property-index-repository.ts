/**
 * Entity Property Index Repository
 *
 * Handles indexing entity properties for fast queries.
 * This is a projection/index, NOT the source of truth.
 */

import { eq, and } from "drizzle-orm";
import {
  entityPropertyIndex,
  type EntityPropertyIndex,
  type NewEntityPropertyIndex,
} from "../schema/entity-property-index.js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "../schema/index.js";

export class EntityPropertyIndexRepository {
  constructor(private db: PostgresJsDatabase<typeof schema>) {}

  /**
   * Index a property value for an entity
   */
  async index(
    entityId: string,
    propertyDefId: string,
    value: unknown,
    valueType: string
  ): Promise<EntityPropertyIndex> {
    const indexData: Partial<NewEntityPropertyIndex> = {
      entityId,
      propertyDefId,
      // Clear all value columns first
      valueText: null,
      valueNum: null,
      valueBool: null,
      valueTs: null,
      valueEntityId: null,
      valueJsonb: null,
    };

    // Set the appropriate value column based on type
    switch (valueType) {
      case "string":
        indexData.valueText = value as string;
        break;
      case "number":
        indexData.valueNum = String(value as number); // Numeric column stores as string
        break;
      case "boolean":
        indexData.valueBool = value as boolean;
        break;
      case "date":
        indexData.valueTs = value as Date;
        break;
      case "entity_id":
        // Store as both text and UUID for flexibility
        indexData.valueText = value as string;
        indexData.valueEntityId = value as string;
        break;
      case "array":
      case "object":
        indexData.valueJsonb = value as Record<string, unknown>;
        break;
      default:
        // Fallback to JSONB
        indexData.valueJsonb = value as Record<string, unknown>;
    }

    const [indexed] = await this.db
      .insert(entityPropertyIndex)
      .values(indexData as NewEntityPropertyIndex)
      .onConflictDoUpdate({
        target: [
          entityPropertyIndex.entityId,
          entityPropertyIndex.propertyDefId,
        ],
        set: indexData,
      })
      .returning();

    return indexed;
  }

  /**
   * Remove all indexed properties for an entity
   */
  async removeEntity(entityId: string): Promise<void> {
    await this.db
      .delete(entityPropertyIndex)
      .where(eq(entityPropertyIndex.entityId, entityId));
  }

  /**
   * Remove a specific property index
   */
  async remove(entityId: string, propertyDefId: string): Promise<void> {
    await this.db
      .delete(entityPropertyIndex)
      .where(
        and(
          eq(entityPropertyIndex.entityId, entityId),
          eq(entityPropertyIndex.propertyDefId, propertyDefId)
        )
      );
  }

  /**
   * Get all indexed properties for an entity
   */
  async getByEntity(entityId: string): Promise<EntityPropertyIndex[]> {
    return this.db.query.entityPropertyIndex.findMany({
      where: eq(entityPropertyIndex.entityId, entityId),
    });
  }

  /**
   * Get all entities with a specific property value
   */
  async getByPropertyValue(
    propertyDefId: string,
    value: unknown,
    valueType: string
  ): Promise<EntityPropertyIndex[]> {
    // Build query based on value type
    const conditions = [eq(entityPropertyIndex.propertyDefId, propertyDefId)];

    switch (valueType) {
      case "string":
        conditions.push(eq(entityPropertyIndex.valueText, value as string));
        break;
      case "number":
        conditions.push(
          eq(entityPropertyIndex.valueNum, String(value as number))
        );
        break;
      case "boolean":
        conditions.push(eq(entityPropertyIndex.valueBool, value as boolean));
        break;
      case "date":
        conditions.push(eq(entityPropertyIndex.valueTs, value as Date));
        break;
      case "entity_id":
        conditions.push(eq(entityPropertyIndex.valueEntityId, value as string));
        break;
      default:
        // For arrays/objects, use JSONB containment
        // This is handled separately
        break;
    }

    return this.db.query.entityPropertyIndex.findMany({
      where: and(...conditions),
    });
  }

  /**
   * Get entities with property value in range (for numbers/dates)
   * TODO: Implement when needed using gte/lte operators
   */
  async getByPropertyRange(
    _propertyDefId: string,
    _min?: unknown,
    _max?: unknown,
    _valueType: string = "number"
  ): Promise<EntityPropertyIndex[]> {
    // This would require SQL operators (gte, lte)
    // For now, return empty - implement when needed
    return [];
  }
}
