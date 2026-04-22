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
  pgEnum,
} from "drizzle-orm/pg-core";

import { users } from "./users.js";
import { intelligenceServices } from "./intelligence-services.js";

export const ownerTypeEnum = pgEnum("agent_owner_type", [
  "system",
  "user",
  "provider",
]);

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
    ownerType: ownerTypeEnum("owner_type").notNull().default("system"),
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    intelligenceServiceId: uuid("intelligence_service_id").references(
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
