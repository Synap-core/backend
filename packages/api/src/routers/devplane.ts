/**
 * DevPlane Router
 *
 * Provides DevPlane-specific procedures for bootstrapping DevPlane profiles
 * into a workspace. DevPlane uses Synap as its data layer.
 */

import { z } from "zod";
import { router, workspaceProcedure } from "../trpc.js";
import { ensureDevplaneProfiles, db, eq, and, desc } from "@synap/database";
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
});
