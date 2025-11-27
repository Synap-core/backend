import { db, entities } from '@synap/database';
import { eq } from 'drizzle-orm';
import { EntitySchema, EntitySummarySchema, type Entity, type EntitySummary } from '../types.js';

export class EntityService {
  constructor(private readonly database: typeof db = db) {}

  async listEntities(userId: string, limit: number = 100): Promise<EntitySummary[]> {
    const rows = await this.database
      .select()
      .from(entities)
      .where(eq(entities.userId, userId))
      .limit(limit);

    return rows.map((row) => EntitySummarySchema.parse(row));
  }

  async getEntity(entityId: string): Promise<Entity | null> {
    const [row] = await this.database
      .select()
      .from(entities)
      .where(eq(entities.id, entityId))
      .limit(1);

    return row ? EntitySchema.parse(row) : null;
  }
}

export const entityService = new EntityService();

