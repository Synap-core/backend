/**
 * Artifact Ledger Schema
 *
 * An artifact = a reference to an existing renderable object (view / cell /
 * document / entity / url / automation / playbook) + lifecycle metadata
 * (provenance, placement, state).
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
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const artifacts = pgTable(
  "artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * Workspace this artifact is filed under, or NULL for a POD-PERSONAL
     * artifact (0245).
     *
     * Nullable because `focus_sessions.workspaceId` is: a pod-personal session
     * produces pod-personal outputs, and a NOT NULL here made the session
     * room's output ledger refuse the majority of sessions outright. NULL rows
     * are owner-private — the access-layer rule floors them to `userId`, the
     * same way `entities` / `documents` / `channels` treat an unfiled row.
     */
    workspaceId: text("workspace_id"),
    /** Owner — the human (or agent user) who created it. */
    userId: text("user_id").notNull(),

    // ── What it references ─────────────────────────────────────────────────
    /**
     * What kind of renderable object this artifact references.
     *
     * `automation` and `playbook` (0246) are outputs like any other: a session
     * whose whole point was "set up the follow-up rule" produced an automation,
     * and the room could not record it. The COLUMN is plain `text` with no CHECK
     * constraint, so widening is a TypeScript change — but it is still the
     * single source the door enums derive from (`SESSION_ARTIFACT_KINDS`), so
     * adding a value here is what widens both write doors.
     */
    kind: text("kind", {
      enum: [
        "view",
        "cell",
        "document",
        "entity",
        "url",
        "automation",
        "playbook",
      ],
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
    /**
     * IDEMPOTENCY for the session output ledger (0246).
     *
     * Both attach-output doors did a plain INSERT, so a retry after a failed
     * request — or a double-click on "record this as an output" — wrote a
     * SECOND provenance row claiming the same fact, and the session room then
     * listed the same object twice.
     *
     * The declared-slot claim is PART OF THE KEY, not collapsed out of it: the
     * same document may legitimately satisfy two different `expectedOutputs`
     * labels, and a key of (session, kind, ref) alone would make the second
     * claim a silent no-op. `COALESCE(..., '')` because a unique index treats
     * NULLs as distinct, which would exempt the common unlabelled case — the
     * exact rows this index exists to dedupe.
     *
     * Expression index ⇒ `ON CONFLICT` cannot target it cleanly through
     * drizzle (same note as `automations_workspace_name_active_uq`), so the
     * writer uses a bare `.onConflictDoNothing()` and re-selects the winner.
     */
    sessionRefUniq: uniqueIndex("artifacts_session_ref_unique")
      .on(
        table.sessionId,
        table.kind,
        table.refId,
        sql`COALESCE(${table.props}->>'expectedLabel', '')`
      )
      .where(
        sql`${table.sessionId} IS NOT NULL AND ${table.refId} IS NOT NULL`
      ),
  })
);

export type Artifact = typeof artifacts.$inferSelect;
export type NewArtifact = typeof artifacts.$inferInsert;
export const insertArtifactSchema = createInsertSchema(artifacts);
export const selectArtifactSchema = createSelectSchema(artifacts);
