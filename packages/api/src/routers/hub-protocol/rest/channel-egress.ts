/**
 * Hub Protocol REST — channel egress outbox.
 *
 * Channel-AGNOSTIC outbound action queue. An external adapter (e.g. the Discord
 * bridge) pulls pending rows and executes them against the target system, then
 * acks each row. The backend never touches the provider here — it only reads /
 * updates the outbox rows.
 *
 *   GET  /channel-egress/pending   — read-scope; list pending rows to execute
 *   POST /channel-egress/:id/ack   — write-scope; mark a row delivered / failed
 *
 * Static routes are registered before the `/:id` route.
 */

import { z } from "@hono/zod-openapi";
import {
  db,
  channelEgress,
  eq,
  and,
  or,
  lt,
  asc,
  drizzleSql,
} from "@synap/database";

import { hasScope, logger, type HubHono } from "./_shared.js";

// A `failed` row is RETRIABLE until it has been attempted this many times, then it
// is dead-lettered (stays `failed`, no longer served). Without this, a single
// transient bridge failure (Discord 5xx / rate-limit / restart mid-sweep) would
// permanently drop the outbound action. Firewall-dropped rows are acked
// `delivered`, so they never retry.
const MAX_EGRESS_ATTEMPTS = 5;

const PendingQuerySchema = z.object({
  externalSource: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const AckBodySchema = z.object({
  status: z.enum(["delivered", "failed"]),
  error: z.string().optional(),
});

export function registerChannelEgressRoutes(app: HubHono): void {
  /**
   * GET /channel-egress/pending?externalSource=discord&limit=50
   * Read-scope. Returns pending rows for the given source, oldest first.
   */
  app.get("/channel-egress/pending", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Insufficient scope" }, 403);
    }

    const parsed = PendingQuerySchema.safeParse({
      externalSource: c.req.query("externalSource"),
      limit: c.req.query("limit"),
    });
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Bad request" },
        400
      );
    }
    const { externalSource, limit } = parsed.data;

    try {
      const rows = await db
        .select({
          id: channelEgress.id,
          externalSource: channelEgress.externalSource,
          externalId: channelEgress.externalId,
          kind: channelEgress.kind,
          payload: channelEgress.payload,
          attempts: channelEgress.attempts,
        })
        .from(channelEgress)
        .where(
          and(
            eq(channelEgress.externalSource, externalSource),
            // `pending`, plus `failed` rows still under the retry ceiling.
            or(
              eq(channelEgress.status, "pending"),
              and(
                eq(channelEgress.status, "failed"),
                lt(channelEgress.attempts, MAX_EGRESS_ATTEMPTS)
              )
            )
          )
        )
        .orderBy(asc(channelEgress.createdAt))
        .limit(limit);

      return c.json({ items: rows });
    } catch (err) {
      logger.error({ err }, "channel-egress pending query failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /channel-egress/:id/ack
   * Write-scope. Body: { status: 'delivered' | 'failed', error?: string }.
   * delivered → sets delivered_at. failed → increments attempts + last_error.
   */
  app.post("/channel-egress/:id/ack", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }

    const id = c.req.param("id");
    const raw = await c.req.json().catch(() => null);
    const parsed = AckBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Bad request" },
        400
      );
    }
    const { status, error } = parsed.data;

    try {
      if (status === "delivered") {
        await db
          .update(channelEgress)
          .set({
            status: "delivered",
            deliveredAt: new Date(),
            lastError: null,
          })
          .where(eq(channelEgress.id, id));
      } else {
        await db
          .update(channelEgress)
          .set({
            status: "failed",
            attempts: drizzleSql`${channelEgress.attempts} + 1`,
            lastError: error ?? null,
          })
          .where(eq(channelEgress.id, id));
      }

      return c.json({ ok: true });
    } catch (err) {
      logger.error({ err, id }, "channel-egress ack failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
