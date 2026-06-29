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
import { userVisibleWhere } from "../utils/user-visible-where.js";
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

export const skillsRouter = router({
  /**
   * List skills for the current user
   */
  list: protectedProcedure
    .input(
      z
        .object({
          workspaceId: z.string().uuid().optional(),
          kind: z.enum(["instruction", "code"]).optional(),
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

      // Three-tier scope filtering:
      //   pod       — visible to all users on the data pod (no userId/workspaceId filter)
      //   user      — visible only to the owning user
      //   workspace — visible to all members of the workspace
      if (input?.workspaceId) {
        conditions.push(
          or(
            eq(skills.scope, "pod"),
            and(eq(skills.scope, "user"), eq(skills.userId, userId)),
            and(
              eq(skills.scope, "workspace"),
              eq(skills.workspaceId, input.workspaceId),
              // Membership guard — without it, any caller could read another
              // workspace's "workspace"-scoped skills (code/instructions) by id.
              userVisibleWhere(skills.workspaceId, userId)
            )
          )!
        );
      } else {
        // No workspace context — pod-wide + user-owned only
        conditions.push(
          or(
            eq(skills.scope, "pod"),
            and(eq(skills.scope, "user"), eq(skills.userId, userId))
          )!
        );
      }

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
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const skill = await ctx.db.query.skills.findFirst({
        where: and(
          eq(skills.id, input.id),
          // Pod-scoped: any user. User-scoped: owner only.
          or(eq(skills.scope, "pod"), eq(skills.userId, userId))
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
        // `provider` = a declarative Tier-1 verb (carries `providerSpec`).
        kind: z.enum(["instruction", "code", "provider"]).optional(),
        scope: z.enum(["pod", "user", "workspace"]).default("pod"),
        agentTypes: z.array(z.string()).optional(),
        name: z.string().min(1).max(255),
        description: z.string().optional(),
        /** Documentation (Markdown): what the skill does + when to use it. */
        body: z.string().optional(),
        /** Optional executable — present ⇒ the skill is runnable (sandboxed). */
        code: z.string().optional(),
        /** Declarative provider-verb spec (kind="provider"). */
        providerSpec: z.record(z.string(), z.unknown()).optional(),
        parameters: z.record(z.string(), z.unknown()).optional(),
        category: z.string().optional(),
        executionMode: z.enum(["sync", "async"]).default("sync"),
        timeoutSeconds: z.number().min(1).max(300).default(30),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const skillId = randomUUID();

      // Documentation + optional Code. Derive `kind` from code presence (explicit
      // input.kind still honored). A skill must carry documentation or code.
      const hasCode = !!input.code?.trim();
      const kind = input.kind ?? (hasCode ? "code" : "instruction");
      // A `provider` skill carries a declarative `providerSpec` instead of
      // body/code, so it is exempt from the documentation-or-code requirement.
      if (kind !== "provider" && !input.body?.trim() && !hasCode) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "A skill needs documentation or code.",
        });
      }

      // 1. Permission check
      const perm = await checkPermissionOrPropose({
        userId,
        workspaceId: input.workspaceId,
        subjectType: "skill",
        action: "create",
        data: { id: skillId, name: input.name },
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
          workspaceId: input.workspaceId,
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
        kind: z.enum(["instruction", "code"]).optional(),
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
      const { id, ...updateData } = input;

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
      const execChanged = RE_APPROVAL_FIELDS.some(
        (k) => (updateData as Record<string, unknown>)[k] !== undefined
      );

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
        const res = await fetch(input.url, { headers: fetchHeaders });
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
          const companionRes = await fetch(companionUrl, {
            headers: fetchHeaders,
          });
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

      const skillId = randomUUID();

      // Store skill — instruction content goes in `body` (the canonical doc column).
      // `code` is the executable JS/TS column; instruction skills have none.
      const [skill] = await db
        .insert(skills)
        .values({
          id: skillId,
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
          status: "active",
          // Instruction skills (prompt-only, no side effects) are born approved.
          approved: true,
          metadata: {
            source: parsed.source,
            version: parsed.version,
            installedFromUrl: input.url,
            dependencies: parsed.dependencies,
          },
        })
        .returning();

      auditLog({
        subjectType: "skill",
        action: "create",
        phase: "completed",
        subjectId: skill.id,
        userId,
        workspaceId: input.workspaceId,
        data: {
          name: parsed.name,
          source: parsed.source,
          kind: "instruction",
        },
      });

      return {
        id: skill.id,
        name: skill.name,
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
        where: eq(skills.id, input.skillId),
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
        where: eq(skills.id, input.skillId),
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
