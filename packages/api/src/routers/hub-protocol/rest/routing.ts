/**
 * Routing Resolver — the centralized, extendable knowledge-routing contract.
 *
 * ONE endpoint (`POST /api/hub/routing/resolve`) is the single source of truth
 * for where any knowledge write should go. The CLI, the IS agent, and any future
 * adjunct call this instead of duplicating routing rules. Adding a new lane is
 * one entry in the RULES table — no code changes needed anywhere else.
 *
 * Design principle: centralized, extendable, agnostic. The backend is the
 * single source of truth; every surface derives from it, never duplicates it.
 */

import { z } from "@hono/zod-openapi";
import { logger } from "./_shared.js";
import type { HubHono } from "./_shared.js";
import type { Context } from "hono";

// ── Routing rules — the extensible config ────────────────────────────────
// Adding a new lane = one entry here. The endpoint resolves against this table.

interface RoutingRule {
  lane: string;
  profileSlug: string;
  scope: "workspace" | "pod" | "global";
  /** null = the destination is pod/global, not workspace-scoped */
  workspaceId?: string | null;
  governance: "auto" | "proposed";
  description: string;
}

const ROUTING_RULES: RoutingRule[] = [
  {
    lane: "work",
    profileSlug: "knowledge",
    scope: "workspace",
    governance: "proposed",
    description:
      "Project/domain knowledge — lives in a workspace, reviewed before it becomes canonical.",
  },
  {
    lane: "user",
    profileSlug: "user_observation",
    scope: "pod",
    workspaceId: null,
    governance: "proposed",
    description:
      "Durable model of the user — pod-scoped, inferred observations are gated for review.",
  },
  {
    lane: "global",
    profileSlug: "__knowledge_key__",
    scope: "global",
    workspaceId: null,
    governance: "proposed",
    description:
      "Cross-project best-practice / runbook — stored as a knowledge_keys entry, not an entity.",
  },
];

// ── Zod schema ───────────────────────────────────────────────────────────

const ResolveRoutingSchema = z.object({
  lane: z.enum(["work", "user", "global"]),
  workspaceId: z.string().uuid().optional(),
  userId: z.string().min(1),
});

// ── Register ─────────────────────────────────────────────────────────────

export function registerRoutingRoutes(app: HubHono): void {
  app.post("/routing/resolve", async (c: Context) => {
    const body = await c.req.json().catch(() => null);
    const parsed = ResolveRoutingSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }

    const { lane, workspaceId } = parsed.data;
    const rule = ROUTING_RULES.find((r) => r.lane === lane);
    if (!rule) {
      return c.json({ error: `Unknown lane: ${lane}` }, 400);
    }

    // Resolve: work uses the caller's workspaceId or active ws; user/global are pod-wide
    const destination = {
      lane: rule.lane,
      profileSlug: rule.profileSlug,
      scope: rule.scope,
      workspaceId: rule.workspaceId ?? workspaceId ?? null,
      governance: rule.governance,
      description: rule.description,
    };

    logger.info({ lane, destination }, "routing resolved");
    return c.json({ destination });
  });

  // List available lanes — discoverable so surfaces don't hardcode the enum
  app.get("/routing/lanes", (c: Context) => {
    return c.json({
      lanes: ROUTING_RULES.map((r) => ({
        lane: r.lane,
        description: r.description,
        governance: r.governance,
      })),
    });
  });
}
