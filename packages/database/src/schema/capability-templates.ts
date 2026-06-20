/**
 * Capability Templates Schema - Drizzle ORM
 *
 * Templates-as-DATA: the seed `CapabilityDefinition`s that the capability-template
 * applier instantiates (vault secrets · tools · skills). Previously these lived ONLY
 * as files on the dev disk (`synap-backend/templates/capabilities/*.capability.json`)
 * and were never bundled into the deployed `@synap/api` image — so a `templateKey`
 * apply 404'd on the deployed pod. This table makes them DB-resident so the loader
 * can resolve a key without the files being present (the file scan stays as a
 * dev-ergonomics fallback).
 *
 * Scoping mirrors `tools.workspaceId`:
 *   - workspaceId NULL  → pod-wide template (the eve-seed case).
 *   - workspaceId SET   → workspace-scoped overlay (future use).
 * The loader resolves workspace row → pod-wide row → file fallback.
 */

import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspaces } from "./workspaces.js";

export const capabilityTemplates = pgTable(
  "capability_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // The templateKey, e.g. "generic-apikey". Matches `^[a-z0-9-]+$` (same regex
    // the apply route enforces). Not globally unique — a workspace overlay and a
    // pod-wide template may share a key (resolution prefers the workspace row).
    key: text("key").notNull(),

    // NULL = pod-wide. SET = scoped to one workspace (overlay).
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "cascade",
    }),

    name: text("name").notNull(),
    description: text("description"),

    // The full CapabilityDefinition (params/vault/tools/skills).
    definition: jsonb("definition").notNull(),

    // Bumped on upsert; lets eve push idempotently.
    version: integer("version").notNull().default(1),

    // Provenance: "eve-sync" / "manual".
    source: text("source"),
    createdBy: text("created_by"),

    // Soft delete (DELETE route sets these; loader filters on deletedAt IS NULL).
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedBy: text("deleted_by"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    // One live pod-wide template per key.
    keyPodWideUnique: uniqueIndex("uniq_capability_templates_key_pod_wide")
      .on(table.key)
      .where(sql`workspace_id IS NULL AND deleted_at IS NULL`),
    keyIdx: index("idx_capability_templates_key").on(table.key),
    workspaceIdIdx: index("idx_capability_templates_workspace_id").on(
      table.workspaceId
    ),
  })
);

export type CapabilityTemplate = typeof capabilityTemplates.$inferSelect;
export type NewCapabilityTemplate = typeof capabilityTemplates.$inferInsert;
