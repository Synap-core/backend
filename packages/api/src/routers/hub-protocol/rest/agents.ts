/**
 * Hub Protocol REST — agents (sync from intelligence service)
 */

import { z } from "zod";
import {
  db,
  agents,
  intelligenceServices,
  drizzleSql,
  eq,
  and,
  or,
} from "@synap/database";

import { hasScope, logger, type HubHono } from "./_shared.js";

/**
 * Zod payload for POST /agents/sync.
 */
const SyncAgentsPayload = z.object({
  serviceId: z.string(),
  agents: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      slug: z.string(),
      description: z.string().nullish().optional(),
      icon: z.string().nullish().optional(),
      capabilities: z.array(z.string()),
      metadata: z.record(z.string(), z.unknown()).nullish().optional(),
    })
  ),
});

export function registerAgentsRoutes(app: HubHono): void {
  /**
   * POST /agents/sync — synchronise an intelligence service's agent registry.
   *
   * Receives a list of agent definitions from the IS / orchestrator and persists
   * them as the canonical source of truth for that service's agents.
   *
   * Logic:
   *   - Upserts each supplied agent (by service + slug uniqueness)
   *   - Deactivates any agent previously known for this service that is
   *     absent from the incoming payload (active = false, no delete)
   */
  app.post("/agents/sync", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }

    const body = SyncAgentsPayload.safeParse(await c.req.json());
    if (!body.success) {
      return c.json(
        {
          error: "Validation failed",
          details: body.error.flatten().fieldErrors,
        },
        400
      );
    }

    const { serviceId, agents: agentsPayload } = body.data;

    let resolvedServiceId: string | null = null;

    // Resolve the service by EITHER its primary id OR its stable serviceId text
    // key. The IS sends its serviceId (e.g. "synap-hub"), not the pod-assigned
    // row id — matching only on id is why agent sync silently 404'd.
    try {
      const service = await db
        .select({ id: intelligenceServices.id })
        .from(intelligenceServices)
        .where(
          or(
            eq(intelligenceServices.id, serviceId),
            eq(intelligenceServices.serviceId, serviceId)
          )
        )
        .limit(1);
      resolvedServiceId = service[0]?.id ?? null;
    } catch (err) {
      // A DB error here is infrastructure, not a lookup miss — surface it as 500
      // rather than masquerading as "service not found".
      logger.error(
        { err, serviceId },
        "Failed to resolve intelligence service"
      );
      return c.json({ error: "Failed to resolve intelligence service" }, 500);
    }

    if (!resolvedServiceId) {
      return c.json(
        { error: `Intelligence service not found: ${serviceId}` },
        404
      );
    }

    try {
      // ── 1. Upsert each agent ──────────────────────────────────────────────────
      let syncedCount = 0;
      for (const agent of agentsPayload) {
        const upserted = await db
          .insert(agents)
          .values({
            id: agent.id,
            name: agent.name,
            slug: agent.slug,
            description: agent.description ?? null,
            icon: agent.icon ?? null,
            capabilities: agent.capabilities,
            metadata: agent.metadata,
            active: true,
            ownerType: "synap",
            intelligenceServiceId: resolvedServiceId,
            createdAt: new Date(),
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [agents.intelligenceServiceId, agents.slug],
            set: {
              // NOT id — the conflict target identifies the row; rewriting the
              // PK to the incoming id can collide with another row's id.
              name: agent.name,
              description:
                agent.description ?? drizzleSql`${agents.description}`,
              icon: agent.icon ?? drizzleSql`${agents.icon}`,
              capabilities: agent.capabilities,
              metadata: agent.metadata,
              active: true,
              ownerType: "synap",
              intelligenceServiceId: resolvedServiceId,
              updatedAt: new Date(),
            },
          })
          .returning({ insertedId: agents.id });

        if (upserted.length > 0) {
          syncedCount++;
        }
      }

      // ── 2. Deactivate agents that were not in the payload ─────────────────────
      // An empty payload means "deactivate everything for this service" — the
      // VALUES (...) subquery would be invalid SQL with zero rows, so branch.
      const deactivatedResult =
        agentsPayload.length === 0
          ? await db
              .update(agents)
              .set({ active: false, updatedAt: new Date() })
              .where(
                and(
                  eq(agents.intelligenceServiceId, resolvedServiceId),
                  eq(agents.active, true)
                )
              )
              .returning({ id: agents.id })
          : await db
              .update(agents)
              .set({ active: false, updatedAt: new Date() })
              .where(
                and(
                  eq(agents.intelligenceServiceId, resolvedServiceId),
                  eq(agents.active, true),
                  drizzleSql`NOT EXISTS (
            SELECT 1 FROM (VALUES ${agentsPayload.map((a) => drizzleSql`${a.slug}`)}) AS v(slug)
            WHERE v.slug = ${agents.slug}
          )`
                )
              )
              .returning({ id: agents.id });

      const deactivatedCount = deactivatedResult.length;

      return c.json({
        status: "success",
        synced: syncedCount,
        deactivated: deactivatedCount,
      });
    } catch (err) {
      logger.error({ err, serviceId }, "POST /agents/sync failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
