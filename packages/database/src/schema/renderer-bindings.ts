/**
 * Renderer Bindings — the ONE store for "which renderer answers for this
 * subject", layered ABOVE the three legacy stores it is meant to replace:
 * `workspaces.settings.profileRenderers`, `profiles.defaultRenderers`, and the
 * deprecated `profiles.default_(list|detail|dashboard)_renderer` columns.
 *
 * INERT ON ARRIVAL. This wave lands the table and the READ rung only — there is
 * no writer, so the table is empty on every pod and
 * `ProfileResolutionService.getEffectiveRendererWithSource` resolves
 * byte-identically to before (every new rung misses; the legacy chain answers
 * unchanged). The write doors are a separate wave.
 *
 * A binding says: for this scope (one user, one workspace, or the whole pod),
 * for this subject (a whole KIND, or one object), for this content kind — use
 * this `RendererRef`. Resolution walks the ladder MOST SPECIFIC FIRST:
 *
 *   user·object → user·kind → workspace·object → workspace·kind
 *   → pod·object → pod·kind → (legacy stores) → hardcoded fallback
 *
 * `subject_kind` for an ENTITY is the PROFILE SLUG — deliberately the same key
 * existing callers already pass, so nothing has to learn a second vocabulary.
 * Every non-entity subject uses its object-nav kind string (`capability`,
 * `session`, `automation`, `playbook`, …), the same tokens `objectNavTarget`
 * routes on.
 *
 * Shape mirrors `governance_rules` (0215) and `config_settings` (0235): scoped
 * rows a specificity-ranking resolver reads, `revoked_at` as a tombstone rather
 * than a DELETE (so a revocation is history, not an erasure), and
 * `source_proposal_id` lineage for a row minted by a proposal approval.
 */

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspaces } from "./workspaces.js";
import type { RendererRef } from "../services/profile-resolution-service.js";

/**
 * Which scope a binding attaches at, ordered general → specific by the resolver
 * (pod < workspace < user). `user` is the personal override: MY choice for this
 * subject, invisible to everyone else.
 */
export const rendererBindingScopeEnum = pgEnum("renderer_binding_scope", [
  "user",
  "workspace",
  "pod",
]);
export const RENDERER_BINDING_SCOPES = rendererBindingScopeEnum.enumValues;
export type RendererBindingScope = (typeof RENDERER_BINDING_SCOPES)[number];

export const rendererBindings = pgTable(
  "renderer_bindings",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    scopeKind: rendererBindingScopeEnum("scope_kind").notNull(),
    // Set when scopeKind = 'user' (DB CHECK below).
    userId: text("user_id"),
    // Set when scopeKind = 'workspace' (DB CHECK below). Cascades — a deleted
    // workspace's bindings are meaningless, never orphans a resolver reads.
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "cascade",
    }),

    /** Entity subjects: the profile slug. Everything else: the object-nav kind. */
    subjectKind: text("subject_kind").notNull(),
    /** NULL = the whole KIND; a value pins one object. */
    subjectId: text("subject_id"),
    /**
     * A `ProfileRendererContentKind` (entity-detail | entity-card |
     * entity-profile | collection). Kept `text`, not a DB enum, so a new
     * content kind is a code change and not a migration — the same reasoning
     * 0238/0240 use for their vocabularies.
     */
    contentKind: text("content_kind").notNull(),

    /** The bound renderer itself (cell | view | declarative | …). */
    ref: jsonb("ref").$type<RendererRef>().notNull(),

    sourceProposalId: uuid("source_proposal_id"),

    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    revokedAt: timestamp("revoked_at", { mode: "date", withTimezone: true }),
  },
  (table) => ({
    /**
     * A 'user' row without an owner is unreadable by construction (the
     * visibility predicate floors user rows on `user_id`), and a 'workspace'
     * row without a workspace would silently widen into a pod row. Both are
     * refused at the DB rather than trusted to a write door.
     */
    scopeOwnerCheck: check(
      "renderer_bindings_scope_owner_check",
      sql`
      (scope_kind = 'user'      AND user_id IS NOT NULL) OR
      (scope_kind = 'workspace' AND workspace_id IS NOT NULL) OR
      (scope_kind = 'pod')
    `
    ),

    /**
     * ONE active binding per (scope, owner, subject, content kind). `coalesce`
     * over the nullable owner/subject columns because NULLs never collide in a
     * plain UNIQUE — without it two active whole-KIND pod bindings could
     * coexist and make resolution order-dependent.
     */
    activeUnique: uniqueIndex("renderer_bindings_active_unique")
      .on(
        table.scopeKind,
        sql`coalesce(${table.userId}, '')`,
        sql`coalesce(${table.workspaceId}::text, '')`,
        table.subjectKind,
        sql`coalesce(${table.subjectId}, '')`,
        table.contentKind
      )
      .where(sql`${table.revokedAt} IS NULL`),

    /** Resolver's primary lookup; the ladder ranks the matches in code. */
    subjectIdx: index("renderer_bindings_subject_idx")
      .on(table.subjectKind, table.contentKind)
      .where(sql`${table.revokedAt} IS NULL`),

    sourceProposalIdx: index("renderer_bindings_source_proposal_idx").on(
      table.sourceProposalId
    ),
  })
);

export type RendererBinding = typeof rendererBindings.$inferSelect;
export type NewRendererBinding = typeof rendererBindings.$inferInsert;
