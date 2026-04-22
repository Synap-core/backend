/**
 * Agent Repository
 *
 * Manages AI agent identity layer (names, icons, capabilities, routing).
 * Behavioral internals (systemPrompt, toolsConfig, LLM provider/model) stay on the IS.
 */

import { eq, and, desc, isNull, isNotNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "../schema/index.js";
import { agents, type Agent, type NewAgent } from "../schema/agents.js";

export interface UpsertAgentFromSyncData {
  id: string;
  name: string;
  slug: string;
  description?: string;
  icon?: string;
  capabilities?: string[];
  metadata?: Record<string, unknown>;
  intelligenceServiceId: string;
}

export class AgentRepository {
  constructor(private db: PostgresJsDatabase<typeof schema>) {}

  /**
   * Upsert an agent from IS sync payload.
   * Uses service+slug uniqueness for conflict resolution.
   */
  async upsertFromSync(data: UpsertAgentFromSyncData): Promise<Agent> {
    const [agent] = await this.db
      .insert(agents)
      .values({
        id: data.id,
        name: data.name,
        slug: data.slug,
        description: data.description ?? null,
        icon: data.icon ?? null,
        capabilities: data.capabilities ?? [],
        metadata: data.metadata ?? {},
        active: true,
        ownerType: "provider",
        intelligenceServiceId: data.intelligenceServiceId,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [agents.intelligenceServiceId, agents.slug],
        set: {
          name: data.name,
          description: data.description ?? sql`${agents.description}`,
          icon: data.icon ?? sql`${agents.icon}`,
          capabilities: data.capabilities ?? agents.capabilities,
          metadata: data.metadata ?? agents.metadata,
          active: true,
          updatedAt: new Date(),
        },
      })
      .returning();

    return agent;
  }

  /**
   * Get agent by ID
   */
  async getById(id: string): Promise<Agent | null> {
    const [agent] = await this.db
      .select()
      .from(agents)
      .where(eq(agents.id, id))
      .limit(1);
    return agent || null;
  }

  /**
   * Get active agent by service + slug
   */
  async getBySlug(serviceId: string, slug: string): Promise<Agent | null> {
    const [agent] = await this.db
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.intelligenceServiceId, serviceId),
          eq(agents.slug, slug),
          eq(agents.active, true)
        )
      )
      .limit(1);
    return agent || null;
  }

  /**
   * List all active agents (optionally filtered by service or owner type)
   */
  async list(filters?: {
    intelligenceServiceId?: string | null;
    ownerType?: string;
    active?: boolean;
  }): Promise<Agent[]> {
    const conditions: Array<
      ReturnType<typeof eq | typeof isNull | typeof isNotNull>
    > = [eq(agents.active, true)];

    if (filters?.intelligenceServiceId === null) {
      conditions.push(isNull(agents.intelligenceServiceId));
    } else if (filters?.intelligenceServiceId) {
      conditions.push(
        eq(agents.intelligenceServiceId, filters.intelligenceServiceId)
      );
    }

    if (filters?.ownerType) {
      conditions.push(
        eq(
          agents.ownerType,
          filters.ownerType as "user" | "system" | "provider"
        )
      );
    }

    return await this.db
      .select()
      .from(agents)
      .where(and(...conditions))
      .orderBy(desc(agents.createdAt));
  }

  /**
   * Deactivate an agent
   */
  async deactivate(id: string): Promise<void> {
    await this.db
      .update(agents)
      .set({ active: false, updatedAt: new Date() })
      .where(eq(agents.id, id));
  }

  /**
   * Count active agents for a service
   */
  async countByService(serviceId: string): Promise<number> {
    const [{ count }] = await this.db
      .select({ count: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.intelligenceServiceId, serviceId),
          eq(agents.active, true)
        )
      );
    return Number(count) || 0;
  }

  /**
   * Get IDs of services that have active agents
   */
  async getActiveServiceIds(): Promise<string[]> {
    const rows = await this.db
      .select({ id: agents.intelligenceServiceId })
      .from(agents)
      .where(
        and(eq(agents.active, true), isNotNull(agents.intelligenceServiceId))
      )
      .groupBy(agents.intelligenceServiceId);

    return rows.map((r) => r.id!).filter(Boolean);
  }
}

// Re-export types for convenience
export { type Agent, type NewAgent };
