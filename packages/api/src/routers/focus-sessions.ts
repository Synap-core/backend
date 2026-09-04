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
  isNotNull,
  focusSessions,
  proposals,
  users,
  capabilities,
  vaultGrants,
  assertGrantScoped,
} from "@synap/database";
import type { FocusSession } from "@synap/database/schema";
import {
  withParentSessionId,
  attachParentSessionIds,
} from "../services/focus-sessions/parent-lineage.js";
import { createFocusSession } from "../services/focus-sessions/create-session.js";
import { isTerminalSessionStatus } from "../services/focus-sessions/session-statuses.js";
import { listSessionOutputs } from "../services/focus-sessions/session-outputs.js";
import {
  addSessionBlocker,
  removeSessionBlocker,
  attachSessionEdges,
} from "../services/focus-sessions/session-blocked-by.js";
import {
  acceptFromTriage,
  discardFromTriage,
  attachTriage,
  projectTriage,
  triagePendingWhere,
  notTriagePendingWhere,
} from "../services/focus-sessions/triage.js";
import { spawnProjectFromSession } from "../services/focus-sessions/spawn-project.js";
import { revertConversion } from "../services/focus-sessions/session-conversion.js";
import { assertWorkspaceWrite } from "../utils/workspace-write-access.js";
import { getDb } from "@synap/database";
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
import { displayNameForUser } from "./proposals/display.js";

// ── Shared input fragment ──────────────────────────────────────────────────

const expectedOutputItemSchema = z.object({
  kind: z.string(),
  label: z.string(),
  icon: z.string().optional(),
  status: z.enum(["pending", "done"]).optional(),
});

const statusFilterSchema = z
  .enum([
    "active",
    "paused",
    "closed",
    "forming",
    "scheduled",
    "failed",
    "cancelled",
    "stale",
    "all",
  ])
  .default("all");

/**
 * WHICH SESSIONS. Orthogonal to `status`, which is the row's own lifecycle.
 *
 *   - `default` — the working list: everything EXCEPT sessions still waiting to
 *     be triaged. This is a deliberate behaviour change; an agent-opened session
 *     no longer appears in the working list until a person accepts it.
 *   - `triage`  — only those: agent/automation-originated, still open, not yet
 *     accepted (`services/focus-sessions/triage.ts` owns the predicate).
 *   - `all`     — the pre-triage behaviour, kept addressable so nothing has to
 *     union two calls to count everything.
 */
const sessionLensSchema = z
  .enum(["default", "triage", "all"])
  .default("default");
