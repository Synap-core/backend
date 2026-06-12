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
import { emitHubRealtimeEvent } from "../utils/domain-event-bridge.js";
import type { Artifact } from "@synap/database/schema";

// ── Shared input schemas ────────────────────────────────────────────────────

const artifactStateSchema = z.enum(["working", "kept", "swept"]);
const artifactPlacementSchema = z.enum(["desk", "home", "sidebar", "library"]);
const artifactKindSchema = z.enum([
  "view",
  "cell",
  "document",
  "entity",
  "url",
]);
const artifactOriginKindSchema = z.enum([
  "user",
  "agent",
  "deeplink",
  "system",
]);

// ── Router ──────────────────────────────────────────────────────────────────

export const artifactsRouter = router({
  /**
   * List artifacts for the active workspace, optionally filtered by state,
   * placement, or session.
   *
   * Uses scopedDb.predicate (workspace visibility rule) + db.select() to
   * compose arbitrary optional filters — same pattern as automations.list.
   */
  list: workspaceProcedure
    .input(
      z.object({
        state: artifactStateSchema.optional(),
        placement: artifactPlacementSchema.optional(),
        sessionId: z.string().uuid().optional(),
        limit: z.number().int().min(1).max(100).default(50),
      })
    )
    .query(async ({ ctx, input }) => {
      const database = await getDb();
      const visibility = scopedDb(AccessContext.from(ctx)).predicate(artifacts);

      const rows = await database
        .select()
        .from(artifacts)
        .where(
          and(
            visibility,
            eq(artifacts.workspaceId, ctx.workspaceId),
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
        eventType: "artifact:changed",
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

      // Gate write on the loaded row's workspaceId (not a caller-supplied value)
      await assertWorkspaceWrite(database, ctx.userId, {
        workspaceId: existing.workspaceId,
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
        eventType: "artifact:changed",
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
