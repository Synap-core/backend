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
import {
  db,
  eq,
  and,
  desc,
  inArray,
  isNull,
  focusSessions,
  capabilities,
  vaultGrants,
  assertGrantScoped,
} from "@synap/database";
import type { FocusSession } from "@synap/database/schema";
import {
  getLinksFor,
  createLinks,
  getCapabilityMemberParts,
} from "../services/links/links-service.js";
import { userVisibleWhere } from "../utils/user-visible-where.js";
import { checkPermissionOrPropose } from "../utils/permission-check.js";
import { emitSideEffects } from "@synap/events";
import {
  ScopeFilterShape,
  resolveScope,
  type ResolvedScope,
} from "../utils/scope-filter.js";
import { requireUserId } from "../utils/user-scoped.js";

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

// ── Shared read body ─────────────────────────────────────────────────────────

/**
 * THE one query body for the focus-sessions read door. focus_sessions is
 * user-owned (`userId`), so the floor is `eq(userId)` — every door starts there.
 * The lenses then only NARROW within the user's own rows:
 *   - workspace lens: `null` → pod-personal (workspaceId IS NULL); `"<id>"` →
 *     that workspace; `string[]` (non-empty) → that SET; `undefined`/`[]` → no
 *     narrow (the floor — all the user's sessions across workspaces).
 *   - project lens: `"<id>"`/`string[]` narrows on the session's own projectId
 *     column (sessions carry projectId directly — a simple eq/inArray, NOT
 *     exposureLensWhere); `null`/`undefined`/`[]` → no narrow.
 * An empty array never narrows (never matches-zero); a lens can only restrict.
 */
function queryUserSessions(
  userId: string | null | undefined,
  { workspaceLens, projectLens }: ResolvedScope,
  status: z.infer<typeof statusFilterSchema>,
  limit: number
) {
  const conditions = [eq(focusSessions.userId, requireUserId(userId))];

  // Workspace lens narrows within the user's own rows (the floor is userId).
  if (workspaceLens === null) {
    conditions.push(isNull(focusSessions.workspaceId));
  } else if (Array.isArray(workspaceLens)) {
    if (workspaceLens.length > 0) {
      conditions.push(inArray(focusSessions.workspaceId, workspaceLens));
    }
  } else if (typeof workspaceLens === "string") {
    conditions.push(eq(focusSessions.workspaceId, workspaceLens));
  }

  // Project lens narrows on the session's own projectId column.
  if (Array.isArray(projectLens)) {
    if (projectLens.length > 0) {
      conditions.push(inArray(focusSessions.projectId, projectLens));
    }
  } else if (typeof projectLens === "string") {
    conditions.push(eq(focusSessions.projectId, projectLens));
  }

  if (status !== "all") {
    conditions.push(eq(focusSessions.status, status));
  }

  return db
    .select()
    .from(focusSessions)
    .where(and(...conditions))
    .orderBy(desc(focusSessions.startedAt))
    .limit(limit);
}

// ── Router ─────────────────────────────────────────────────────────────────

