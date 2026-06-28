/**
 * Tools router — CRUD for the capability substrate's `tools` (integrations +
 * vault-backed credentials). Tools are CONFIG; pod-wide by default (null
 * workspaceId). The session room / Capabilities settings consume this.
 *
 * `get` also returns the skills that `require` this tool (the links graph),
 * so a tool detail page can show "the skills that use it".
 */
import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { db, eq, and, or, isNull, inArray, desc } from "@synap/database";
import { tools, skills, links, secrets } from "@synap/database/schema";
import type { Tool } from "@synap/database/schema";
import { requireUserId } from "../utils/user-scoped.js";
import { userVisibleWhere } from "../utils/user-visible-where.js";
import { checkPermissionOrPropose } from "../utils/permission-check.js";
import { assertWorkspaceWrite } from "../utils/workspace-write-access.js";
import { auditLog } from "../utils/audit-log.js";
import { getLinksFor } from "../services/links/links-service.js";
import { getWorkspaceRole, requirePodAdmin } from "../utils/workspace-role.js";
import { emitSideEffects } from "@synap/events";

const TOOL_KINDS = [
  "builtin",
  "api",
  "mcp",
  "provider",
  "external",
  "script",
] as const;
const EXECUTORS = ["is-agent", "external-agent", "hybrid"] as const;

