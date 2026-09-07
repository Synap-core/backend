/**
 * Governance Ceilings Router
 *
 * CRUD over `governance_ceilings` (schema 0236) — the sibling of
 * `governance_rules` for NUMERIC governance limits. Where a rule stores an
 * auto/propose VERDICT, a ceiling stores a numeric LIMIT. First slice ships ONE
 * axis — `daily_write_count`: a per-agent (or pod-wide) cap on how many writes
 * an agent may AUTO-EXECUTE per UTC day. The resolver that *consumes* these rows
 * (rung 2.56 in `decideAgentPolicy`) already exists; without this door no row
 * could be created, so the resolver always fell back to
 * `DEFAULT_DAILY_WRITE_CEILING`. This router lets a ceiling be user-authored.
 *
 * Scoping and gating MIRROR `governanceRulesRouter` exactly (this is a
 * copy-adapt of that router): a ceiling TIGHTENS governance, so creating or
 * revoking one is itself gated —
 *   - scopeKind "pod"       -> pod-admin only (assertPodAdmin)
 *   - scopeKind "workspace" -> editor/admin/owner membership in that workspace
 *   - principalKind "agent" -> caller must own the agent (users.createdByUserId)
 *                              or be pod-admin; otherwise FORBIDDEN
 * There is no verdict/target here — the axis IS the target and the value is
 * numeric.
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { assertPodAdmin } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { db, eq, and, or, isNull, gt, desc, inArray } from "@synap/database";
import {
  governanceCeilings,
  workspaceMembers,
  users,
} from "@synap/database/schema";
import {
  countAgentWritesTodayUtc,
  resolveDailyWriteCeiling,
} from "@synap/database/agent-governance";
import { userVisibleWhere } from "../utils/user-visible-where.js";
import { ScopeFilterShape, resolveScope } from "../utils/scope-filter.js";
import type { Lens } from "../access/context.js";

const EDITOR_ROLES = ["editor", "admin", "owner"];

type GovernanceCeilingRow = typeof governanceCeilings.$inferSelect;

/**
 * Map raw ceiling rows to the wire DTO used by `list`, resolving
 * each agent-principal ceiling's display label in ONE batched lookup. Shared so
 * the two listing doors never drift on shape.
 */
async function mapCeilingsWithAgentLabels(rows: GovernanceCeilingRow[]) {
  const agentIds = Array.from(
    new Set(
      rows
        .filter((r) => r.principalKind === "agent" && r.agentUserId)
        .map((r) => r.agentUserId as string)
    )
  );

  const agentLabels = new Map<string, string>();
  if (agentIds.length > 0) {
    const agents = await db
      .select({
        id: users.id,
        name: users.name,
        agentType: users.agentType,
      })
      .from(users)
      .where(inArray(users.id, agentIds));
    for (const a of agents) {
      agentLabels.set(a.id, a.name ?? a.agentType ?? a.id);
    }
  }

  return rows.map((r) => ({
    id: r.id,
    axis: r.axis,
    principalKind: r.principalKind,
    agentUserId: r.agentUserId,
    agentLabel: r.agentUserId
      ? (agentLabels.get(r.agentUserId) ?? r.agentUserId)
      : null,
    scopeKind: r.scopeKind,
    workspaceId: r.workspaceId,
    limitValue: r.limitValue,
    createdAt: r.createdAt,
    createdBy: r.createdBy,
    sourceProposalId: r.sourceProposalId,
    expiresAt: r.expiresAt,
  }));
}

/** Active-ceiling predicate: not revoked, not expired. Shared by every read door. */
function activeCeilingPredicate() {
  return and(
    isNull(governanceCeilings.revokedAt),
    or(
      isNull(governanceCeilings.expiresAt),
      gt(governanceCeilings.expiresAt, new Date())
    )
  );
}

async function isPodAdmin(userId: string): Promise<boolean> {
  try {
    await assertPodAdmin(userId);
    return true;
  } catch {
    return false;
  }
}

async function assertWorkspaceEditor(
  userId: string,
  workspaceId: string
): Promise<void> {
  const membership = await db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.workspaceId, workspaceId),
      eq(workspaceMembers.userId, userId)
    ),
    columns: { role: true },
  });

  if (!membership || !EDITOR_ROLES.includes(membership.role)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Editor role or higher required for this workspace",
    });
  }
}

