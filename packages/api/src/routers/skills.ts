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
import { db, eq, and, desc } from "@synap/database";
import { skills } from "@synap/database/schema";
import { requireUserId } from "../utils/user-scoped.js";
import { checkPermissionOrPropose } from "../utils/permission-check.js";
import { auditLog } from "../utils/audit-log.js";
import { emitSideEffects } from "@synap/jobs";
import { randomUUID } from "crypto";
import { parseSkillMd } from "../skills/skill-md-parser.js";
import { parseSkillToml } from "../skills/skill-toml-parser.js";

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
          scope: z.enum(["user", "workspace"]).optional(),
          status: z.enum(["active", "inactive", "error", "all"]).optional(),
          limit: z.number().min(1).max(100).default(50),
          offset: z.number().min(0).default(0),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const conditions = [eq(skills.userId, userId)];

      if (input?.workspaceId) {
        conditions.push(eq(skills.workspaceId, input.workspaceId));
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
        where: and(eq(skills.id, input.id), eq(skills.userId, userId)),
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
        kind: z.enum(["instruction", "code"]).default("code"),
        scope: z.enum(["user", "workspace"]).default("workspace"),
        agentTypes: z.array(z.string()).optional(),
        name: z.string().min(1).max(255),
        description: z.string().optional(),
        code: z.string().min(1),
        parameters: z.record(z.string(), z.unknown()).optional(),
        category: z.string().optional(),
        executionMode: z.enum(["sync", "async"]).default("sync"),
        timeoutSeconds: z.number().min(1).max(300).default(30),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const skillId = randomUUID();

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

      // 2. Direct DB operation
      const [skill] = await db
        .insert(skills)
        .values({
          id: skillId,
          userId,
          workspaceId: input.workspaceId,
          kind: input.kind,
          scope: input.scope,
          agentTypes: input.agentTypes ?? null,
          name: input.name,
          description: input.description,
          code: input.code,
          parameters: input.parameters || {},
          category: input.category,
          executionMode: input.executionMode,
          timeoutSeconds: input.timeoutSeconds,
          status: "active",
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
        scope: z.enum(["user", "workspace"]).optional(),
        agentTypes: z.array(z.string()).nullable().optional(),
        name: z.string().min(1).max(255).optional(),
        description: z.string().optional(),
        code: z.string().min(1).optional(),
        parameters: z.record(z.string(), z.unknown()).optional(),
        category: z.string().optional(),
        executionMode: z.enum(["sync", "async"]).optional(),
        timeoutSeconds: z.number().min(1).max(300).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const { id, ...updateData } = input;

      // Verify skill exists and belongs to user
      const existingSkill = await ctx.db.query.skills.findFirst({
        where: and(eq(skills.id, id), eq(skills.userId, userId)),
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

      // 2. Direct DB operation
      const [_updated] = await db
        .update(skills)
        .set({
          ...updateData,
          updatedAt: new Date(),
        })
        .where(and(eq(skills.id, id), eq(skills.userId, userId)))
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

      // Verify skill exists and belongs to user
      const existingSkill = await ctx.db.query.skills.findFirst({
        where: and(eq(skills.id, input.id), eq(skills.userId, userId)),
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
      await db
        .delete(skills)
        .where(and(eq(skills.id, input.id), eq(skills.userId, userId)));

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

      // Verify skill exists and belongs to user
      const skill = await ctx.db.query.skills.findFirst({
        where: and(eq(skills.id, input.id), eq(skills.userId, userId)),
      });

      if (!skill) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Skill not found" });
      }

      if (skill.status !== "active") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Skill is not active (status: ${skill.status})`,
        });
      }

      // Delegate execution to Intelligence Hub
      const hubUrl =
        process.env.INTELLIGENCE_HUB_URL ?? "http://localhost:3001";
      const hubApiKey = process.env.INTELLIGENCE_HUB_API_KEY ?? "";

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

      // Store skill — instructions go in `code` field; kind='instruction' tells hub to inject into prompt
      const [skill] = await db
        .insert(skills)
        .values({
          id: skillId,
          userId,
          workspaceId: input.workspaceId,
          kind: "instruction",
          scope: "workspace",
          name: parsed.name,
          description: parsed.description,
          code: parsed.instructions, // instructions text, not executable code
          category: "instruction",
          executionMode: "sync",
          status: "active",
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
});
