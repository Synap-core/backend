/**
 * DevPlane Router
 *
 * Provides DevPlane-specific procedures for bootstrapping DevPlane profiles
 * into a workspace. DevPlane uses Synap as its data layer.
 */

import { z } from "zod";
import { router, workspaceProcedure } from "../trpc.js";
import {
  ensureDevplaneProfiles,
  db,
  eq,
  and,
  desc,
  count,
} from "@synap/database";
import { entities } from "@synap/database/schema";
import { TRPCError } from "@trpc/server";
import { createLogger } from "@synap-core/core";
import { isVaultReference } from "../utils/vault-resolver.js";

// ─── Shared types ─────────────────────────────────────────────────────────────

export interface RecipeStep {
  name: string;
  command: string;
  continueOnError?: boolean;
}

export interface RunStep {
  name: string;
  command: string;
  status: "success" | "failed" | "skipped";
  exitCode: number;
  output: string;
  startedAt: string;
  finishedAt: string;
}

const logger = createLogger({ module: "devplane-router" });

export const devplaneRouter = router({
  /**
   * Bootstrap DevPlane profiles for the current workspace.
   *
   * Idempotent — safe to call multiple times. Creates the 6 DevPlane
   * entity profiles (app, feature, service, package, environment, deployment)
   * and their property definitions if they do not already exist.
   */
  bootstrap: workspaceProcedure
    .input(z.object({}).optional())
    .mutation(async ({ ctx }) => {
      logger.info(
        { workspaceId: ctx.workspaceId, userId: ctx.userId },
        "Bootstrapping DevPlane profiles"
      );

      const result = await ensureDevplaneProfiles();

      if (result.status === "error") {
        logger.error(
          { workspaceId: ctx.workspaceId, error: result.error },
          "Failed to bootstrap DevPlane profiles"
        );
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: result.error ?? "Failed to bootstrap DevPlane profiles",
        });
      }

      logger.info(
        { workspaceId: ctx.workspaceId, result },
        "DevPlane profiles bootstrapped"
      );

      return {
        success: true,
        message: result.message,
        profilesCreated: result.profilesCreated,
        propertiesCreated: result.propertiesCreated,
        linksCreated: result.linksCreated,
      };
    }),

  /**
   * Get environment connection metadata for a devplane_environment entity.
   *
   * Returns host, SSH user, port, and whether an SSH key is configured.
   * The private key itself is never returned — it remains server-side only
   * and is resolved via the Vault during SSH proxy handshake.
   */
  getEnvironmentInfo: workspaceProcedure
    .input(z.object({ environmentEntityId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const entity = await db.query.entities.findFirst({
        where: and(
          eq(entities.id, input.environmentEntityId),
          eq(entities.userId, ctx.userId)
        ),
        columns: { id: true, type: true, title: true, properties: true },
      });

      if (!entity) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Environment entity not found: ${input.environmentEntityId}`,
        });
      }

      if (entity.type !== "devplane_environment") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Entity is not a devplane_environment (got: ${entity.type})`,
        });
      }

      const props = (entity.properties ?? {}) as Record<string, unknown>;

      return {
        id: entity.id,
        name: entity.title ?? "Unnamed environment",
        host: (props["envHost"] as string | undefined) ?? null,
        port:
          typeof props["envPort"] === "number"
            ? (props["envPort"] as number)
            : 22,
        sshUser: (props["sshUser"] as string | undefined) ?? null,
        hasKey:
          typeof props["sshKeyVaultRef"] === "string" &&
          isVaultReference(props["sshKeyVaultRef"] as string),
      };
    }),

  /**
   * Fetch a devplane_recipe entity and return its typed step list.
   */
  getRecipe: workspaceProcedure
    .input(z.object({ recipeEntityId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const entity = await db.query.entities.findFirst({
        where: and(
          eq(entities.id, input.recipeEntityId),
          eq(entities.userId, ctx.userId)
        ),
        columns: { id: true, type: true, title: true, properties: true },
      });

      if (!entity) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Recipe entity not found: ${input.recipeEntityId}`,
        });
      }

      if (entity.type !== "devplane_recipe") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Entity is not a devplane_recipe (got: ${entity.type})`,
        });
      }

      const props = (entity.properties ?? {}) as Record<string, unknown>;

      let steps: RecipeStep[] = [];
      const rawSteps = props["recipeSteps"] as string | undefined;
      if (rawSteps) {
        try {
          steps = JSON.parse(rawSteps) as RecipeStep[];
        } catch {
          logger.warn(
            { entityId: entity.id },
            "Could not parse recipeSteps JSON"
          );
        }
      }

      return {
        id: entity.id,
        title: entity.title ?? "Unnamed Recipe",
        recipeName: (props["recipeName"] as string | undefined) ?? null,
        recipeDescription:
          (props["recipeDescription"] as string | undefined) ?? null,
        steps,
        linkedEnvironmentId:
          (props["linkedEnvironmentId"] as string | undefined) ?? null,
        linkedAppSlug: (props["linkedAppSlug"] as string | undefined) ?? null,
        onFailure:
          (props["onFailure"] as
            | "stop"
            | "continue"
            | "rollback"
            | undefined) ?? "stop",
        rollbackRecipeId:
          (props["rollbackRecipeId"] as string | undefined) ?? null,
        recipeTemplate:
          (props["recipeTemplate"] as
            | "kamal"
            | "docker-compose"
            | "git-pull"
            | "custom"
            | undefined) ?? null,
      };
    }),

  /**
   * List devplane_recipe_run entities for the current workspace, optionally
   * filtered by recipeId. Returns runs sorted by runStartedAt descending.
   */
  listRecipeRuns: workspaceProcedure
    .input(z.object({ recipeId: z.string().uuid().optional() }))
    .query(async ({ ctx, input }) => {
      const rows = await db.query.entities.findMany({
        where: and(
          eq(entities.type, "devplane_recipe_run"),
          eq(entities.userId, ctx.userId)
        ),
        columns: {
          id: true,
          title: true,
          properties: true,
          createdAt: true,
        },
        orderBy: [desc(entities.createdAt)],
      });

      const runs = rows
        .map((row) => {
          const props = (row.properties ?? {}) as Record<string, unknown>;

          let runSteps: RunStep[] = [];
          const rawRunSteps = props["runSteps"] as string | undefined;
          if (rawRunSteps) {
            try {
              runSteps = JSON.parse(rawRunSteps) as RunStep[];
            } catch {
              // malformed JSON — skip
            }
          }

          return {
            id: row.id,
            title: row.title ?? "Recipe Run",
            recipeId: (props["recipeId"] as string | undefined) ?? null,
            runStatus:
              (props["runStatus"] as
                | "running"
                | "success"
                | "failed"
                | "cancelled"
                | undefined) ?? null,
            runSteps,
            runStartedAt: (props["runStartedAt"] as string | undefined) ?? null,
            runFinishedAt:
              (props["runFinishedAt"] as string | undefined) ?? null,
            runDuration:
              typeof props["runDuration"] === "number"
                ? (props["runDuration"] as number)
                : null,
            triggeredBy:
              (props["triggeredBy"] as "manual" | "automation" | undefined) ??
              "manual",
            createdAt: row.createdAt,
          };
        })
        .filter((run) => {
          if (input.recipeId) {
            return run.recipeId === input.recipeId;
          }
          return true;
        })
        .sort((a, b) => {
          const aTime = a.runStartedAt ? new Date(a.runStartedAt).getTime() : 0;
          const bTime = b.runStartedAt ? new Date(b.runStartedAt).getTime() : 0;
          return bTime - aTime;
        });

      return runs;
    }),

  /**
   * Seed default prompt snippets for the current workspace.
   *
   * Idempotent — checks if any snippets already exist before creating.
   * Called once on first login from the DevPlane frontend.
   */
  seedDefaultSnippets: workspaceProcedure
    .input(z.object({}).optional())
    .mutation(async ({ ctx }) => {
      // Check if snippets already exist for this workspace
      const existing = await db
        .select({ n: count() })
        .from(entities)
        .where(
          and(
            eq(entities.type, "devplane_prompt_snippet"),
            eq(entities.userId, ctx.userId)
          )
        );

      if ((existing[0]?.n ?? 0) > 0) {
        return { seeded: false, message: "Snippets already exist" };
      }

      const defaults: Array<{
        title: string;
        category: string;
        description: string;
        body: string;
      }> = [
        // Deploy
        {
          title: "Deploy app to environment",
          category: "deploy",
          description: "General app deployment with health check",
          body: "Deploy @{arg:app} to @{arg:environment}. Check health endpoints after deploy and report status.",
        },
        {
          title: "Kamal deploy with rollback",
          category: "deploy",
          description: "Zero-downtime deploy via Kamal",
          body: "Run Kamal deploy for @{arg:app} on @{arg:environment}. If health check fails, trigger rollback and report what went wrong.",
        },
        {
          title: "Check deployment status",
          category: "deploy",
          description: "Inspect deployment health and recent logs",
          body: "Check the latest deployment of @{arg:app} on @{arg:environment}. Report any failures, restarts, or warnings in the logs.",
        },
        // Debug
        {
          title: "Debug production error",
          category: "debug",
          description: "Root cause analysis for production errors",
          body: "I'm seeing this error in production on @{arg:service}:\n\n@{arg:error}\n\nWhat are the most likely root causes and debugging steps?",
        },
        {
          title: "Analyze logs",
          category: "debug",
          description: "Parse and interpret service logs",
          body: "Analyze these logs from @{arg:service}:\n\n@{arg:logs}\n\nIdentify errors, warnings, and anomalies. Suggest fixes for each issue.",
        },
        // Test
        {
          title: "Write test cases",
          category: "test",
          description: "Generate test suite for a feature",
          body: "Write comprehensive test cases for @{arg:feature} in @{arg:app}. Include unit tests, edge cases, and failure scenarios.",
        },
        {
          title: "Review test coverage",
          category: "test",
          description: "Identify coverage gaps and untested paths",
          body: "Review test coverage for @{arg:component}. Identify gaps, suggest additional tests, and flag any untested critical paths.",
        },
        // Audit
        {
          title: "Security audit",
          category: "audit",
          description: "Security vulnerability check (OWASP top 10)",
          body: "Perform a security audit of @{arg:component} in @{arg:app}. Check for common vulnerabilities (OWASP top 10), secrets exposure, and injection risks.",
        },
        {
          title: "Performance audit",
          category: "audit",
          description: "Performance bottleneck and N+1 analysis",
          body: "Audit the performance of @{arg:feature} in @{arg:app}. Identify bottlenecks, N+1 queries, and memory leaks. Suggest optimizations.",
        },
        {
          title: "Dependency audit",
          category: "audit",
          description: "Check for CVEs and outdated packages",
          body: "Audit dependencies of @{arg:package}. Identify outdated packages, known CVEs, and unused dependencies. Suggest updates or replacements.",
        },
        // Review
        {
          title: "Code review",
          category: "review",
          description: "Thorough code review with actionable feedback",
          body: "Review the implementation of @{arg:feature} in @{arg:app}. Check for bugs, code quality issues, and adherence to best practices. Be specific.",
        },
        {
          title: "Architecture review",
          category: "review",
          description: "Architecture and design quality review",
          body: "Review the architecture of @{arg:service}. Evaluate scalability, separation of concerns, failure modes, and suggest improvements.",
        },
      ];

      const now = new Date();
      for (const s of defaults) {
        await db.insert(entities).values({
          id: crypto.randomUUID(),
          userId: ctx.userId,
          workspaceId: ctx.workspaceId,
          profileId: null,
          type: "devplane_prompt_snippet",
          title: s.title,
          properties: {
            snippetTitle: s.title,
            snippetCategory: s.category,
            snippetDescription: s.description,
            snippetBody: s.body,
          },
          createdAt: now,
          updatedAt: now,
        });
      }

      logger.info(
        { workspaceId: ctx.workspaceId, count: defaults.length },
        "Seeded default DevPlane snippets"
      );

      return { seeded: true, count: defaults.length };
    }),
});