/**
 * Shared gate for both `create` and `revoke` — a ceiling's authority to
 * exist/be-undone is determined by its scope + principal, never by who is
 * asking. Throws FORBIDDEN when the caller isn't allowed. Mirrors
 * `assertCanManageRule` in governance-rules.ts exactly.
 */
async function assertCanManageCeiling(
  userId: string,
  ceiling: {
    scopeKind: "workspace" | "pod";
    workspaceId?: string | null;
    principalKind: "agent" | "any";
    agentUserId?: string | null;
  }
): Promise<void> {
  const podAdmin = await isPodAdmin(userId);

  if (ceiling.scopeKind === "pod") {
    if (!podAdmin) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message:
          "Pod admin required for pod-scope (global) governance ceilings",
      });
    }
  } else {
    if (!ceiling.workspaceId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "workspaceId is required for workspace-scope ceilings",
      });
    }
    if (!podAdmin) {
      await assertWorkspaceEditor(userId, ceiling.workspaceId);
    }
  }

  if (ceiling.principalKind === "agent") {
    if (!ceiling.agentUserId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "agentUserId is required for agent-scoped ceilings",
      });
    }
    if (!podAdmin) {
      const agent = await db.query.users.findFirst({
        where: and(
          eq(users.id, ceiling.agentUserId),
          eq(users.userType, "agent")
        ),
        columns: { createdByUserId: true },
      });
      if (!agent) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "agentUserId must be an existing agent user",
        });
      }
      if (agent.createdByUserId !== userId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You do not own this agent — cannot manage its ceilings",
        });
      }
    }
  }
}

const CreateInputSchema = z
  .object({
    principalKind: z.enum(["agent", "any"]),
    agentUserId: z.string().min(1).optional(),
    scopeKind: z.enum(["workspace", "pod"]),
    workspaceId: z.string().uuid().optional(),
    limitValue: z.number().int().positive(),
    sourceProposalId: z.string().uuid().optional(),
    expiresAt: z.coerce.date().optional(),
  })
  .refine((v) => v.principalKind !== "agent" || !!v.agentUserId, {
    message: "agentUserId is required when principalKind is 'agent'",
    path: ["agentUserId"],
  })
  .refine((v) => v.scopeKind !== "workspace" || !!v.workspaceId, {
    message: "workspaceId is required when scopeKind is 'workspace'",
    path: ["workspaceId"],
  });

/**
 * Translate a resolved workspace `Lens` into an ADDITIONAL narrowing predicate
 * for a ceiling read. Returns `undefined` (no narrow) for the floor states, so
 * the caller's `userVisibleWhere` floor stands alone.
 *
 * Pod-scope ceilings are global, so they ride along with every workspace lens —
 * except `null`, which means "pod-scope only" and therefore excludes the
 * workspace half entirely.
 */
function ceilingScopeLens(lens: Lens) {
  const podOnly = eq(governanceCeilings.scopeKind, "pod");

  if (lens === null) return podOnly;

  if (Array.isArray(lens)) {
    // Empty array = no narrow (the floor) — never silently match zero rows.
    if (lens.length === 0) return undefined;
    return or(
      podOnly,
      and(
        eq(governanceCeilings.scopeKind, "workspace"),
        inArray(governanceCeilings.workspaceId, lens)
      )
    );
  }

  if (typeof lens === "string") {
    return or(
      podOnly,
      and(
        eq(governanceCeilings.scopeKind, "workspace"),
        eq(governanceCeilings.workspaceId, lens)
      )
    );
  }

  return undefined;
}

