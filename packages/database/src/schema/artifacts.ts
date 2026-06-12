/**
 * Artifact Ledger Schema
 *
 * An artifact = a reference to an existing renderable object (view / cell /
 * document / entity / url) + lifecycle metadata (provenance, placement, state).
 *
 * This is NOT a new rendering object. Everything already renders through the
 * cell registry. The only new layer is lifecycle + provenance on cell instances.
 *
 * Lifecycle: working → kept | swept
 * Placement: desk | home | sidebar | library
 *
 * See design doc: team/platform/desk-artifact-system.mdx §3, §8 Phase 1
 */

import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export enum ArtifactKind {
  VIEW = "view",
  CELL = "cell",
  DOCUMENT = "document",
  ENTITY = "entity",
  URL = "url",
}

export enum ArtifactOriginKind {
  USER = "user",
  AGENT = "agent",
  DEEPLINK = "deeplink",
  SYSTEM = "system",
}

export enum ArtifactState {
  WORKING = "working",
  KEPT = "kept",
  SWEPT = "swept",
}

export enum ArtifactPlacement {
  DESK = "desk",
  HOME = "home",
  SIDEBAR = "sidebar",
  LIBRARY = "library",
}

export const artifacts = pgTable(
  "artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Workspace this artifact is scoped to. */
    workspaceId: text("workspace_id").notNull(),
    /** Owner — the human (or agent user) who created it. */
    userId: text("user_id").notNull(),

    // ── What it references ─────────────────────────────────────────────────
    /** What kind of renderable object this artifact references. */
    kind: text("kind", {
      enum: ["view", "cell", "document", "entity", "url"],
    }).notNull(),
    /**
     * ID of the underlying view / document / entity / url.
     * Null for inline cell artifacts that have no persistent backing object.
     */
    refId: text("ref_id"),
    /**
     * Cell type key (e.g. "table-view", "ai-companion") for cell artifacts.
     * Null for non-cell artifacts.
     */
    cellKey: text("cell_key"),
    /** Cell config / URL / entity props — artifact-specific JSONB payload. */
    props: jsonb("props"),
    /** Display title for the artifact (command palette, recap deck, etc.) */
    title: text("title").notNull(),

    // ── Provenance ─────────────────────────────────────────────────────────
    /** Who produced this artifact. Default 'user'. */
    originKind: text("origin_kind", {
      enum: ["user", "agent", "deeplink", "system"],
    })
      .notNull()
      .default("user"),
    /** Agent user ID when originKind = 'agent'. */
    actorId: text("actor_id"),
    /** Focus session that produced this artifact, when applicable. */
    sessionId: uuid("session_id"),

    // ── Lifecycle ──────────────────────────────────────────────────────────
    /** Current lifecycle state. */
    state: text("state", {
      enum: ["working", "kept", "swept"],
    })
      .notNull()
      .default("working"),
    /** Where this artifact is currently placed. */
    placement: text("placement", {
      enum: ["desk", "home", "sidebar", "library"],
    })
      .notNull()
      .default("desk"),
    /** Set when transitioning to 'kept'. */
    keptAt: timestamp("kept_at", { withTimezone: true }),
    /** Set when transitioning to 'swept'. */
    sweptAt: timestamp("swept_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    workspaceStateIdx: index("idx_artifacts_workspace_state").on(
      table.workspaceId,
      table.state
    ),
    sessionIdIdx: index("idx_artifacts_session_id").on(table.sessionId),
    userIdIdx: index("idx_artifacts_user_id").on(table.userId),
  })
);

export type Artifact = typeof artifacts.$inferSelect;
export type NewArtifact = typeof artifacts.$inferInsert;
export const insertArtifactSchema = createInsertSchema(artifacts);
export const selectArtifactSchema = createSelectSchema(artifacts);
