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
  isNull,
  drizzleSql,
  getRequestGrant,
} from "@synap/database";
import type { SQL } from "drizzle-orm";

import {
  hasScope,
  logger,
  type HubHono,
  httpStatusForTrpcError,
  requireUuidParam,
} from "./_shared.js";
import { getConfinedWorkspace } from "../confine-workspace.js";
import {
  GRANT_DOOR_UNSUPPORTED,
  isFencedGrant,
  restDoorAllowed,
} from "../../../access/grant-door-fence.js";

// A `failed` row is RETRIABLE until it has been attempted this many times, then it
// is dead-lettered (stays `failed`, no longer served). Without this, a single
// transient bridge failure (Discord 5xx / rate-limit / restart mid-sweep) would
// permanently drop the outbound action. Firewall-dropped rows are acked
// `delivered`, so they never retry.
const MAX_EGRESS_ATTEMPTS = 5;

/**
 * The rows a consumer may PULL — and so the only rows it may ACK. The outbox
 * has no owner column; its consumer is whoever drains `/pending`, so both
 * routes share this ONE predicate: `pending`, or `failed` still under the retry
 * ceiling; for a workspace-bound key, its own workspace plus pod-wide (NULL)
 * rows, which are genuine globals.
 */
function servableEgressWhere(confinedWorkspaceId: string | null | undefined) {
  return and(
    or(
      eq(channelEgress.status, "pending"),
      and(
        eq(channelEgress.status, "failed"),
        lt(channelEgress.attempts, MAX_EGRESS_ATTEMPTS)
      )
    ),
    // Only applied for a bound key (else `confinedWorkspaceId` is undefined →
    // no filter). Pod-wide (NULL) rows stay visible.
    confinedWorkspaceId
      ? or(
          eq(channelEgress.workspaceId, confinedWorkspaceId),
          isNull(channelEgress.workspaceId)
        )
      : undefined
  ) as SQL;
}

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

    // SERVICE-KEY CONFINEMENT — a workspace-bound `service` key drains only its
    // own workspace's egress (plus pod-wide NULL-workspace rows, which are
    // genuine globals). Unbound / non-service keys pass through unchanged
    // (`getConfinedWorkspace(_, undefined)` → undefined), so the common
    // (unbound bridge) case is unaffected. A bound key targeting the wrong ws
    // throws 403 upstream — here `requested` is undefined so it only positive-pins.
    const confinedWorkspaceId = getConfinedWorkspace(c, undefined);

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
            servableEgressWhere(confinedWorkspaceId)
          )
        )
        .orderBy(asc(channelEgress.createdAt))
        .limit(limit);

      return c.json({ items: rows });
    } catch (err) {
      logger.error({ err }, "channel-egress pending query failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
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

    const id = requireUuidParam(c, "id");
    if (id instanceof Response) return id;
    const raw = await c.req.json().catch(() => null);
    const parsed = AckBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Bad request" },
        400
      );
    }
    const { status, error } = parsed.data;

    // SECURITY — a consumer may ack only a row it could PULL. This used to
    // update any row by id (delivered, dead-lettered, another workspace's),
    // so any write key could drop or burn the retries of an outbound message
    // it never received. A key the fence refuses on `/pending` is no consumer
    // (the W1 fence lets this POST through as "a write bounded by the gate",
    // but it never passes the gate); every other key acks through the SAME
    // predicate `/pending` serves, else 404.
    const grant = getRequestGrant();
    if (
      isFencedGrant(grant) &&
      !restDoorAllowed("GET", "/channel-egress/pending", grant!)
    ) {
      return c.json(
        { error: GRANT_DOOR_UNSUPPORTED, code: "GRANT_DOOR_UNSUPPORTED" },
        403
      );
    }
    let ackable: SQL;
    try {
      ackable = and(
        eq(channelEgress.id, id),
        servableEgressWhere(getConfinedWorkspace(c, undefined))
      ) as SQL;
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Forbidden" },
        httpStatusForTrpcError(err)
      );
    }

    try {
      const updated =
        status === "delivered"
          ? await db
              .update(channelEgress)
              .set({
                status: "delivered",
                deliveredAt: new Date(),
                lastError: null,
              })
              .where(ackable)
              .returning({ id: channelEgress.id })
          : await db
              .update(channelEgress)
              .set({
                status: "failed",
                attempts: drizzleSql`${channelEgress.attempts} + 1`,
                lastError: error ?? null,
              })
              .where(ackable)
              .returning({ id: channelEgress.id });
      if (updated.length === 0) {
        return c.json({ error: "Egress row not found or not ackable" }, 404);
      }

      return c.json({ ok: true });
    } catch (err) {
      logger.error({ err, id }, "channel-egress ack failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
      );
    }
  });
}
