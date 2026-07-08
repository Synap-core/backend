/**
 * Entity Facets Schema — Kind + Facets
 *
 * Entities carry one primary "kind" (profileId, unchanged) plus zero or more
 * additive "facets": role-profiles (profiles.profileKind = 'role') attached
 * via this table without changing the entity's kind. e.g. a Person entity can
 * carry an "investor" facet and a "speaker" facet at the same time.
 *
 * Soft-delete only (`deletedAt`) — `FacetRepository.detach()` never hard
 * deletes, so a re-attach after detach is a normal, idempotent-friendly flow.
 */

import {
  pgTable,
  uuid,
  timestamp,
  text,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { entities } from "./entities.js";
import { profiles } from "./profiles.js";
import type { ProvenanceKind } from "./provenance.js";

export const entityFacets = pgTable(
  "entity_facets",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    entityId: uuid("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),

    // The attached role-profile (profiles.profileKind = 'role').
    profileId: uuid("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "restrict" }),

    // Visibility floor — mirrors relations.userId semantics.
    userId: text("user_id").notNull(),
    // Nullable — null means pod-wide (lens scoping mirrors entities/relations).
    workspaceId: uuid("workspace_id"),

    // Optional disambiguator when the same role-profile is attached more than
    // once in different contexts (e.g. "speaker" at two different events).
    contextEntityId: uuid("context_entity_id").references(() => entities.id, {
      onDelete: "set null",
    }),

    status: text("status"),

    // Validated against the role-profile's effective properties.
    properties: jsonb("properties").default("{}").notNull(),
    metadata: jsonb("metadata").default("{}").notNull(),

    // Provenance — mirrors entities/documents/relations (Wave B3, 0107).
    createdByKind: text("created_by_kind").$type<ProvenanceKind>(),
    createdByUserId: text("created_by_user_id"),
    agentUserId: text("agent_user_id"),
    sourceProposalId: uuid("source_proposal_id"),
    correlationId: uuid("correlation_id"),

    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", { mode: "date", withTimezone: true }),
  },
  (table) => ({
    entityIdIdx: index("entity_facets_entity_id_idx")
      .on(table.entityId)
      .where(sql`${table.deletedAt} IS NULL`),
    profileWorkspaceIdx: index("entity_facets_profile_workspace_idx")
      .on(table.profileId, table.workspaceId)
      .where(sql`${table.deletedAt} IS NULL`),
    // Re-attach after soft-detach must succeed — partial unique index only
    // covers live rows. Matches migration 0174's COALESCE-sentinel index.
    entityProfileCtxWsUniq: uniqueIndex(
      "entity_facets_entity_profile_ctx_ws_uniq"
    )
      .on(
        table.entityId,
        table.profileId,
        sql`COALESCE(${table.contextEntityId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
        sql`COALESCE(${table.workspaceId}, '00000000-0000-0000-0000-000000000000'::uuid)`
      )
      .where(sql`${table.deletedAt} IS NULL`),
  })
);

export type EntityFacet = typeof entityFacets.$inferSelect;
export type NewEntityFacet = typeof entityFacets.$inferInsert;
