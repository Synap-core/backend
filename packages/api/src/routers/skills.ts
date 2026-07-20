/**
 * Skills Router
 *
 * Synchronous CRUD operations for user-created skills.
 * Direct DB operations with inline permission checks.
 * Skills are stored in the backend, executed in the Intelligence Service.
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { db, eq, and, or, desc, inArray, type SQL } from "@synap/database";
import { skills, tools } from "@synap/database/schema";
import type { ProviderVerbSpec } from "@synap/database/schema";
import {
  getLinksFor,
  createLinks,
  deleteLink,
} from "../services/links/links-service.js";
import { requireUserId } from "../utils/user-scoped.js";
import { visibleSkillsWhere } from "../services/skills/visibility.js";
import { safeExternalFetch } from "@synap/shared-utils";
import {
  checkPermissionOrPropose,
  createPendingProposal,
} from "../utils/permission-check.js";
import { gateCapabilityExecution } from "../services/capabilities/gate-capability-execution.js";
import { getWorkspaceRole, requirePodAdmin } from "../utils/workspace-role.js";
import { auditLog } from "../utils/audit-log.js";
import { emitSideEffects } from "@synap/events";
import { randomUUID } from "crypto";
import { parseSkillMd } from "../skills/skill-md-parser.js";
import { parseSkillToml } from "../skills/skill-toml-parser.js";
import { resolveIntelligenceService } from "../utils/intelligence-routing.js";

/**
 * The ONE governed persistence path for inserting a `skills` row. Shared by
 * every skill-creation door (`create`, `installFromUrl` here, and the Hub
 * Protocol `/agent-skills/import` door) so none of them can bypass the same
 * `checkPermissionOrPropose` gate `create` runs — no door hardcodes
 * `approved: true` on its own insert.
 *
 * Born-approved rule: an `instruction` skill (prompt-only, no side effects) is
 * approved when installed by a trusted human (no `agentUserId`). Anything
 * executable (`code`/`declarative`), OR an install initiated by an agent
 * identity — including instruction content, which lands in the agent's system
 * prompt and is therefore a prompt-injection vector — is born UNAPPROVED and
 * needs an explicit owner approval (`setApproved`) before it runs or loads as
 * an agent tool.
 */
export type InsertSkillGovernedInput = typeof skills.$inferInsert & {
  agentUserId?: string;
  /** Folded into the audit-log `data` for observability, e.g. "install_from_url". */
  auditSource: string;
};

export type InsertSkillGovernedResult =
  | { status: "installed"; skill: typeof skills.$inferSelect }
  | { status: "proposed"; proposalId: string }
  | { status: "denied"; reason: string };

export async function insertSkillGoverned(
  input: InsertSkillGovernedInput
): Promise<InsertSkillGovernedResult> {
  const {
    agentUserId,
    auditSource,
    id: _ignoredId,
    approved: _ignoredApproved,
    status: _ignoredStatus,
    ...values
  } = input;
  const skillId = randomUUID();

  const perm = await checkPermissionOrPropose({
    userId: values.userId,
    agentUserId,
    workspaceId: values.workspaceId ?? undefined,
    subjectType: "skill",
    action: "create",
    // Widened (object-proposal manifest W1): carry the FULL insert values so an
    // approved proposal materializes a real skill (kind/code/body/scope/
    // providerSpec/…) via the SAME insertSkillGoverned door — not just a label.
    // `values` is exactly the skill insert shape; only the PROPOSED (pending)
    // row's stored data widens — the granted-path insert below reads `values`
    // and `skillId` unchanged, so the direct-create path is byte-identical.
    data: { id: skillId, ...values },
  });

  if ("denied" in perm && perm.denied) {
    return { status: "denied", reason: perm.reason };
  }
  if ("proposalId" in perm) {
    return { status: "proposed", proposalId: perm.proposalId };
  }

  const approved = values.kind === "instruction" && !agentUserId;

  const [skill] = await db
    .insert(skills)
    .values({
      ...values,
      id: skillId,
      status: "active",
      approved,
    })
    .returning();

  auditLog({
    subjectType: "skill",
    action: "create",
    phase: "completed",
    subjectId: skill.id,
    userId: values.userId,
    workspaceId: values.workspaceId ?? undefined,
    data: { name: values.name, kind: values.kind, source: auditSource },
  });

  emitSideEffects({
    subjectType: "skill",
    action: "create",
    subjectId: skill.id,
    userId: values.userId,
    workspaceId: values.workspaceId ?? undefined,
  });

  return { status: "installed", skill };
}

