import { db, entities } from '@synap/database';
import { eq } from 'drizzle-orm';
import { EntitySchema, EntitySummarySchema, type Entity, type EntitySummary } from '../types.js';

export class EntityService {
  constructor(private readonly database: typeof db = db) {}

  async listEntities(userId: string, limit: number = 100): Promise<EntitySummary[]> {
    // Type assertion needed due to Drizzle ORM type incompatibility between SQLite and PostgreSQL dialects
    // Both dialects work at runtime, but TypeScript sees them as incompatible types
    const rows = await (this.database
      .select()
      .from(entities)
      .where(eq(entities.userId, userId) as any)
      .limit(limit) as Promise<Array<Record<string, unknown>>>);

    return rows.map((row) => EntitySummarySchema.parse(row));
  }

  async getEntity(entityId: string): Promise<Entity | null> {
    // Type assertion needed due to Drizzle ORM type incompatibility between SQLite and PostgreSQL dialects
    const [row] = await (this.database
      .select()
      .from(entities)
      .where(eq(entities.id, entityId) as any)
      .limit(1) as Promise<Array<Record<string, unknown>>>);

    return row ? EntitySchema.parse(row) : null;
  }
}

export const entityService = new EntityService();