export const toolsRouter = router({
  /** Tools visible to the caller: pod-wide (null ws) + the given workspace. */
  list: protectedProcedure
    .input(
      z
        .object({
          workspaceId: z.string().uuid().optional(),
          limit: z.number().min(1).max(200).default(100),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const ws = input?.workspaceId;
      // AND the workspace lens with the user-visible floor so a non-member
      // passing another workspace's id sees only pod-wide + their own rows.
      const lens = ws
        ? or(isNull(tools.workspaceId), eq(tools.workspaceId, ws))
        : isNull(tools.workspaceId);
      const rows = await db
        .select()
        .from(tools)
        .where(and(lens, userVisibleWhere(tools.workspaceId, userId)))
        .orderBy(desc(tools.createdAt))
        .limit(input?.limit ?? 100);
      return rows as Tool[];
    }),

  /** A tool + the skills that `require` it (for the tool detail page). */
  get: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      // Fold the user-visible floor into the lookup so a non-member can never
      // read another workspace's tool (pod-wide null-ws tools stay visible).
      const tool = await db.query.tools.findFirst({
        where: and(
          eq(tools.id, input.id),
          userVisibleWhere(tools.workspaceId, userId)
        ),
      });
      if (!tool)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Tool ${input.id} not found`,
        });

      const edges = await getLinksFor(ctx.userId, "tool", input.id);
      const skillIds = edges
        .filter((e) => e.linkType === "requires" && e.fromType === "skill")
        .map((e) => e.fromId);
      const requiredBy = skillIds.length
        ? await db.select().from(skills).where(inArray(skills.id, skillIds))
        : [];
      return { tool: tool as Tool, skills: requiredBy };
    }),

  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(255),
        kind: z.enum(TOOL_KINDS),
        description: z.string().optional(),
        inputSchema: z.record(z.string(), z.unknown()).optional(),
        credentialRef: z.string().optional(),
        executor: z.enum(EXECUTORS).default("is-agent"),
        config: z.record(z.string(), z.unknown()).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        /** Omit (null) for pod-wide. */
        workspaceId: z.string().uuid().optional(),
        agentUserId: z.string().uuid().optional(),
        source: z.string().optional(),
        reasoning: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const perm = await checkPermissionOrPropose({
        userId,
        agentUserId: input.agentUserId,
        workspaceId: input.workspaceId,
        subjectType: "tool",
        action: "create",
        source: input.source,
        reasoning: input.reasoning,
        data: { name: input.name, kind: input.kind },
      });
      if ("denied" in perm && perm.denied)
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      if ("proposalId" in perm)
        return {
          tool: null as Tool | null,
          status: "proposed" as const,
          proposalId: perm.proposalId,
        };

      const [tool] = await db
        .insert(tools)
        .values({
          workspaceId: input.workspaceId ?? null,
          createdBy: input.agentUserId ?? userId,
          name: input.name,
          description: input.description,
          kind: input.kind,
          inputSchema: input.inputSchema ?? {},
          credentialRef: input.credentialRef,
          executor: input.executor,
          config: input.config ?? {},
          metadata: input.metadata ?? {},
        })
        .returning();
      emitSideEffects({
        subjectType: "tool",
        action: "create",
        subjectId: tool.id,
        userId,
        workspaceId: input.workspaceId,
      });
      return {
        tool: tool as Tool,
        status: "created" as const,
        proposalId: null as string | null,
      };
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: z.string().min(1).max(255).optional(),
        description: z.string().optional(),
        credentialRef: z.string().optional(),
        config: z.record(z.string(), z.unknown()).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        executor: z.enum(EXECUTORS).optional(),
        kind: z.enum(TOOL_KINDS).optional(),
        inputSchema: z.record(z.string(), z.unknown()).optional(),
        status: z.enum(["active", "inactive", "error"]).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const existing = await db.query.tools.findFirst({
        where: eq(tools.id, input.id),
      });
      if (!existing)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Tool ${input.id} not found`,
        });
      // Pod-wide (null-workspace) tools have no RBAC layer inside
      // checkPermissionOrPropose (it grants when workspaceId is falsy), so gate
      // the privileged pod-level case explicitly — mirrors setApproved /
      // setAuthBinding / delete. Without this any user could re-point a pod-wide
      // tool's name/description/config.
      if (!existing.workspaceId) await requirePodAdmin(userId);
      const perm = await checkPermissionOrPropose({
        userId,
        workspaceId: existing.workspaceId ?? undefined,
        subjectType: "tool",
        action: "update",
        data: { id: input.id },
      });
      if ("denied" in perm && perm.denied)
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      if ("proposalId" in perm)
        return {
          tool: null as Tool | null,
          status: "proposed" as const,
          proposalId: perm.proposalId,
        };

      // Security: if any execution-defining field changes, the tool may now run
      // something different from what was approved — reset approval so an
      // approved tool can't be silently re-pointed to run untrusted code.
      const RE_APPROVAL_FIELDS = [
        "credentialRef",
        "config",
        "executor",
        "kind",
        "inputSchema",
      ] as const;
      const execChanged = RE_APPROVAL_FIELDS.some(
        (k) => (input as Record<string, unknown>)[k] !== undefined
      );

      const [tool] = await db
        .update(tools)
        .set({
          name: input.name ?? existing.name,
          description: input.description ?? existing.description,
          credentialRef: input.credentialRef ?? existing.credentialRef,
          config: input.config ?? existing.config,
          metadata: input.metadata ?? existing.metadata,
          executor: input.executor ?? existing.executor,
          kind: input.kind ?? existing.kind,
          inputSchema: input.inputSchema ?? existing.inputSchema,
          status: input.status ?? existing.status,
          ...(execChanged ? { approved: false } : {}),
          updatedAt: new Date(),
        })
        .where(eq(tools.id, input.id))
        .returning();
      return {
        tool: tool as Tool,
        status: "updated" as const,
        proposalId: null as string | null,
      };
    }),

  /**
   * Approve or revoke approval for a tool's execution. Owner-gated (workspace
   * owner, or pod-admin for pod-wide null-workspace tools) — mirrors
   * `mcpServersRouter.setApproved`. An unapproved tool is refused by the
   * dispatcher (`external-dispatch.ts`).
   */
  setApproved: protectedProcedure
    .input(z.object({ id: z.string().uuid(), approved: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const existing = await db.query.tools.findFirst({
        where: eq(tools.id, input.id),
      });
      if (!existing)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Tool ${input.id} not found`,
        });
      if (existing.workspaceId) {
        const role = await getWorkspaceRole(userId, existing.workspaceId);
        if (role !== "owner") {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Only workspace owners can approve tool execution.",
          });
        }
      } else {
        // Pod-wide (null-workspace) tool — pod-level privileged action.
        await requirePodAdmin(userId);
      }

      const [tool] = await db
        .update(tools)
        .set({ approved: input.approved, updatedAt: new Date() })
        .where(eq(tools.id, input.id))
        .returning();
      return { tool: tool as Tool };
    }),

  /**
   * Set a tool's dynamic auth binding (static · per_user · per_agent ·
   * per_entity). Owner-gated, mirroring setApproved: workspace tool → owner;
   * pod-wide → pod-admin. Changing the binding RESETS approval — the trust
   * decision covers WHOSE credential the tool runs with, not just what it does:
   * static→per_entity means it now runs against subject-supplied credentials the
   * approver never vetted, so the owner must re-affirm (like `update` does when
   * an execution-defining field changes).
   */
  setAuthBinding: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        authBinding: z.enum(["static", "per_user", "per_agent", "per_entity"]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const existing = await db.query.tools.findFirst({
        where: eq(tools.id, input.id),
      });
      if (!existing)
        throw new TRPCError({ code: "NOT_FOUND", message: "Tool not found" });
      if (existing.workspaceId) {
        const role = await getWorkspaceRole(userId, existing.workspaceId);
        if (role !== "owner")
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Only workspace owners can change a tool's auth binding.",
          });
      } else {
        await requirePodAdmin(userId);
      }
      const bindingChanged = existing.authBinding !== input.authBinding;
      const [tool] = await db
        .update(tools)
        .set({
          authBinding: input.authBinding,
          // Re-affirm trust whenever the binding actually changes.
          ...(bindingChanged ? { approved: false } : {}),
          updatedAt: new Date(),
        })
        .where(eq(tools.id, input.id))
        .returning();
      return { tool: tool as Tool };
    }),

  /**
   * List the credentials bound to a tool for a dynamic auth binding — the
   * `provides_credential` edges scoped to this tool. Powers the Authentication
   * step's "who has a credential" list. OWNER-GATED: the binding graph maps
   * principalId→secretId and must not leak to non-owners, so the caller must own
   * the tool (workspace owner / pod-admin) — same gate as bind/unbind.
   */
  listBoundCredentials: protectedProcedure
    .input(z.object({ toolId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const tool = await db.query.tools.findFirst({
        where: eq(tools.id, input.toolId),
      });
      if (!tool)
        throw new TRPCError({ code: "NOT_FOUND", message: "Tool not found" });
      if (tool.workspaceId) {
        const role = await getWorkspaceRole(userId, tool.workspaceId);
        if (role !== "owner")
          throw new TRPCError({
            code: "FORBIDDEN",
            message:
              "Only workspace owners can view a tool's bound credentials.",
          });
      } else {
        await requirePodAdmin(userId);
      }
      const edges = await db
        .select()
        .from(links)
        .where(eq(links.linkType, "provides_credential"));
      return edges
        .filter(
          (e) =>
            (e.metadata as { toolId?: string } | null)?.toolId === input.toolId
        )
        .map((e) => ({
          linkId: e.id,
          principalType: e.fromType,
          principalId: e.fromId,
          secretId: e.toId,
        }));
    }),

  /**
   * Bind a credential (vault secret) to a principal/entity for a tool's dynamic
   * auth binding: `principal|entity --provides_credential--> secret`
   * (metadata.toolId scopes it). Owner-gated. Idempotent on the unique edge.
   */
  bindCredential: protectedProcedure
    .input(
      z.object({
        toolId: z.string().uuid(),
        principalType: z.enum(["participant", "entity"]),
        principalId: z.string().min(1),
        secretId: z.string().uuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const tool = await db.query.tools.findFirst({
        where: eq(tools.id, input.toolId),
      });
      if (!tool)
        throw new TRPCError({ code: "NOT_FOUND", message: "Tool not found" });
      if (tool.workspaceId) {
        const role = await getWorkspaceRole(userId, tool.workspaceId);
        if (role !== "owner")
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Only workspace owners can bind tool credentials.",
          });
      } else {
        await requirePodAdmin(userId);
      }
      // The secret must exist AND belong to the acting user — never bind a
      // caller-supplied secret id the caller doesn't own (else an owner could
      // point a tool at another user's vault secret, which the dispatcher would
      // then decrypt at execution under the tool's authority).
      const [secret] = await db
        .select({ id: secrets.id, userId: secrets.userId })
        .from(secrets)
        .where(eq(secrets.id, input.secretId))
        .limit(1);
      if (!secret || secret.userId !== userId)
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Secret not found in your vault.",
        });
      const [edge] = await db
        .insert(links)
        .values({
          workspaceId: tool.workspaceId,
          fromType: input.principalType,
          fromId: input.principalId,
          toType: "secret",
          toId: input.secretId,
          linkType: "provides_credential",
          metadata: { toolId: input.toolId },
          createdBy: userId,
        })
        .onConflictDoNothing()
        .returning();
      return { linkId: edge?.id ?? null };
    }),

  /** Remove a bound credential edge (owner-gated by the linked tool). */
  unbindCredential: protectedProcedure
    .input(z.object({ linkId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const [edge] = await db
        .select()
        .from(links)
        .where(eq(links.id, input.linkId))
        .limit(1);
      if (!edge || edge.linkType !== "provides_credential")
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Credential binding not found",
        });
      const toolId = (edge.metadata as { toolId?: string } | null)?.toolId;
      const tool = toolId
        ? await db.query.tools.findFirst({ where: eq(tools.id, toolId) })
        : undefined;
      if (tool?.workspaceId) {
        const role = await getWorkspaceRole(userId, tool.workspaceId);
        if (role !== "owner")
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Only workspace owners can unbind tool credentials.",
          });
      } else if (tool) {
        // Pod-wide tool — pod-level privileged action.
        await requirePodAdmin(userId);
      } else {
        // Orphan edge (tool deleted / metadata missing): gate on the binding's
        // creator, falling back to pod-admin — never a silent confused-deputy.
        if (edge.createdBy !== userId) await requirePodAdmin(userId);
      }
      await db.delete(links).where(eq(links.id, input.linkId));
      return { ok: true };
    }),

  /**
   * Delete a tool. Governed: AI-initiated deletes propose, human deletes
   * execute (checkPermissionOrPropose). The write-gate keys off the LOADED
   * row's workspaceId (never a request-supplied one) — pod-wide (null-ws)
   * tools require the owner. Deleting a tool frees its credentialRef under the
   * 0140 unique index; its capability_grants become lazily-dead (no cascade).
   */
  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      const existing = await db.query.tools.findFirst({
        where: eq(tools.id, input.id),
      });
      if (!existing)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Tool ${input.id} not found`,
        });

      // Write-gate on the LOADED row's workspaceId (never input.workspaceId).
      await assertWorkspaceWrite(db, userId, {
        workspaceId: existing.workspaceId,
        ownerId: existing.createdBy,
      });

      const perm = await checkPermissionOrPropose({
        userId,
        workspaceId: existing.workspaceId ?? undefined,
        subjectType: "tool",
        action: "delete",
        data: { id: input.id },
      });
      if ("denied" in perm && perm.denied)
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      if ("proposalId" in perm)
        return { status: "proposed" as const, proposalId: perm.proposalId };

      await db.delete(tools).where(eq(tools.id, input.id));

      auditLog({
        subjectType: "tool",
        action: "delete",
        phase: "completed",
        subjectId: input.id,
        userId,
        workspaceId: existing.workspaceId ?? undefined,
        data: { id: input.id },
      });

      emitSideEffects({
        subjectType: "tool",
        action: "delete",
        subjectId: input.id,
        userId,
        workspaceId: existing.workspaceId ?? undefined,
      });

      return { status: "deleted" as const, proposalId: null as string | null };
    }),
});