export const focusSessionsRouter = router({
  links: sessionLinksRouter,
  /**
   * THE one door for focus sessions (collapses the old list/listAll split).
   *
   * Floor = `eq(userId)` (sessions are user-owned). No lens → ALL the user's
   * sessions across workspaces, INCLUDING project-only sessions (null
   * workspaceId). A workspace and/or project lens only NARROWS:
   *   - no `workspaceId` (and no active-ws header) → all my sessions
   *   - active-ws header / a `workspaceId` → that workspace's sessions
   *   - `workspaceId: null` → pod-personal (workspaceId IS NULL) sessions
   *   - `workspaceId: [a, b]` → those workspaces (union)
   *   - `projectId: "<id>"` / `[a, b]` → that project (across workspaces)
   * Most recent first.
   */
  list: protectedProcedure
    .input(
      z.object({
        workspaceId: ScopeFilterShape.workspaceId,
        projectId: ScopeFilterShape.projectId,
        status: statusFilterSchema,
        limit: z.number().int().min(1).max(50).default(20),
      })
    )
    .query(async ({ ctx, input }) => {
      const scope = resolveScope(ctx, input);
      return queryUserSessions(ctx.userId, scope, input.status, input.limit);
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
        // First-class stages: advance the active playbook stage (PlaybookStage.key).
        currentStage: z.string().min(1).optional(),
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
      if (patch.currentStage !== undefined)
        set.currentStage = patch.currentStage;

      // If transitioning to closed, stamp closedAt
      if (patch.status === "closed" && existing.status !== "closed") {
        set.closedAt = new Date();
      }

      const [updated] = await db
        .update(focusSessions)
        .set(set)
        .where(eq(focusSessions.id, input.id))
        .returning();

      // Stage transition side-effect: when the active stage actually changes,
      // emit `focus_session.stage_changed` so automations can react to the
      // transition (and filter on toStage). No-op for stageless playbooks.
      if (
        patch.currentStage !== undefined &&
        patch.currentStage !== existing.currentStage
      ) {
        emitSideEffects({
          subjectType: "focus_session",
          action: "stage_changed",
          subjectId: updated.id,
          userId: ctx.userId,
          workspaceId: existing.workspaceId,
          data: {
            sessionId: updated.id,
            subjectId: existing.subjectEntityId,
            playbookId: existing.playbookId,
            fromStage: existing.currentStage,
            toStage: updated.currentStage,
            workspaceId: existing.workspaceId,
            userId: ctx.userId,
          },
        });
      }

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
        // "capability" grants a CONTAINER — expanded to per-part enforcement
        // rows below (the gate stays per-tool/skill/command).
        capabilityKind: z.enum(["tool", "skill", "command", "capability"]),
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

      // Write the ENFORCEMENT row alongside the `links{grants}` provenance edge
      // (G1 §4 convergence): the link is descriptive (graph view); the
      // capability_grants row is what a delegated capability-execution gate
      // consults at run time. Scope it to the session's workspace (and the
      // specific agent when one was named). Session-grants are 'session' scope
      // (unlimited within the session window) with execMode='auto'. The
      // canonical wildcard firewall runs here too — a grant must bind to an
      // agent and/or a workspace.
      assertGrantScoped({
        grantedTo: input.agentUserId ?? null,
        workspaceId: session.workspaceId,
      });
      // Enforcement rows are ALWAYS per runnable part — the gate is per-(kind,id)
      // and has no notion of a container. Granting a "capability" expands to one
      // vault_grants row per member part; a direct tool/skill/command grant is
      // the single part. (An empty container grants nothing enforceable yet; new
      // parts added later are not retroactively granted.)
      // For a capability CONTAINER grant, confirm the caller can actually SEE
      // the container before fanning its members out into grant rows — the
      // fan-out helper is a pure graph lookup with no visibility filter, so the
      // check belongs here (mirrors `containers.get`'s userVisibleWhere gate).
      if (input.capabilityKind === "capability") {
        const [container] = await db
          .select({ id: capabilities.id })
          .from(capabilities)
          .where(
            and(
              eq(capabilities.id, input.capabilityId),
              userVisibleWhere(capabilities.workspaceId, ctx.userId)
            )
          );
        if (!container) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Capability not found",
          });
        }
      }

      const grantParts =
        input.capabilityKind === "capability"
          ? await getCapabilityMemberParts([input.capabilityId])
          : [{ kind: input.capabilityKind, id: input.capabilityId }];
      if (grantParts.length > 0) {
        await db.insert(vaultGrants).values(
          grantParts.map((p) => ({
            grantableType: p.kind,
            grantableId: p.id,
            execMode: "auto" as const,
            grantedTo: input.agentUserId ?? null,
            workspaceId: session.workspaceId,
            scope: "session" as const,
            createdBy: ctx.userId,
          }))
        );
      }

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
