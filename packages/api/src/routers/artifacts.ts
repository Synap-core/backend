/**
 * Artifacts tRPC Router
 *
 * The artifact ledger — lifecycle + provenance on cell instances.
 * Phase 1 of the Desk & Artifact System (see desk-artifact-system.mdx §8).
 *
 * An artifact references an existing renderable object (view / cell / document /
 * entity / url) and tracks its lifecycle: working → kept | swept.
 */

import { z } from "zod";
import { router, protectedProcedure, workspaceProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { getDb, eq, and, desc, artifacts } from "@synap/database";
import { assertWorkspaceWrite } from "../utils/workspace-write-access.js";
import { AccessContext, scopedDb } from "../access/index.js";
import type { Lens } from "../access/context.js";
import { ScopeFilterShape, resolveScope } from "../utils/scope-filter.js";
import { emitHubRealtimeEvent } from "../utils/domain-event-bridge.js";
import type { Artifact } from "@synap/database/schema";
import { SESSION_ARTIFACT_KINDS } from "../services/focus-sessions/record-session-artifact.js";

// ── Shared input schemas ────────────────────────────────────────────────────

const artifactStateSchema = z.enum(["working", "kept", "swept"]);
const artifactPlacementSchema = z.enum(["desk", "home", "sidebar", "library"]);
// DERIVED from the ledger column, never re-typed beside it. The hand-written
// literal here listed five kinds while `artifacts.kind` has carried `automation`
// and `playbook` since 0246 — a mirrored enum that had already drifted.
const artifactKindSchema = z.enum(SESSION_ARTIFACT_KINDS);
const artifactOriginKindSchema = z.enum([
  "user",
  "agent",
  "deeplink",
  "system",
]);

// ── Shared list input + query ─────────────────────────────────────────────────

/** Non-scope filters common to both list doors. */
const artifactListFilters = {
  state: artifactStateSchema.optional(),
  placement: artifactPlacementSchema.optional(),
  sessionId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(100).default(50),
} as const;

const artifactListInputSchema = z.object(artifactListFilters);
type ArtifactListInput = z.infer<typeof artifactListInputSchema>;

/**
 * The shared read. Starts from the USER FLOOR (the artifacts visibility rule
 * in access/registry.ts) and lets the workspace lens NARROW within it — the
 * floor is ALWAYS applied, a lens only narrows, an empty/absent lens never
 * matches zero. Goes through scopedDb's registered predicate so every door
 * gets the same structural floor.
 */
export async function queryArtifacts(
  ctx: {
    userId?: string | null;
    agentUserId?: string | null;
    isHubProtocol?: boolean;
  },
  input: ArtifactListInput,
  workspaceLens: Lens
) {
  const database = await getDb();
  const visibility = scopedDb(
    AccessContext.from(ctx).withLens(workspaceLens)
  ).predicate(artifacts);

  const rows = await database
    .select()
    .from(artifacts)
    .where(
      and(
        visibility,
        input.state !== undefined
          ? eq(artifacts.state, input.state)
          : undefined,
        input.placement !== undefined
          ? eq(artifacts.placement, input.placement)
          : undefined,
        input.sessionId !== undefined
          ? eq(artifacts.sessionId, input.sessionId)
          : undefined
      )
    )
    .orderBy(desc(artifacts.createdAt))
    .limit(input.limit);

  return rows;
}

// ── Router ──────────────────────────────────────────────────────────────────

export const artifactsRouter = router({
  /**
   * THE one door for artifacts (collapses the old list/listAll split).
   *
   * The visibility rule's user floor = every workspace the user belongs to,
   * PLUS the caller's OWN pod-personal (NULL-workspace) rows. A NULL-workspace
   * artifact is NOT a pod-wide global: the ledger is private data, so the rule
   * keeps an owner floor on those rows (`access/registry.ts`). The workspace
   * lens then NARROWS within that floor:
   *   - no `workspaceId` (and no active-ws header) → ALL my artifacts
   *   - active-ws header / a `workspaceId` → that workspace's artifacts
   *   - `workspaceId: null` → my pod-personal rows only
   *   - `workspaceId: [a, b]` → those workspaces (union)
   * No project axis (the artifacts table has no project/anchor column).
   */
  list: protectedProcedure
    .input(
      z.object({
        workspaceId: ScopeFilterShape.workspaceId,
        ...artifactListFilters,
      })
    )
    .query(async ({ ctx, input }) => {
      const { workspaceLens } = resolveScope(ctx, input);
      return queryArtifacts(ctx, input, workspaceLens);
    }),

  /**
   * Get a single artifact by ID.
   * Uses scopedDb.findFirst to enforce workspace visibility structurally.
   */
  get: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const row = await scopedDb(AccessContext.from(ctx)).findFirst<Artifact>(
        artifacts,
        { where: eq(artifacts.id, input.id) }
      );

      if (!row) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Artifact ${input.id} not found`,
        });
      }

      return row;
    }),

  /**
   * Create a new artifact in the working state.
   * Uses workspaceProcedure so workspace membership is validated upfront.
   */
  create: workspaceProcedure
    .input(
      z.object({
        kind: artifactKindSchema,
        refId: z.string().optional(),
        cellKey: z.string().optional(),
        props: z.unknown().optional(),
        title: z.string().min(1).max(500),
        originKind: artifactOriginKindSchema.default("user"),
        actorId: z.string().optional(),
        sessionId: z.string().uuid().optional(),
        placement: artifactPlacementSchema.default("desk"),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const database = await getDb();
      const [created] = await database
        .insert(artifacts)
        .values({
          workspaceId: ctx.workspaceId,
          userId: ctx.userId,
          kind: input.kind,
          refId: input.refId ?? null,
          cellKey: input.cellKey ?? null,
          props: input.props ?? null,
          title: input.title,
          originKind: input.originKind,
          actorId: input.actorId ?? null,
          sessionId: input.sessionId ?? null,
          state: "working",
          placement: input.placement,
        })
        .returning();

      emitHubRealtimeEvent({
        eventType: "artifact.changed.completed",
        subjectId: created.id,
        userId: ctx.userId,
        data: {
          id: created.id,
          workspaceId: created.workspaceId,
          state: created.state,
          placement: created.placement,
          kind: created.kind,
          title: created.title,
        },
      });

      return created as Artifact;
    }),

  /**
   * Transition an artifact's state (working → kept | swept) and optionally
   * change its placement.
   *
   * ALWAYS loads the row first and gates on the LOADED row's workspaceId —
   * never trusts a caller-supplied workspaceId (write-gate rule).
   */
  setState: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        state: artifactStateSchema,
        placement: artifactPlacementSchema.optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const database = await getDb();

      // Load row first — ownership check via userId
      const existing = await database.query.artifacts.findFirst({
        where: and(
          eq(artifacts.id, input.id),
          eq(artifacts.userId, ctx.userId)
        ),
      });

      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Artifact ${input.id} not found`,
        });
      }

      // Gate write on the loaded row's workspaceId (not a caller-supplied value).
      // `ownerId` is REQUIRED, not decorative: since 0245 `workspaceId` may be
      // NULL (a pod-personal artifact), and without an owner to fall back on
      // `assertWorkspaceWrite` treats a NULL-workspace row as system-managed and
      // throws FORBIDDEN — so every pod-personal artifact was un-keepable,
      // un-sweepable and un-re-placeable by the very user who owns it.
      await assertWorkspaceWrite(database, ctx.userId, {
        workspaceId: existing.workspaceId,
        ownerId: existing.userId,
      });

      const now = new Date();
      const set: Partial<typeof artifacts.$inferInsert> = {
        state: input.state,
        updatedAt: now,
      };

      if (input.placement !== undefined) {
        set.placement = input.placement;
      }
      if (input.state === "kept" && existing.state !== "kept") {
        set.keptAt = now;
      }
      if (input.state === "swept" && existing.state !== "swept") {
        set.sweptAt = now;
      }

      const [updated] = await database
        .update(artifacts)
        .set(set)
        .where(eq(artifacts.id, input.id))
        .returning();

      emitHubRealtimeEvent({
        eventType: "artifact.changed.completed",
        subjectId: updated.id,
        userId: ctx.userId,
        data: {
          id: updated.id,
          workspaceId: updated.workspaceId,
          state: updated.state,
          placement: updated.placement,
          kind: updated.kind,
          title: updated.title,
        },
      });

      return updated as Artifact;
    }),
});