export const skillsRouter = router({
  /**
   * List skills for the current user
   */
  list: protectedProcedure
    .input(
      z
        .object({
          workspaceId: z.string().uuid().optional(),
          kind: z
            .enum(["instruction", "code", "declarative", "builtin"])
            .optional(),
          scope: z.enum(["pod", "user", "workspace"]).optional(),
          status: z.enum(["active", "inactive", "error", "all"]).optional(),
          /** When true, return only approved skills (the agent-tool loader uses this). */
          approved: z.boolean().optional(),
          limit: z.number().min(1).max(100).default(50),
          offset: z.number().min(0).default(0),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const conditions: SQL[] = [];

      conditions.push(visibleSkillsWhere(userId, input?.workspaceId));

      if (input?.kind) {
        conditions.push(eq(skills.kind, input.kind));
      }

      if (input?.scope) {
        conditions.push(eq(skills.scope, input.scope));
      }

      if (input?.status && input.status !== "all") {
        conditions.push(eq(skills.status, input.status));
      }

      if (input?.approved !== undefined) {
        conditions.push(eq(skills.approved, input.approved));
      }

      const results = await ctx.db.query.skills.findMany({
        where: and(...conditions),
        orderBy: [desc(skills.createdAt)],
        limit: input?.limit || 50,
        offset: input?.offset || 0,
      });

      return { skills: results };
    }),

  /**
   * Get a single skill by ID
   */
  get: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        /** Required to resolve a workspace-scoped skill; omitted = pod + own only. */
        workspaceId: z.string().uuid().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const skill = await ctx.db.query.skills.findFirst({
        where: and(
          eq(skills.id, input.id),
          visibleSkillsWhere(userId, input.workspaceId)
        ),
      });

      if (!skill) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Skill not found",
        });
      }

      return { skill };
    }),

  /**
   * Create a new skill
   */
  create: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid().optional(),
        // A skill is Documentation (always) + optional Code. `kind` is derived
        // from whether code is present; still accepted for back-compat.
        // `declarative` = a Tier-1 in-process verb (carries `providerSpec`).
        kind: z
          .enum(["instruction", "code", "declarative", "builtin"])
          .optional(),
        scope: z.enum(["pod", "user", "workspace"]).default("pod"),
        agentTypes: z.array(z.string()).optional(),
        name: z.string().min(1).max(255),
        description: z.string().optional(),
        /** Documentation (Markdown): what the skill does + when to use it. */
        body: z.string().optional(),
        /** Optional executable — present ⇒ the skill is runnable (sandboxed). */
        code: z.string().optional(),
        /** Declarative provider-verb spec (kind="declarative"). */
        providerSpec: z.record(z.string(), z.unknown()).optional(),
        parameters: z.record(z.string(), z.unknown()).optional(),
        category: z.string().optional(),
        executionMode: z.enum(["sync", "async"]).default("sync"),
        timeoutSeconds: z.number().min(1).max(300).default(30),
        /** The acting AGENT identity, when this create is agent-initiated
         *  (e.g. via an MCP tool) — mirrors entities.ts's createEntity input.
         *  Threaded into checkPermissionOrPropose below so an agent-created
         *  skill is gated by the agent's grant/role, not silently evaluated
         *  as if the human owner created it directly. */
        agentUserId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const skillId = randomUUID();

      // Documentation + optional Code. Derive `kind` from code presence (explicit
      // input.kind still honored). A skill must carry documentation or code.
      const hasCode = !!input.code?.trim();
      const kind = input.kind ?? (hasCode ? "code" : "instruction");
      // `declarative` (providerSpec) and `builtin` (in-process handler) carry no
      // body/code, so they are exempt from the documentation-or-code requirement.
      if (
        kind !== "declarative" &&
        kind !== "builtin" &&
        !input.body?.trim() &&
        !hasCode
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "A skill needs documentation or code.",
        });
      }
      // A declarative verb IS its providerSpec — require it so the skill cannot be
      // created malformed (a declarative skill with no spec misroutes at run time).
      if (kind === "declarative" && !input.providerSpec) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "A declarative skill requires a providerSpec.",
        });
      }

      // 1. Permission check
      const perm = await checkPermissionOrPropose({
        userId,
        workspaceId: input.workspaceId,
        subjectType: "skill",
        action: "create",
        // Widened (object-proposal manifest W1): carry the FULL resolved insert
        // shape (matching insertSkillGoverned's `values`) so an approved proposal
        // materializes a real skill via the shared insertSkillGoverned door. Only
        // the PROPOSED (pending) row's stored data widens — the granted-path
        // insert below is byte-untouched. `kind` is the DERIVED kind (not raw
        // input.kind) so the materialized skill's kind matches the direct path.
        data: {
          id: skillId,
          userId,
          workspaceId: input.workspaceId ?? null,
          kind,
          scope: input.scope,
          agentTypes: input.agentTypes ?? null,
          name: input.name,
          description: input.description,
          body: input.body ?? null,
          code: input.code ?? null,
          providerSpec: input.providerSpec ?? null,
          parameters: input.parameters || {},
          category: input.category,
          executionMode: input.executionMode,
          timeoutSeconds: input.timeoutSeconds,
        },
        agentUserId: input.agentUserId,
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return {
          id: skillId,
          status: "proposed" as const,
          proposalId: perm.proposalId,
        };
      }

      // 2. Direct DB operation.
      //    Born-draft carve-out (D-D): `instruction` skills are prompt-only with
      //    no side effects → born approved. `code` skills execute → born draft
      //    (DEFAULT false) and require an owner to approve before they run or
      //    load as agent tools.
      const [skill] = await db
        .insert(skills)
        .values({
          id: skillId,
          userId,
          // Pod-wide by default: only stamp a workspace when the caller explicitly
          // narrows to one. No workspace context → pod-wide (NULL).
          workspaceId: input.workspaceId ?? null,
          kind,
          scope: input.scope,
          agentTypes: input.agentTypes ?? null,
          name: input.name,
          description: input.description,
          body: input.body ?? null,
          code: input.code ?? null,
          providerSpec:
            (input.providerSpec as ProviderVerbSpec | undefined) ?? null,
          parameters: input.parameters || {},
          category: input.category,
          executionMode: input.executionMode,
          timeoutSeconds: input.timeoutSeconds,
          status: "active",
          approved: kind === "instruction",
        })
        .returning();

      // 3. Audit log
      auditLog({
        subjectType: "skill",
        action: "create",
        phase: "completed",
        subjectId: skill.id,
        userId,
        workspaceId: input.workspaceId,
        data: { name: input.name },
      });

      // 4. Side-effects
      emitSideEffects({
        subjectType: "skill",
        action: "create",
        subjectId: skill.id,
        userId,
        workspaceId: input.workspaceId,
      });

      return {
        id: skill.id,
        status: "created" as const,
      };
    }),

  /**
   * Update a skill
   */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        /**
         * AI attribution — set by AI callers, mirroring `create`. Load-bearing
         * for re-approval: an agent rewriting an `instruction` skill's `body`
         * must re-earn approval, because that body is injected verbatim into an
         * agent's system prompt.
         */
        agentUserId: z.string().uuid().optional(),
        kind: z
          .enum(["instruction", "code", "declarative", "builtin"])
          .optional(),
        scope: z.enum(["pod", "user", "workspace"]).optional(),
        agentTypes: z.array(z.string()).nullable().optional(),
        name: z.string().min(1).max(255).optional(),
        description: z.string().optional(),
        /** Documentation (Markdown): what the skill does + when to use it. */
        body: z.string().optional(),
        /** Optional executable; empty clears it (doc-only). */
        code: z.string().optional(),
        parameters: z.record(z.string(), z.unknown()).optional(),
        category: z.string().optional(),
        executionMode: z.enum(["sync", "async"]).optional(),
        timeoutSeconds: z.number().min(1).max(300).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      // `agentUserId` is attribution, NOT a column — peel it off so the spread
      // below never carries it into the skills UPDATE.
      const { id, agentUserId: _agentUserId, ...updateData } = input;

      // Verify skill exists and user has access (owner or pod-scoped)
      const existingSkill = await ctx.db.query.skills.findFirst({
        where: and(
          eq(skills.id, id),
          or(eq(skills.scope, "pod"), eq(skills.userId, userId))
        ),
      });

      if (!existingSkill) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Skill not found",
        });
      }

      // 1. Permission check
      const perm = await checkPermissionOrPropose({
        userId,
        workspaceId: existingSkill.workspaceId || undefined,
        subjectType: "skill",
        action: "update",
        data: { id },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return { status: "proposed" as const, proposalId: perm.proposalId };
      }

      // Security: if any execution-defining field changes, the skill may now run
      // different code — reset approval so an approved skill can't be silently
      // re-pointed to execute untrusted code.
      const RE_APPROVAL_FIELDS = [
        "code",
        "parameters",
        "executionMode",
        "timeoutSeconds",
        "kind",
      ] as const;
      const execChanged =
        RE_APPROVAL_FIELDS.some(
          (k) => (updateData as Record<string, unknown>)[k] !== undefined
        ) ||
        // An AGENT rewriting `body` must re-earn approval. `body` is not
        // executable, so it isn't in RE_APPROVAL_FIELDS — but for an
        // `instruction` skill the body IS injected verbatim into an agent's
        // system prompt (is-agent-executor.ts). Without this, an agent could
        // take an already-approved instruction skill and rewrite its body while
        // it KEPT `approved: true` — precisely the "hostile fetched content
        // persists itself into the prompt" path the approval gate exists to
        // stop. A human editing their own skill is unaffected.
        (updateData.body !== undefined && !!input.agentUserId);

      // Documentation + optional Code: when code is set, derive `kind` (unless
      // given) and store empty code as null (the skill becomes doc-only).
      if (updateData.code !== undefined) {
        const trimmed = updateData.code.trim();
        (updateData as Record<string, unknown>).code = trimmed
          ? updateData.code
          : null;
        if (updateData.kind === undefined) {
          (updateData as Record<string, unknown>).kind = trimmed
            ? "code"
            : "instruction";
        }
      }

      // 2. Direct DB operation
      const [_updated] = await db
        .update(skills)
        .set({
          ...updateData,
          ...(execChanged ? { approved: false } : {}),
          updatedAt: new Date(),
        })
        .where(eq(skills.id, id))
        .returning();

      // 3. Audit log
      auditLog({
        subjectType: "skill",
        action: "update",
        phase: "completed",
        subjectId: id,
        userId,
        workspaceId: existingSkill.workspaceId || undefined,
        data: updateData,
      });

      // 4. Side-effects
      emitSideEffects({
        subjectType: "skill",
        action: "update",
        subjectId: id,
        userId,
        workspaceId: existingSkill.workspaceId || undefined,
      });

      return {
        status: "updated" as const,
      };
    }),

  /**
   * Delete a skill
   */
  delete: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      // Verify skill exists and user has access (owner or pod-scoped)
      const existingSkill = await ctx.db.query.skills.findFirst({
        where: and(
          eq(skills.id, input.id),
          or(eq(skills.scope, "pod"), eq(skills.userId, userId))
        ),
      });

      if (!existingSkill) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Skill not found",
        });
      }

      // 1. Permission check
      const perm = await checkPermissionOrPropose({
        userId,
        workspaceId: existingSkill.workspaceId || undefined,
        subjectType: "skill",
        action: "delete",
        data: { id: input.id },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return { status: "proposed" as const, proposalId: perm.proposalId };
      }

      // 2. Direct DB operation
      await db.delete(skills).where(eq(skills.id, input.id));

      // 3. Audit log
      auditLog({
        subjectType: "skill",
        action: "delete",
        phase: "completed",
        subjectId: input.id,
        userId,
        workspaceId: existingSkill.workspaceId || undefined,
        data: { id: input.id },
      });

      // 4. Side-effects
      emitSideEffects({
        subjectType: "skill",
        action: "delete",
        subjectId: input.id,
        userId,
        workspaceId: existingSkill.workspaceId || undefined,
      });

      return {
        status: "deleted" as const,
      };
    }),

  /**
   * Execute a skill by ID
   *
   * Delegates execution to the Intelligence Hub which has the sandboxed
   * executor. Updates execution metadata (count + lastTestedAt) on success.
   */
  execute: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        /** Free-form parameter map passed to the skill's code */
        input: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      // Verify skill exists and user has access (owner or pod-scoped)
      const skill = await ctx.db.query.skills.findFirst({
        where: and(
          eq(skills.id, input.id),
          or(eq(skills.scope, "pod"), eq(skills.userId, userId))
        ),
      });

      if (!skill) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Skill not found" });
      }

      // Lifecycle gate (NOT governance): a draft/disabled skill never runs.
      if (skill.status !== "active") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Skill is not active (status: ${skill.status})`,
        });
      }

      // Capability-execution gate (Wave 3b chokepoint) — supersedes the bare
      // `approved` boolean. Owner-bypass: the skill's owner runs their own skill.
      // A non-owner with an UNAPPROVED skill routes to `propose` (don't run); an
      // approved skill + auto resolves to run. This is the operator/UI door
      // (protectedProcedure) — there is no agent identity here, so an approved
      // skill run by its accessible operator stays auto (no behavior change).
      const skillDecision = await gateCapabilityExecution({
        capabilityKind: "skill",
        capabilityId: skill.id,
        skill: { id: skill.id, approved: skill.approved, userId: skill.userId },
        actorUserId: userId,
        workspaceId: skill.workspaceId ?? null,
        issuer: "skills.execute",
      });

      if (skillDecision.decision === "deny") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: skillDecision.reason,
        });
      }
      if (skillDecision.decision === "propose") {
        // Don't run — materialize a reviewable capability/run proposal. A
        // pod-wide (null-workspace) skill has no review surface; require approval
        // upfront rather than silently running (safe-by-default).
        if (!skill.workspaceId) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Skill is not approved for execution.",
          });
        }
        const proposal = await createPendingProposal({
          userId,
          workspaceId: skill.workspaceId,
          targetType: "capability",
          targetId: skill.id,
          proposalType: "run",
          data: {
            capabilityKind: "skill",
            capabilityId: skill.id,
            input: input.input ?? {},
            workspaceId: skill.workspaceId,
          },
          notificationDescription: `Run skill ${skill.name}`,
        });
        return {
          success: false as const,
          proposed: true as const,
          proposalId: proposal.id,
          executionTimeMs: 0,
        };
      }
      if (skillDecision.decision === "dry-run") {
        return {
          success: true as const,
          result: { dryRun: true, skillId: skill.id },
          executionTimeMs: 0,
        };
      }
      // decision === "run" → fall through to execute.

      // Resolve the intelligence service from DB (workspace pref → user pref → default)
      const { endpoint: hubUrl, serviceApiKey: hubApiKey } =
        await resolveIntelligenceService({
          userId,
          workspaceId: skill.workspaceId ?? undefined,
        });

      let result: {
        success: boolean;
        result?: unknown;
        error?: string;
        executionTimeMs: number;
      };

      try {
        const response = await fetch(`${hubUrl}/api/skills/execute`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": hubApiKey,
          },
          body: JSON.stringify({
            skillId: input.id,
            userId,
            parameters: input.input ?? {},
          }),
        });

        if (!response.ok) {
          const text = await response.text().catch(() => "");
          throw new Error(`Hub returned ${response.status}: ${text}`);
        }

        result = (await response.json()) as typeof result;
      } catch (err) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Skill execution failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      // Update execution metadata on success
      if (result.success) {
        const currentMeta =
          (skill.metadata as Record<string, unknown> | null) ?? {};
        const execCount =
          ((currentMeta.executionCount as number | undefined) ?? 0) + 1;
        await db
          .update(skills)
          .set({
            metadata: {
              ...currentMeta,
              executionCount: execCount,
              lastTestedAt: new Date().toISOString(),
            },
            updatedAt: new Date(),
          })
          .where(eq(skills.id, input.id));
      }

      return result;
    }),

  /**
   * Approve or revoke approval for a skill's execution. Owner-gated (workspace
   * owner, or pod-admin for pod-wide null-workspace skills) — mirrors
   * `mcpServersRouter.setApproved`. An unapproved skill is refused by the
   * backend/IS executor and is not loaded as an agent tool.
   */
  setApproved: protectedProcedure
    .input(z.object({ id: z.string().uuid(), approved: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const existing = await ctx.db.query.skills.findFirst({
        where: eq(skills.id, input.id),
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Skill not found" });
      }
      if (existing.workspaceId) {
        const role = await getWorkspaceRole(userId, existing.workspaceId);
        if (role !== "owner") {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Only workspace owners can approve skill execution.",
          });
        }
      } else {
        // Pod-wide (null-workspace) skill — pod-level privileged action.
        await requirePodAdmin(userId);
      }

      const [updated] = await db
        .update(skills)
        .set({ approved: input.approved, updatedAt: new Date() })
        .where(eq(skills.id, input.id))
        .returning();

      auditLog({
        subjectType: "skill",
        action: "update",
        phase: "completed",
        subjectId: input.id,
        userId,
        workspaceId: existing.workspaceId || undefined,
        data: { approved: input.approved },
      });

      return { skill: updated };
    }),

  /**
   * Install a skill from a URL (SKILL.md or SKILL.toml format)
   *
   * Supports:
   *   - OpenClaw ClawHub skills (SKILL.md with YAML frontmatter)
   *   - ZeroClaw skills (SKILL.toml with companion markdown)
   *
   * The `code` field stores the instruction text.
   * `metadata.skillType = 'instruction'` tells the Intelligence Hub
   * to inject this skill's content into the agent system prompt rather
   * than executing it as code.
   */
  installFromUrl: protectedProcedure
    .input(
      z.object({
        url: z.string().url("Must be a valid URL"),
        workspaceId: z.string().uuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      // Fetch the remote skill file
      let rawContent: string;
      const fetchHeaders = {
        Accept: "text/plain, text/markdown, application/toml, */*",
      };
      try {
        // SSRF guard: validate every hop (including redirects) against internal
        // targets. No credentials are sent, so a small redirect budget preserves
        // the original redirect-following behaviour for skill hosts.
        const res = await safeExternalFetch(
          input.url,
          { headers: fetchHeaders },
          5
        );
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }
        rawContent = await res.text();
      } catch (err) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Failed to fetch skill from URL: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      // Parse as SKILL.md or SKILL.toml
      const isToml =
        input.url.endsWith(".toml") ||
        rawContent.trimStart().startsWith("[skill]");

      let parsed;
      if (isToml) {
        // For TOML manifests, try to load a companion SKILL.md at the same URL base.
        // Many ZeroClaw skills store the instruction markdown separately.
        let companionMarkdown: string | undefined;
        // Build companion URL: replace .toml extension, or append .md for extension-less URLs
        const companionUrl = input.url.endsWith(".toml")
          ? input.url.replace(/\.toml$/i, ".md")
          : `${input.url}.md`;
        try {
          const companionRes = await safeExternalFetch(
            companionUrl,
            { headers: fetchHeaders },
            5
          );
          if (companionRes.ok) {
            const ct = companionRes.headers.get("content-type") ?? "";
            // Only accept text responses (markdown, plain text) — reject HTML/JSON/binary
            if (ct.includes("text/") || ct === "") {
              companionMarkdown = await companionRes.text();
              // Sanity check: ignore if it looks like an HTML error page
              if (companionMarkdown.trimStart().startsWith("<!")) {
                companionMarkdown = undefined;
              }
            }
          }
        } catch {
          // Non-fatal — inline instructions in TOML are the fallback
        }
        parsed = parseSkillToml(rawContent, companionMarkdown);
      } else {
        parsed = parseSkillMd(rawContent);
      }

      if (!parsed) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Could not parse the skill file. Expected SKILL.md (YAML frontmatter + markdown) or SKILL.toml format.",
        });
      }

      if (!parsed.instructions.trim()) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Skill has no instructions. Please check the skill file content.",
        });
      }

      // Check if a skill with this name already exists for this user+workspace
      const existing = await db.query.skills.findFirst({
        where: and(
          eq(skills.userId, userId),
          eq(skills.workspaceId, input.workspaceId),
          eq(skills.name, parsed.name)
        ),
      });

      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `A skill named '${parsed.name}' is already installed. Delete it first or install under a different name.`,
        });
      }

      // Store skill — instruction content goes in `body` (the canonical doc column).
      // `code` is the executable JS/TS column; instruction skills have none.
      // Persistence + approval gating goes through the ONE governed door
      // (insertSkillGoverned) — never a direct insert with a hardcoded
      // `approved: true` (that was the prompt-injection hole this closes).
      const result = await insertSkillGoverned({
        userId,
        workspaceId: input.workspaceId,
        kind: "instruction",
        scope: "pod",
        name: parsed.name,
        description: parsed.description,
        body: parsed.instructions,
        code: null,
        category: "instruction",
        executionMode: "sync",
        metadata: {
          source: parsed.source,
          version: parsed.version,
          installedFromUrl: input.url,
          dependencies: parsed.dependencies,
        },
        auditSource: "install_from_url",
      });

      if (result.status === "denied") {
        throw new TRPCError({ code: "FORBIDDEN", message: result.reason });
      }
      if (result.status === "proposed") {
        return {
          status: "proposed" as const,
          proposalId: result.proposalId,
        };
      }

      return {
        id: result.skill.id,
        name: result.skill.name,
        status: "installed" as const,
        kind: "instruction" as const,
        source: parsed.source,
        version: parsed.version,
      };
    }),

  /**
   * The tools a skill requires (`skill → requires → tool` edges) + the skill.
   * Powers the skill detail page and the editor's tool-attach UI.
   */
  getRequiredTools: protectedProcedure
    .input(z.object({ skillId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const skill = await db.query.skills.findFirst({
        where: and(
          eq(skills.id, input.skillId),
          // Pod-scoped: any user. User/workspace-scoped: owner only. Same floor
          // as skills.get — without it, any skillId leaks its required-tool edges.
          or(eq(skills.scope, "pod"), eq(skills.userId, userId))
        ),
      });
      if (!skill)
        throw new TRPCError({ code: "NOT_FOUND", message: "Skill not found" });
      const edges = await getLinksFor(userId, "skill", input.skillId);
      const toolIds = edges
        .filter((e) => e.linkType === "requires" && e.toType === "tool")
        .map((e) => e.toId);
      const requiredTools = toolIds.length
        ? await db.select().from(tools).where(inArray(tools.id, toolIds))
        : [];
      return { skill, tools: requiredTools };
    }),

  /**
   * Replace the set of tools a skill requires. Diffs against existing `requires`
   * edges — adds new, removes dropped. (One skill ↔ many tools.) Idempotent.
   */
  setRequiredTools: protectedProcedure
    .input(
      z.object({
        skillId: z.string().uuid(),
        toolIds: z.array(z.string().uuid()),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const skill = await db.query.skills.findFirst({
        where: and(
          eq(skills.id, input.skillId),
          // Owner floor before editing the skill's `requires` edges — same gate
          // as getRequiredTools / skills.get. Pod-scoped skills stay editable by
          // any user (existing model); user-scoped skills are owner-only.
          or(eq(skills.scope, "pod"), eq(skills.userId, userId))
        ),
      });
      if (!skill)
        throw new TRPCError({ code: "NOT_FOUND", message: "Skill not found" });

      const edges = await getLinksFor(userId, "skill", input.skillId);
      const existing = edges.filter(
        (e) => e.linkType === "requires" && e.toType === "tool"
      );
      const existingIds = new Set(existing.map((e) => e.toId));
      const wanted = new Set(input.toolIds);

      // Remove edges no longer wanted.
      for (const e of existing) {
        if (!wanted.has(e.toId)) await deleteLink(e.id);
      }
      // Add new edges.
      const toAdd = input.toolIds.filter((id) => !existingIds.has(id));
      if (toAdd.length) {
        await createLinks(
          toAdd.map((toolId) => ({
            workspaceId: skill.workspaceId ?? null,
            fromType: "skill" as const,
            fromId: input.skillId,
            toType: "tool" as const,
            toId: toolId,
            linkType: "requires" as const,
          }))
        );
      }
      return { skillId: input.skillId, toolIds: input.toolIds };
    }),
});