type SessionLens = z.infer<typeof sessionLensSchema>;

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
  limit: number,
  lens: SessionLens = "default"
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

  // TRIAGE LENS — applied as a WHERE clause, never as a post-filter. A page is
  // `limit`-capped in SQL, so filtering after the fact would let unaccepted
  // agent drafts consume the 50 slots and push real work off the end. That is
  // the whole reason the lens exists.
  if (lens === "triage") {
    conditions.push(triagePendingWhere());
  } else if (lens === "default") {
    conditions.push(notTriagePendingWhere());
  }
  // lens === "all" adds nothing — the pre-triage behaviour, kept addressable.

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
        /**
         * Also project the `blocked_by` dependency edges for the page —
         * `blockedBy` (what this session waits on) and `unblocks` (what waits
         * on it). Opt-in because most callers do not draw them, and it is a
         * projection on THIS door rather than a `graph` procedure of its own:
         * a second door would be a second shape to keep in lockstep.
         */
        edges: z.boolean().optional(),
        /** Which sessions — see `sessionLensSchema`. Default EXCLUDES triage. */
        lens: sessionLensSchema,
      })
    )
    .query(async ({ ctx, input }) => {
      const scope = resolveScope(ctx, input);
      const sessions = await queryUserSessions(
        ctx.userId,
        scope,
        input.status,
        input.limit,
        input.lens
      );
      // Derived lineage for the whole page in ONE query (never N+1, never a
      // second store) — mirrors `synap_list_sessions` (mcp/handlers/session.ts).
      const withLineage = await attachParentSessionIds(sessions);
      // `triage` is projected onto EVERY row in EVERY lens (it is pure — no
      // query), so no consumer ever re-derives the predicate from origin +
      // metadata + status. That re-derivation is exactly how a second, drifting
      // copy of a rule gets written.
      const withTriage = attachTriage(withLineage);
      if (!input.edges) return withTriage;
      // Second batch projection, ONE more links query for the whole page.
      return attachSessionEdges(withTriage);
    }),

  /**
   * Declare that a session is blocked by another — `session --blocked_by-->
   * session`.
   *
   * There is NO `blocked` status to set: blocked-ness is derived from the
   * edges whose target is still open (see `session-blocked-by.ts`). Ownership
   * is floored on BOTH endpoints inside the producer, mirroring the spawn
   * door; a handle the caller does not own is reported, never thrown.
   */
  addBlocker: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().uuid(),
        blockerSessionId: z.string().uuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const session = await db.query.focusSessions.findFirst({
        where: and(
          eq(focusSessions.id, input.sessionId),
          eq(focusSessions.userId, ctx.userId)
        ),
        columns: { id: true, workspaceId: true },
      });
      if (!session) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Focus session ${input.sessionId} not found`,
        });
      }
      return addSessionBlocker({
        sessionId: input.sessionId,
        blockerSessionId: input.blockerSessionId,
        userId: ctx.userId,
        workspaceId: session.workspaceId,
      });
    }),

  /** Drop a `blocked_by` edge. Reports whether one was actually there. */
  removeBlocker: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().uuid(),
        blockerSessionId: z.string().uuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const session = await db.query.focusSessions.findFirst({
        where: and(
          eq(focusSessions.id, input.sessionId),
          eq(focusSessions.userId, ctx.userId)
        ),
        columns: { id: true },
      });
      if (!session) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Focus session ${input.sessionId} not found`,
        });
      }
      return removeSessionBlocker({
        sessionId: input.sessionId,
        blockerSessionId: input.blockerSessionId,
        userId: ctx.userId,
      });
    }),

  // ── Triage ───────────────────────────────────────────────────────────────
  // A session an agent or an automation opened is a SUGGESTION until a person
  // says otherwise. Two verbs, no stored status: acceptance is a receipt on
  // `metadata.triage`, discard routes to the existing terminal `cancelled`.

  /**
   * "Accept as ready" — take ownership of a triage session. Stamps
   * `metadata.triage.acceptedAt`/`acceptedBy`; changes NO status.
   *
   * Returns `{ accepted, session? , reason? }`. `reason: "not_pending"` means
   * the session was never in triage (or somebody accepted it first) — a fact,
   * not a fault, so it is not a 4xx.
   */
  acceptFromTriage: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const result = await acceptFromTriage({
        sessionId: input.sessionId,
        userId: requireUserId(ctx.userId),
      });
      if (!result.ok) {
        if (result.reason === "not_found") {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `Focus session ${input.sessionId} not found`,
          });
        }
        return { accepted: false as const, reason: result.reason };
      }
      return { accepted: true as const, session: result.session };
    }),

  /**
   * Discard a triage session — cancel it (nothing is deleted) and retire the
   * ephemeral proposals bound to work that is now not happening.
   *
   * Returns `{ discarded, session?, expiredEphemerals?, reason? }`.
   * `expiredEphemerals` is reported, never silent: a retirement the person does
   * not learn about is the lying-count defect wearing a different hat.
   */
  discardFromTriage: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const result = await discardFromTriage({
        sessionId: input.sessionId,
        userId: requireUserId(ctx.userId),
      });
      if (!result.ok) {
        if (result.reason === "not_found") {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `Focus session ${input.sessionId} not found`,
          });
        }
        return { discarded: false as const, reason: result.reason };
      }
      return {
        discarded: true as const,
        session: result.session,
        expiredEphemerals: result.expiredEphemerals,
      };
    }),

  // ── Conversions ──────────────────────────────────────────────────────────

  /**
   * Spawn a PROJECT from this session — the container half of the conversion
   * pair (promote → playbook is the other, and lives on `playbooks.promote`).
   *
   * Governance mirrors promote exactly: load by id, `assertWorkspaceWrite` on
   * the LOADED row's workspace, then `checkPermissionOrPropose` — a human caller
   * executes, an agent caller files a `project/spawn_from_session` proposal that
   * re-runs THIS procedure on approval.
   *
   * Returns `{ status, projectId, receipt, ... }`. The receipt carries
   * `created: {kind,id,name}`, `renamedFrom` and `undoUntil`; undo is
   * `focusSessions.revertConversion`.
   */
  spawnProject: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().uuid(),
        name: z.string().min(1).max(255).optional(),
        description: z.string().max(4000).optional(),
        agentUserId: z.string().uuid().optional(),
        source: z.string().optional(),
        reasoning: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const database = await getDb();
      // Load by id + owner floor, gate on the LOADED row (never on a
      // request-supplied workspaceId).
      const session = await db.query.focusSessions.findFirst({
        where: and(
          eq(focusSessions.id, input.sessionId),
          eq(focusSessions.userId, requireUserId(ctx.userId))
        ),
      });
      if (!session) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Focus session ${input.sessionId} not found`,
        });
      }
      await assertWorkspaceWrite(database, ctx.userId, {
        workspaceId: session.workspaceId,
      });

      const perm = await checkPermissionOrPropose({
        userId: requireUserId(ctx.userId),
        agentUserId: input.agentUserId,
        workspaceId: session.workspaceId ?? undefined,
        subjectType: "project",
        // Its OWN verb, not `create`: the two are materialized by different
        // executors (a raw create takes a name; this takes a sessionId and
        // carries the mapping + the rename + the lineage edge), and one
        // proposalType cannot materialize both. `requiredPermissionFor`
        // fail-closes an unknown verb to "write", so RBAC is identical to
        // create — only the apply key forks. Same split promote made.
        action: "spawn_from_session",
        source: input.source,
        reasoning: input.reasoning,
        data: {
          sessionId: input.sessionId,
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined
            ? { description: input.description }
            : {}),
        },
      });
      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return {
          status: "proposed" as const,
          projectId: null as string | null,
          proposalId: perm.proposalId,
          receipt: null,
        };
      }

      const result = await spawnProjectFromSession({
        sessionId: input.sessionId,
        userId: requireUserId(ctx.userId),
        name: input.name,
        description: input.description,
        agentUserId: input.agentUserId ?? null,
        door: "trpc",
      });
      if (result.status === "refused") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: result.message,
          cause: result.reason,
        });
      }
      return {
        status: "spawned" as const,
        projectId: result.projectId as string | null,
        proposalId: null as string | null,
        deduped: result.deduped,
        expectedOutputsCarried: result.expectedOutputsCarried,
        ...(result.subjectBound !== undefined
          ? { subjectBound: result.subjectBound }
          : {}),
        receipt: result.receipt,
      };
    }),

  /**
   * UNDO a conversion — the inverse verb, one door for both promote and spawn.
   *
   * Restores the session's goal, ARCHIVES the created playbook/project (never
   * deletes: an undo that destroys rows is a worse failure than one that hides
   * them) and drops the lineage edge. Refuses with a typed reason once the
   * window has passed or the created object has been used.
   */
  revertConversion: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const result = await revertConversion({
        sessionId: input.sessionId,
        userId: requireUserId(ctx.userId),
      });
      if (!result.ok) {
        if (result.reason === "not_found") {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `Focus session ${input.sessionId} not found`,
          });
        }
        return { reverted: false as const, reason: result.reason };
      }
      return {
        reverted: true as const,
        goal: result.goal,
        retired: result.retired,
      };
    }),

  /**
   * Get a single focus session by ID.
   * Scoped to the authenticated user — cannot read another user's session.
   *
   * Returns `participants` — the agents that actually WORKED in this session,
   * DERIVED from the proposals they filed against it. The `agentIds` column is
   * not that set. It is an INVITE LIST: the create and update doors REPLACE it
   * wholesale (here, the Hub PATCH, and sync's conflict update), but nothing
   * ever APPENDS to it when an agent does work — so a session driven by an agent
   * nobody named up front reads as empty. The derived set is authoritative.
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

      // Same access predicate every other proposal read uses — owning the
      // session does not by itself entitle you to a proposal filed into a
      // workspace you have since left.
      const participantRows = await db
        .selectDistinct({ agentUserId: proposals.agentUserId })
        .from(proposals)
        .where(
          and(
            eq(proposals.sessionId, row.id),
            isNotNull(proposals.agentUserId),
            userVisibleWhere(proposals.workspaceId, requireUserId(ctx.userId))
          )
        );
      // SORTED. Postgres guarantees no ordering for SELECT DISTINCT, and the UI
      // assigns each party a colour by INDEX — so an unsorted set lets two agents
      // swap tones between two refetches of the same session, on a surface that
      // polls. Deterministic order is the difference between a stable roster and
      // a flickering one.
      const participantIds = participantRows
        .map((p) => p.agentUserId)
        .filter((id): id is string => Boolean(id))
        .sort();

      // Resolve to display names in the SAME batch shape `proposals.list` uses
      // for its agent labels — one `inArray`, one `displayNameForUser`. A bare
      // uuid is not a name, and a party cluster rendering `4f2a…` would be a
      // worse answer than the empty list this replaces.
      const participants: Array<{ id: string; name: string }> = [];
      if (participantIds.length > 0) {
        const agentRows = await db
          .select({
            id: users.id,
            name: users.name,
            email: users.email,
            userType: users.userType,
            agentMetadata: users.agentMetadata,
          })
          .from(users)
          .where(inArray(users.id, participantIds));
        const nameById = new Map(
          agentRows.map((u) => [u.id, displayNameForUser(u)])
        );
        for (const id of participantIds) {
          participants.push({ id, name: nameById.get(id) ?? id.slice(0, 8) });
        }
      }

      // Derived detour lineage (see `services/focus-sessions/parent-lineage.ts`)
      // — mirrors `synap_get_session` (mcp/handlers/session.ts) so the two
      // doors can never disagree.
      // Same projection the list door attaches (pure, no query) so a detail
      // page never re-derives triage-pending from origin + metadata + status.
      return withParentSessionId({
        ...row,
        participants,
        triage: projectTriage(row),
      });
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
        // A session can start on the personal floor. Space and project are
        // optional associations, not a required parent hierarchy.
        workspaceId: z.string().nullish(),
        goal: z.string().min(1).max(2000),
        templateId: z.string().optional(),
        expectedOutputs: z.array(expectedOutputItemSchema).default([]),
        channelId: z.string().uuid().optional(),
        agentIds: z.array(z.string()).default([]),
        // Optional project association. The active work context stays
        // independent from this persisted association.
        projectId: z.string().uuid().nullish(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // ONE create door (`createFocusSession`): the bare insert this replaced
      // stamped every human-started session `origin: "agent"`, which is the
      // exact mislabel the triage lens keys on. The service derives origin
      // from the caller (no agentUserId here ⇒ "human") and runs the same
      // membership membrane every other start door runs.
      const result = await createFocusSession({
        userId: ctx.userId,
        workspaceId: input.workspaceId ?? null,
        projectId: input.projectId ?? null,
        goal: input.goal,
        templateId: input.templateId ?? null,
        expectedOutputs: input.expectedOutputs,
        channelId: input.channelId ?? null,
        agentIds: input.agentIds,
      });
      if (result.status !== "created") {
        throw new TRPCError({ code: "FORBIDDEN", message: result.message });
      }
      return result.session as FocusSession;
    }),

  /**
   * Update an existing focus session.
   * Caller must own the session (userId check).
   */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        status: z
          .enum([
            "active",
            "paused",
            "closed",
            "forming",
            "scheduled",
            "failed",
            "cancelled",
          ])
          .optional(),
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

      // Any terminal status via update funnels through completeFocusSession —
      // the ONE close door (pack + run close + ephemeral expiry + close event).
      // A bare `status: "cancelled"` write used to skip all four.
      if (
        isTerminalSessionStatus(patch.status) &&
        !isTerminalSessionStatus(existing.status)
      ) {
        const { completeFocusSession } =
          await import("../services/focus-sessions/complete-session.js");
        try {
          const result = await completeFocusSession({
            sessionId: input.id,
            userId: ctx.userId,
            terminalStatus: patch.status,
          });
          if (!result) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: `Focus session ${input.id} not found`,
            });
          }
          // Apply any non-status fields still in the patch onto the closed row.
          const extra: Partial<typeof focusSessions.$inferInsert> = {
            updatedAt: new Date(),
          };
          if (patch.progress !== undefined) extra.progress = patch.progress;
          if (patch.goal !== undefined) extra.goal = patch.goal;
          if (patch.expectedOutputs !== undefined)
            extra.expectedOutputs = patch.expectedOutputs;
          if (Object.keys(extra).length > 1) {
            const [merged] = await db
              .update(focusSessions)
              .set(extra)
              .where(eq(focusSessions.id, input.id))
              .returning();
            return (merged ?? result.session) as FocusSession;
          }
          return result.session as FocusSession;
        } catch (err) {
          const e = err as { code?: string; message?: string };
          if (e.code === "FORBIDDEN") {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: e.message ?? "Session completion not allowed",
            });
          }
          throw err;
        }
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
   * Complete a focus session (canonical close).
   * Delegates to completeFocusSession — pack + playbook_run + verification recap.
   * Prefer this over update({ status: "closed" }).
   */
  close: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        /** Short human recap — stored on verificationReport.summary */
        summary: z.string().max(4000).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { completeFocusSession } =
        await import("../services/focus-sessions/complete-session.js");
      try {
        const result = await completeFocusSession({
          sessionId: input.id,
          userId: ctx.userId,
          summary: input.summary,
        });
        if (!result) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `Focus session ${input.id} not found`,
          });
        }
        return result.session as FocusSession;
      } catch (err) {
        const e = err as { code?: string; message?: string };
        if (e.code === "FORBIDDEN") {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: e.message ?? "Session completion not allowed",
          });
        }
        throw err;
      }
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

  /**
   * THE one door for "what did this session produce?" — the join of the three
   * output ledgers (`produced` edges, `artifacts` rows, `expected_outputs`).
   *
   * Consumers must navigate with `refId`, never an artifact row id.
   */
  outputs: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const result = await listSessionOutputs({
        db,
        userId: ctx.userId,
        sessionId: input.sessionId,
      });
      if (!result) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Focus session ${input.sessionId} not found`,
        });
      }
      return result;
    }),
});
