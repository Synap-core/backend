/**
 * Capability Template Cache — pod-local persisted CACHE of the Control-Plane
 * capability-template catalog.
 *
 * NOT a source of truth: the Control Plane owns the catalog
 * (GET {CP}/api/marketplace/capabilities). This table is a stale-while-revalidate
 * mirror so the pod's capability catalog NEVER blocks on the CP. A background sync
 * job (packages/jobs `capability-template-sync`) refreshes it every 10 minutes and
 * on startup; catalog reads serve from here (fast DB read, no network). This
 * restores pod sovereignty — a slow/down CP degrades the catalog to "what we last
 * knew", never an 8s hang or an empty list.
 */

import { pgTable, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const capabilityTemplateCache = pgTable("capability_template_cache", {
  /** Stable template key (the CP catalog identity). One row per template. */
  key: text("key").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  /**
   * The full CapabilityDefinition for this template. Typed loosely
   * (`Record<string, unknown>`) so this schema package stays dependency-free —
   * exactly like the re-declared unions in tools.ts. Consumers cast to the shared
   * `CapabilityDefinition` contract.
   */
  definition: jsonb("definition").$type<Record<string, unknown>>().notNull(),
  /** When this row was last refreshed from the Control Plane. */
  syncedAt: timestamp("synced_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type CapabilityTemplateCacheRow =
  typeof capabilityTemplateCache.$inferSelect;
export type NewCapabilityTemplateCacheRow =
  typeof capabilityTemplateCache.$inferInsert;
export const insertCapabilityTemplateCacheSchema = createInsertSchema(
  capabilityTemplateCache
);
export const selectCapabilityTemplateCacheSchema = createSelectSchema(
  capabilityTemplateCache
);
