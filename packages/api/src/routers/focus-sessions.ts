/**
 * Focus Sessions tRPC Router
 *
 * Goal-bound user work sessions — workflow-side, not data-side.
 * Uses `protectedProcedure` (Kratos session cookie) since sessions
 * span workspaces and are owned by the authenticated user.
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { db, eq, and, desc, focusSessions } from "@synap/database";
import type { FocusSession } from "@synap/database/schema";
import { getLinksFor, createLinks } from "../services/links/links-service.js";
import { checkPermissionOrPropose } from "../utils/permission-check.js";
import { emitSideEffects } from "@synap/events";

// ── Shared input fragment ──────────────────────────────────────────────────

const expectedOutputItemSchema = z.object({
  kind: z.string(),
  label: z.string(),
  icon: z.string().optional(),
});

const statusFilterSchema = z
  .enum(["active", "paused", "closed", "all"])
  .default("all");

// ── Links sub-router (read-only) ───────────────────────────────────────────

const sessionLinksRouter = router({
  /**
   * Return all `links` edges where fromType='session' AND fromId=sessionId,
   * plus reverse edges where toType='session' AND toId=sessionId.
   *
   * Groups results by `linkType` so the frontend can render "tools used",
   * "skills used", "produced entities", "targets", etc. without reshaping.
   *
   * Scoping: reuses getLinksFor which applies userVisibleWhere (pod-wide OR
   * workspace the user belongs to). The session ownership check mirrors the
   * get procedure — we verify ownership before exposing the link graph.
   */
  bySession: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      // Verify session ownership before exposing its link graph.
      const session = await db.query.focusSessions.findFirst({
        where: and(
          eq(focusSessions.id, input.sessionId),
          eq(focusSessions.userId, ctx.userId)
        ),
      });

      if (!session) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Focus session ${input.sessionId} not found`,
        });
      }

      const edges = await getLinksFor(ctx.userId, "session", input.sessionId);

      // Group by linkType for convenient frontend consumption.
      const grouped: Record<string, typeof edges> = {};
      for (const edge of edges) {
        const key = edge.linkType;
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(edge);
      }

      return { edges, grouped };
    }),
});

// ── Router ─────────────────────────────────────────────────────────────────

export const focusSessionsRouter = router({
  links: sessionLinksRouter,
  /**
   * List focus sessions for a specific workspace (most recent first).
   */
  list: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        status: statusFilterSchema,
        limit: z.number().int().min(1).max(50).default(20),
      })
    )
    .query(async ({ ctx, input }) => {
      const conditions = [
        eq(focusSessions.workspaceId, input.workspaceId),
        eq(focusSessions.userId, ctx.userId),
      ];

      if (input.status !== "all") {
        conditions.push(eq(focusSessions.status, input.status));
      }

      return db
        .select()
        .from(focusSessions)
        .where(and(...conditions))
        .orderBy(desc(focusSessions.startedAt))
        .limit(input.limit);
    }),

  /**
   * List focus sessions across ALL workspaces for the authenticated user.
   * Used by Eve OS and cross-workspace surfaces.
   */
  listAll: protectedProcedure
    .input(
      z.object({
        status: statusFilterSchema,
        limit: z.number().int().min(1).max(50).default(20),
      })
    )
    .query(async ({ ctx, input }) => {
      const conditions = [eq(focusSessions.userId, ctx.userId)];

      if (input.status !== "all") {
        conditions.push(eq(focusSessions.status, input.status));
      }

      return db
        .select()
        .from(focusSessions)
        .where(and(...conditions))
        .orderBy(desc(focusSessions.startedAt))
        .limit(input.limit);
    }),

  /**
   * Get a single focus session by ID.
   * Scoped to the authenticated user — cannot read another user's session.
   */
  get: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const row = await db.query.focusSessions.findFirst({
        where: and(
          eq(focusSessions.id, input.id),
          eq(focusSessions.userId, ctx.userId)
        ),
      });

      if (!row) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Focus session ${input.id} not found`,
        });
      }

      return row;
    }),

  /**
   * Get a focus session by IS correlation ID.
   * Used by IS to link proposals and events back to the session.
   */
  getByCorrelationId: protectedProcedure
    .input(z.object({ correlationId: z.string() }))
    .query(async ({ ctx, input }) => {
      const row = await db.query.focusSessions.findFirst({
        where: and(
          eq(focusSessions.correlationId, input.correlationId),
          eq(focusSessions.userId, ctx.userId)
        ),
      });

      if (!row) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `No focus session found for correlationId ${input.correlationId}`,
        });
      }

      return row;
    }),

  /**
   * Create a new focus session.
   */
  create: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        goal: z.string().min(1).max(2000),
        templateId: z.string().optional(),
        expectedOutputs: z.array(expectedOutputItemSchema).default([]),
        channelId: z.string().uuid().optional(),
        agentIds: z.array(z.string()).default([]),
        // Project this session belongs to (project-centric-scope). A session
        // implies its project on the FE lens; persisted here so it survives.
        projectId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const [created] = await db
        .insert(focusSessions)
        .values({
          workspaceId: input.workspaceId,
          userId: ctx.userId,
          goal: input.goal,
          templateId: input.templateId ?? null,
          expectedOutputs: input.expectedOutputs,
          channelId: input.channelId ?? null,
          agentIds: input.agentIds,
          projectId: input.projectId ?? null,
          status: "active",
        })
        .returning();

      return created as FocusSession;
    }),

  /**
   * Update an existing focus session.
   * Caller must own the session (userId check).
   */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        status: z.enum(["active", "paused", "closed"]).optional(),
        progress: z.number().int().min(0).max(100).optional(),
        channelId: z.string().uuid().optional(),
        correlationId: z.string().optional(),
        goal: z.string().min(1).max(2000).optional(),
        agentIds: z.array(z.string()).optional(),
        expectedOutputs: z.array(expectedOutputItemSchema).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Load first to verify ownership
      const existing = await db.query.focusSessions.findFirst({
        where: and(
          eq(focusSessions.id, input.id),
          eq(focusSessions.userId, ctx.userId)
        ),
      });

      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Focus session ${input.id} not found`,
        });
      }

      const { id: _id, ...patch } = input;

      // Build only the fields that were supplied
      const set: Partial<typeof focusSessions.$inferInsert> = {
        updatedAt: new Date(),
      };

      if (patch.status !== undefined) set.status = patch.status;
      if (patch.progress !== undefined) set.progress = patch.progress;
      if (patch.channelId !== undefined) set.channelId = patch.channelId;
      if (patch.correlationId !== undefined)
        set.correlationId = patch.correlationId;
      if (patch.goal !== undefined) set.goal = patch.goal;
      if (patch.agentIds !== undefined) set.agentIds = patch.agentIds;
      if (patch.expectedOutputs !== undefined)
        set.expectedOutputs = patch.expectedOutputs;

      // If transitioning to closed, stamp closedAt
      if (patch.status === "closed" && existing.status !== "closed") {
        set.closedAt = new Date();
      }

      const [updated] = await db
        .update(focusSessions)
        .set(set)
        .where(eq(focusSessions.id, input.id))
        .returning();

      return updated as FocusSession;
    }),

  /**
   * Close a focus session.
   */
  close: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await db.query.focusSessions.findFirst({
        where: and(
          eq(focusSessions.id, input.id),
          eq(focusSessions.userId, ctx.userId)
        ),
      });

      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Focus session ${input.id} not found`,
        });
      }

      if (existing.status === "closed") {
        return existing;
      }

      const now = new Date();
      const [closed] = await db
        .update(focusSessions)
        .set({ status: "closed", closedAt: now, updatedAt: now })
        .where(eq(focusSessions.id, input.id))
        .returning();

      return closed as FocusSession;
    }),

  /**
   * Grant a capability (tool/skill/command) to a live session — the runtime
   * counterpart to a playbook's static grants. Writes `session --grants-->
   * {capability}` so the session room's "add tool/skill" affordance has a
   * backing edge. Gated by checkPermissionOrPropose (AI grants route to a
   * reviewable proposal). Idempotent via the links unique-edge index.
   */
  grantCapability: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().uuid(),
        capabilityKind: z.enum(["tool", "skill", "command"]),
        capabilityId: z.string(),
        agentUserId: z.string().uuid().optional(),
        source: z.string().optional(),
        reasoning: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Load by id ONLY, then gate on the loaded row's workspace.
      const session = await db.query.focusSessions.findFirst({
        where: eq(focusSessions.id, input.sessionId),
      });
      if (!session) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Focus session ${input.sessionId} not found`,
        });
      }

      // Guard the latent project-scope hole: a session with a null workspace
      // would make checkPermissionOrPropose treat the grant as a personal
      // resource and AUTO-GRANT it, skipping workspace governance. No path
      // creates such a session today (P4b), so fail loud rather than silently
      // bypass — cross-workspace grant governance is not yet defined.
      if (!session.workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Project-scoped sessions (no workspace) cannot grant capabilities yet.",
        });
      }

      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: session.workspaceId,
        subjectType: "focus_session",
        action: "grant_capability",
        source: input.source,
        reasoning: input.reasoning,
        data: {
          sessionId: input.sessionId,
          capabilityKind: input.capabilityKind,
          capabilityId: input.capabilityId,
        },
      });
      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return {
          granted: false,
          status: "proposed" as const,
          proposalId: perm.proposalId,
        };
      }

      await createLinks([
        {
          workspaceId: session.workspaceId,
          fromType: "session",
          fromId: session.id,
          toType: input.capabilityKind,
          toId: input.capabilityId,
          linkType: "grants",
          metadata: { grantedAt: new Date().toISOString() },
        },
      ]);

      emitSideEffects({
        subjectType: "focus_session",
        action: "grant_capability",
        subjectId: session.id,
        userId: ctx.userId,
        workspaceId: session.workspaceId,
        data: {
          capabilityKind: input.capabilityKind,
          capabilityId: input.capabilityId,
        },
      });

      return { granted: true, status: "granted" as const };
    }),
});
