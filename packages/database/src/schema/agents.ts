import { relations } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  varchar,
  jsonb,
  boolean,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

import { users } from "./users.js";
import { intelligenceServices } from "./intelligence-services.js";

/**
 * `agents` — the persona CATALOG an intelligence service publishes
 * (`POST /api/hub/agents/sync`): slug → agentType, name, icon, capabilities.
 * Live: `channels.assignedAgentId` / `senderAgentId` reference it and the chat
 * paths read `slug` as the turn's `agentType`. NOT the agent identity — that is
 * `users.userType = 'agent'`.
 *
 * `intelligenceServiceId` is catalog PROVENANCE (which IS published the row,
 * scoping its sync/prune), never a routing key. Per-agent IS routing
 * (`resolveIntelligenceServiceByAgentId`, `resolveAgentForTask`) was removed
 * 2026-10-08: agentType ⟂ intelligenceServiceId. Resolve the serving IS with
 * `resolveIntelligenceService({ capability })` — never from this column.
 */
export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: varchar("agent_slug", { length: 255 }).notNull(),
    description: text("description"),
    icon: text("icon"),
    capabilities: text("capabilities").array().default([]),
    metadata: jsonb("metadata").default({}),
    ownerType: text("owner_type").notNull().default("system"),
    userId: text("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    intelligenceServiceId: text("intelligence_service_id").references(
      () => intelligenceServices.id,
      { onDelete: "set null" }
    ),
    active: boolean("active").default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => {
    return {
      agentsServiceSlugUnique: uniqueIndex("idx_agents_service_slug").on(
        table.intelligenceServiceId,
        table.slug
      ),
      agentsActiveIndex: index("idx_agents_active").on(table.active),
    };
  }
);

export const agentRelations = relations(agents, ({ one }) => ({
  intelligenceService: one(intelligenceServices, {
    fields: [agents.intelligenceServiceId],
    references: [intelligenceServices.id],
  }),
}));

export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
