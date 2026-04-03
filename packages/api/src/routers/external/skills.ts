/**
 * External Skills API — /api/external/skills
 *
 * Option C: Skills as HTTP-Invokable Operations.
 * Lets external callers (Claude Code, custom agents, scripts) list and invoke
 * skills on a data pod via HTTP + API key auth (scope: skills.invoke).
 *
 * GET  /           — list active skills visible to the API key owner
 * POST /:id/invoke — invoke a skill by ID
 *
 * Auth: Bearer API key with scope "skills.invoke" (handled by externalApiKeyAuth).
 * Execution: delegates to the Intelligence Service via the same path as
 *   tRPC skills.execute — zero IS changes required.
 */

import { Hono } from "hono";
import { z } from "zod";
import { db, eq, and, or } from "@synap/database";
import { skills, workspaceMembers } from "@synap/database/schema";
import { resolveIntelligenceService } from "../../utils/intelligence-routing.js";
import { createLogger } from "@synap-core/core";
import { externalApiKeyAuth, type ExternalApiVariables } from "./middleware.js";

const logger = createLogger({ module: "external-skills" });

const invokeBodySchema = z.object({
  input: z.record(z.string(), z.unknown()).optional(),
});

export const externalSkillsApp = new Hono<{
  Variables: ExternalApiVariables;
}>();

// ── List active skills ────────────────────────────────────────────────────────

/**
 * GET /
 * Returns all active skills that the API key owner may see:
 *   - scope = "pod"       → visible to all users on the pod
 *   - scope = "user"      → only the owning user
 *   - scope = "workspace" → members of the related workspace
 *
 * For simplicity the query fetches all active skills and filters in-memory
 * for workspace-scoped ones, because the workspace membership join is cheaper
 * to express at the application layer for this low-frequency endpoint.
 */
externalSkillsApp.get("/", externalApiKeyAuth("skills.invoke"), async (c) => {
  const userId = c.get("userId");

  // Fetch all active pod-scoped or user-owned skills in one query.
  // Workspace-scoped skills need a membership check — done below.
  const rows = await db.query.skills.findMany({
    where: and(
      eq(skills.status, "active"),
      or(eq(skills.scope, "pod"), eq(skills.userId, userId))
    ),
    columns: {
      id: true,
      name: true,
      description: true,
      scope: true,
      parameters: true,
      executionMode: true,
      timeoutSeconds: true,
      kind: true,
    },
  });

  // Also fetch workspace-scoped skills whose workspace the user belongs to.
  const workspaceSkills = await db
    .select({
      id: skills.id,
      name: skills.name,
      description: skills.description,
      scope: skills.scope,
      parameters: skills.parameters,
      executionMode: skills.executionMode,
      timeoutSeconds: skills.timeoutSeconds,
      kind: skills.kind,
    })
    .from(skills)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, skills.workspaceId!),
        eq(workspaceMembers.userId, userId)
      )
    )
    .where(and(eq(skills.status, "active"), eq(skills.scope, "workspace")));

  // Deduplicate (a skill could theoretically match both queries if data is inconsistent)
  const seen = new Set<string>();
  const combined = [...rows, ...workspaceSkills].filter((s) => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });

  return c.json(combined);
});

// ── Invoke a skill ────────────────────────────────────────────────────────────

/**
 * POST /:id/invoke
 * Mirrors tRPC skills.execute exactly:
 *   1. Look up skill, verify active + accessible.
 *   2. Resolve intelligence service (workspace pref → user pref → env).
 *   3. POST to IS /api/skills/execute.
 *   4. Update metadata.executionCount + metadata.lastTestedAt on success.
 *   5. Return IS result JSON directly.
 *
 * Scope rules:
 *   pod       → any valid skills.invoke key
 *   user      → only if key owner === skill.userId
 *   workspace → only if key owner is a member of skill.workspaceId
 */
externalSkillsApp.post(
  "/:id/invoke",
  externalApiKeyAuth("skills.invoke"),
  async (c) => {
    const userId = c.get("userId");
    const skillId = c.req.param("id")!;

    // Parse + validate request body
    let parsedBody: { input?: Record<string, unknown> };
    try {
      const raw = await c.req.json();
      const parsed = invokeBodySchema.safeParse(raw);
      if (!parsed.success) {
        return c.json(
          { error: "Invalid request body", details: parsed.error.issues },
          400
        );
      }
      parsedBody = parsed.data;
    } catch {
      // Empty body is fine — treat as no input
      parsedBody = {};
    }

    // Look up skill
    const skill = await db.query.skills.findFirst({
      where: eq(skills.id, skillId),
    });

    if (!skill) {
      return c.json({ error: "Skill not found" }, 404);
    }

    if (skill.status !== "active") {
      return c.json(
        { error: `Skill is not active (status: ${skill.status})` },
        400
      );
    }

    // Scope access check
    if (skill.scope === "user" && skill.userId !== userId) {
      return c.json({ error: "Skill not found" }, 404); // Treat as 404 to avoid info leak
    }

    if (skill.scope === "workspace" && skill.workspaceId) {
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, skill.workspaceId),
          eq(workspaceMembers.userId, userId)
        ),
        columns: { userId: true },
      });
      if (!membership) {
        return c.json({ error: "Skill not found" }, 404); // Treat as 404 to avoid info leak
      }
    }

    // Resolve the intelligence service (same logic as tRPC skills.execute)
    let hubUrl: string;
    let hubApiKey: string;
    try {
      const resolved = await resolveIntelligenceService({
        userId,
        workspaceId: skill.workspaceId ?? undefined,
      });
      hubUrl = resolved.endpoint;
      hubApiKey = resolved.serviceApiKey;
    } catch (err) {
      logger.error(
        { skillId, err: err instanceof Error ? err.message : String(err) },
        "Failed to resolve intelligence service"
      );
      return c.json({ error: "Intelligence service unavailable" }, 502);
    }

    // Delegate execution to IS
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
          skillId,
          userId,
          parameters: parsedBody.input ?? {},
        }),
      });

      if (!response.ok) {
        logger.warn(
          { skillId, status: response.status },
          "Intelligence service returned non-OK status"
        );
        return c.json(
          { error: `Skill execution failed: IS returned ${response.status}` },
          502
        );
      }

      result = (await response.json()) as typeof result;
    } catch (err) {
      logger.error(
        { skillId, err: err instanceof Error ? err.message : String(err) },
        "Failed to reach intelligence service for skill execution"
      );
      return c.json({ error: "Intelligence service unreachable" }, 502);
    }

    // Update execution metadata on success (mirrors tRPC skills.execute)
    if (result.success) {
      try {
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
          .where(eq(skills.id, skillId));
      } catch (err) {
        // Metadata update failure is non-critical — don't fail the response
        logger.warn(
          { skillId, err: err instanceof Error ? err.message : String(err) },
          "Failed to update skill execution metadata"
        );
      }
    }

    return c.json(result);
  }
);
