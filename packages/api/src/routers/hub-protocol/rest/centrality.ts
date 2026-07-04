/**
 * Hub Protocol REST — /centrality (PageRank centrality status + recompute).
 *
 * Operator-facing window onto the Phase-3 PageRank centrality signal:
 *   - GET  /centrality/status    — has entity_centrality populated? how fresh?
 *   - POST /centrality/recompute — enqueue the PageRank job on demand.
 *
 * The centrality scores live in `entity_centrality`, UPSERTed by the
 * pagerank-centrality worker (packages/jobs/src/workers/pagerank-centrality.ts).
 * The status read MUST tolerate that table being ABSENT (Phase-3 migration not
 * yet applied on a given pod) — it returns `computed:false` instead of 500ing.
 */

import { z } from "@hono/zod-openapi";
import { desc, eq, sql } from "drizzle-orm";

import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import { db, entities, entityCentrality } from "@synap/database";
import {
  hasScope,
  logger,
  resolveActingContext,
  type HubHono,
} from "./_shared.js";

const CentralityTopSchema = z
  .object({
    id: z.string(),
    title: z.string().nullable(),
    score: z.number(),
  })
  .openapi("CentralityTopEntity");

const CentralityStatusSchema = z
  .object({
    computed: z.boolean(),
    rows: z.number(),
    lastComputedAt: z.string().nullable(),
    oldestComputedAt: z.string().nullable(),
    top: z.array(CentralityTopSchema),
    note: z.string().optional(),
  })
  .openapi("CentralityStatus");

const CentralityRecomputeSchema = z
  .object({
    triggered: z.boolean(),
    note: z.string().optional(),
  })
  .openapi("CentralityRecompute");

export function registerCentralityRoutes(app: HubHono): void {
  // ── GET /centrality/status ──────────────────────────────────────────────
  registerOpenApi(app, {
    method: "get",
    path: "/centrality/status",
    tags: ["System"],
    summary: "PageRank centrality status for the caller",
    description:
      "Reports whether the Phase-3 PageRank centrality has populated the " +
      "`entity_centrality` table for the calling user: row count, freshness " +
      "(last/oldest computedAt), and the top entities by score. Tolerates the " +
      "table being absent (migration pending) — returns `computed:false` rather " +
      "than erroring.",
    responses: {
      200: { description: "Centrality status", schema: CentralityStatusSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
    },
  });

  app.get("/centrality/status", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const acting = await resolveActingContext(c, {});
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    const { userId } = acting;

    try {
      // Aggregate: rows + freshness bounds for this user.
      const [agg] = await db
        .select({
          rows: sql<number>`count(*)::int`,
          last: sql<Date | null>`max(${entityCentrality.computedAt})`,
          oldest: sql<Date | null>`min(${entityCentrality.computedAt})`,
        })
        .from(entityCentrality)
        .where(eq(entityCentrality.userId, userId));

      const rows = agg?.rows ?? 0;

      // Top ~10 by raw PageRank mass, joined to entities for titles.
      const topRows = await db
        .select({
          id: entityCentrality.entityId,
          title: entities.title,
          score: entityCentrality.score,
        })
        .from(entityCentrality)
        .innerJoin(entities, eq(entities.id, entityCentrality.entityId))
        .where(eq(entityCentrality.userId, userId))
        .orderBy(desc(entityCentrality.score))
        .limit(10);

      return c.json(
        {
          computed: rows > 0,
          rows,
          lastComputedAt: agg?.last ? new Date(agg.last).toISOString() : null,
          oldestComputedAt: agg?.oldest
            ? new Date(agg.oldest).toISOString()
            : null,
          top: topRows.map((r) => ({
            id: r.id,
            title: r.title,
            score: r.score,
          })),
        },
        200
      );
    } catch (err) {
      // The most likely cause is the entity_centrality table not existing yet
      // (Phase-3 migration not applied) — never 500 on that. Any other read
      // failure degrades to the same "not computed" shape with a note.
      logger.warn(
        { err, userId },
        "centrality/status read failed (table absent or unreadable) — returning computed:false"
      );
      return c.json(
        {
          computed: false,
          rows: 0,
          lastComputedAt: null,
          oldestComputedAt: null,
          top: [],
          note: "entity_centrality not present — migration pending or job not run",
        },
        200
      );
    }
  });

  // ── POST /centrality/recompute ──────────────────────────────────────────
  registerOpenApi(app, {
    method: "post",
    path: "/centrality/recompute",
    tags: ["System"],
    summary: "Enqueue a PageRank centrality recompute",
    description:
      "Enqueues the global PageRank job (same queue the Phase-3 worker + cron " +
      "use). The job runs in the background and UPSERTs `entity_centrality`. " +
      "Returns `triggered:true` on enqueue, or `triggered:false` with a note if " +
      "the job queue is unavailable.",
    responses: {
      200: {
        description: "Recompute enqueue result",
        schema: CentralityRecomputeSchema,
      },
      403: { description: "Forbidden", schema: ErrorSchema },
    },
  });

  app.post("/centrality/recompute", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const acting = await resolveActingContext(c, {});
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);

    try {
      const { getBoss } = await import("@synap/jobs");
      const { PAGERANK_CENTRALITY_QUEUE } =
        await import("@synap/jobs/workers/pagerank-centrality.js");
      const boss = getBoss();
      if (!boss) {
        return c.json(
          {
            triggered: false,
            note: "Job queue (pg-boss) is not initialized on this pod.",
          },
          200
        );
      }
      await boss.send(PAGERANK_CENTRALITY_QUEUE, {});
      return c.json({ triggered: true }, 200);
    } catch (err) {
      logger.warn(
        { err },
        "centrality/recompute enqueue failed — job queue unavailable"
      );
      return c.json(
        {
          triggered: false,
          note: "Failed to enqueue PageRank job — job queue unavailable.",
        },
        200
      );
    }
  });
}