export const governanceCeilingsRouter = router({
  /**
   * List active ceilings (not revoked, not expired) visible to the caller:
   * pod-scope ceilings (global) plus workspace-scope ceilings for the workspace
   * the caller passes (defaults to ctx.workspaceId). Newest first.
   */
  /**
   * List active ceilings (not revoked, not expired) visible to the caller.
   *
   * ONE floor-first door — the `.list`/`.listAll` split was collapsed (tripwire
   * `read-scoping.tripwire.test.ts`: "the two-door split may only collapse,
   * never re-expand"). The FLOOR is `userVisibleWhere` on `workspace_id`, which
   * admits pod-scope ceilings (NULL workspace = global) plus ceilings in every
   * workspace the caller can see. The `workspaceId` lens only ever NARROWS it.
   *
   * This also closes a widening the old two-door shape carried: the previous
   * `.list` filtered on the caller-supplied `input.workspaceId` with NO
   * `userVisibleWhere` floor, so a caller passing a workspace id they cannot see
   * read its ceilings. A lens applied INSIDE the floor cannot do that.
   *
   * Lens semantics (the canonical ScopeFilter contract):
   *   - absent      -> defaults to the active-workspace header, else the floor
   *   - `null`      -> pod-scope ceilings only
   *   - `"<id>"`    -> pod-scope + that workspace's ceilings
   *   - `["a","b"]` -> pod-scope + those workspaces' ceilings
   *   - `[]`        -> no narrow (the full floor — the old `listAll`)
   * Newest first.
   */
  list: protectedProcedure
    .input(z.object({ workspaceId: ScopeFilterShape.workspaceId }))
    .query(async ({ ctx, input }) => {
      const { workspaceLens } = resolveScope(ctx, input);

      const rows = await db.query.governanceCeilings.findMany({
        where: and(
          activeCeilingPredicate(),
          // The security boundary — never widened by the lens below.
          userVisibleWhere(governanceCeilings.workspaceId, ctx.userId),
          ceilingScopeLens(workspaceLens)
        ),
        orderBy: [desc(governanceCeilings.createdAt)],
      });

      return { ceilings: await mapCeilingsWithAgentLabels(rows) };
    }),

  /**
   * The acting agent's current daily-write usage against its resolved ceiling —
   * powers a "N / limit writes today" gauge. Read-only: reuses the SAME resolver
   * functions rung 2.56 uses (`countAgentWritesTodayUtc` +
   * `resolveDailyWriteCeiling`), never re-deriving the count.
   */
  usageToday: protectedProcedure
    .input(
      z.object({
        agentUserId: z.string().min(1),
        workspaceId: z.string().uuid().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const workspaceId = input.workspaceId ?? ctx.workspaceId ?? undefined;
      const [count, limit] = await Promise.all([
        countAgentWritesTodayUtc(db, input.agentUserId),
        resolveDailyWriteCeiling({
          db,
          agentUserId: input.agentUserId,
          workspaceId,
        }),
      ]);
      return { count, limit };
    }),

  /**
   * Create one ceiling — the "cap this agent's daily auto-writes" door. Only the
   * `daily_write_count` axis exists in this slice.
   */
  create: protectedProcedure
    .input(CreateInputSchema)
    .mutation(async ({ ctx, input }) => {
      await assertCanManageCeiling(ctx.userId, input);

      const [ceiling] = await db
        .insert(governanceCeilings)
        .values({
          axis: "daily_write_count",
          principalKind: input.principalKind,
          agentUserId:
            input.principalKind === "agent" ? input.agentUserId : null,
          scopeKind: input.scopeKind,
          workspaceId:
            input.scopeKind === "workspace" ? input.workspaceId : null,
          limitValue: input.limitValue,
          sourceProposalId: input.sourceProposalId ?? null,
          createdBy: ctx.userId,
          expiresAt: input.expiresAt ?? null,
        })
        .returning();

      return { ceiling };
    }),

  /**
   * Revoke a ceiling (soft — sets revokedAt). Gated identically to `create`:
   * whoever could have created this ceiling may undo it.
   */
  revoke: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await db.query.governanceCeilings.findFirst({
        where: eq(governanceCeilings.id, input.id),
      });

      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Ceiling not found",
        });
      }
      if (existing.revokedAt) {
        return { ceiling: existing };
      }

      await assertCanManageCeiling(ctx.userId, existing);

      const [ceiling] = await db
        .update(governanceCeilings)
        .set({ revokedAt: new Date() })
        .where(eq(governanceCeilings.id, input.id))
        .returning();

      return { ceiling };
    }),
});
