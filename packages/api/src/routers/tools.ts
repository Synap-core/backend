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
import { db, eq, or, isNull, inArray, desc } from "@synap/database";
import { tools, skills } from "@synap/database/schema";
import type { Tool } from "@synap/database/schema";
import { requireUserId } from "../utils/user-scoped.js";
import { checkPermissionOrPropose } from "../utils/permission-check.js";
import { getLinksFor } from "../services/links/links-service.js";
import { emitSideEffects } from "@synap/events";

const TOOL_KINDS = ["builtin", "api", "mcp", "provider", "external"] as const;
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
    .query(async ({ input }) => {
      const ws = input?.workspaceId;
      const rows = await db
        .select()
        .from(tools)
        .where(
          ws
            ? or(isNull(tools.workspaceId), eq(tools.workspaceId, ws))
            : isNull(tools.workspaceId)
        )
        .orderBy(desc(tools.createdAt))
        .limit(input?.limit ?? 100);
      return rows as Tool[];
    }),

  /** A tool + the skills that `require` it (for the tool detail page). */
  get: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const tool = await db.query.tools.findFirst({
        where: eq(tools.id, input.id),
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

      const [tool] = await db
        .update(tools)
        .set({
          name: input.name ?? existing.name,
          description: input.description ?? existing.description,
          credentialRef: input.credentialRef ?? existing.credentialRef,
          config: input.config ?? existing.config,
          status: input.status ?? existing.status,
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
});
