/**
 * THE delivery of an inbound webhook (pipeline-health plan 12d8dab9 W1,
 * finding 66e1e526).
 *
 * The generic inbound door (api `routers/webhooks-inbound.ts`) stores each
 * authenticated delivery in `inbound_deliveries` BEFORE it answers 200, then
 * calls `dispatchInboundDelivery`. The `external_webhook.received` fan-out is
 * built FROM that row, never from the request, so the door's inline attempt
 * and the sweeper's retry send the same event. A fan-out that did not reach
 * the queue (pg-boss down, a reactor that threw, a process that died
 * mid-request) leaves the row owed with a backoff; `dispatchDueInboundDeliveries`
 * (the jobs sweeper) retries it. Same shape as the lifecycle transition outbox
 * (lifecycle-transition.ts); residual, stated the same way: a crash AFTER a
 * reactor's send and BEFORE the settle re-sends that reactor once, and the
 * automation matcher's fingerprint (the sender's delivery id) still fires a
 * rule once.
 *
 * The runs it starts carry the row id (`trigger.payload.inboundDeliveryId`,
 * the matcher's webhook branch), so which runs a delivery started, and how
 * they ended, is one read.
 */
import {
  claimInboundDelivery,
  db,
  listDueInboundDeliveries,
  pruneInboundDeliveries,
  settleInboundDelivery,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { fanOutSideEffects, type SideEffectPayload } from "./side-effects.js";

const logger = createLogger({ module: "inbound-delivery" });

/** Why a stored delivery fired nothing, when its subscription has no space. */
export const INBOUND_NO_WORKSPACE =
  "the inbound source has no space, so no automation can fire";

/** The stored row, as the dispatcher reads it. */
export interface StoredInboundDelivery {
  id: string;
  subscriptionId: string;
  userId: string;
  workspaceId: string | null;
  deliveryId: string | null;
  event: string | null;
  payload: unknown;
}

/**
 * The automation event a stored delivery is: `external_webhook.received`,
 * `data = { subscriptionId, payload, event?, deliveryId?, inboundDeliveryId }`
 * (the matcher's webhook branch reads it).
 */
export function inboundDeliverySideEffect(
  row: StoredInboundDelivery
): SideEffectPayload {
  return {
    subjectType: "external_webhook",
    action: "received",
    subjectId: row.subscriptionId,
    userId: row.userId,
    workspaceId: row.workspaceId,
    data: {
      subscriptionId: row.subscriptionId,
      payload: row.payload,
      ...(row.event ? { event: row.event } : {}),
      ...(row.deliveryId ? { deliveryId: row.deliveryId } : {}),
      inboundDeliveryId: row.id,
    },
  };
}

/**
 * Deliver one stored delivery: claim, fan out (skipping reactors an earlier
 * attempt delivered), settle. Never throws; `false` = not delivered by this
 * call (held by another, already done, or left owed for the sweeper).
 */
export async function dispatchInboundDelivery(id: string): Promise<boolean> {
  try {
    const row = await claimInboundDelivery(db, id);
    if (!row) return false;
    // The old door emitted nothing for a space-less source, and the trigger
    // reactor would drop it anyway: settled, with the reason on the row.
    if (!row.workspaceId) {
      await settleInboundDelivery(db, id, {
        delivered: row.delivered ?? [],
        complete: true,
        error: INBOUND_NO_WORKSPACE,
      });
      return true;
    }
    const r = await fanOutSideEffects(
      inboundDeliverySideEffect(row),
      new Set(row.delivered ?? [])
    );
    const delivered = [...(row.delivered ?? []), ...r.delivered];
    const failures = [
      ...(r.queueDown ? ["queue unavailable"] : []),
      ...r.failed,
    ];
    const complete = failures.length === 0;
    await settleInboundDelivery(db, id, {
      delivered,
      complete,
      error: complete ? null : failures.join(", "),
    });
    if (!complete) {
      logger.warn(
        { inboundDeliveryId: id, attempts: row.attempts, failures },
        "inbound delivery incomplete — left owed for the sweeper"
      );
    }
    return complete;
  } catch (err) {
    logger.warn({ err, inboundDeliveryId: id }, "inbound dispatch failed");
    return false;
  }
}

/** The sweeper: deliver every owed delivery whose backoff has lapsed. */
export async function dispatchDueInboundDeliveries(
  limit = 100
): Promise<{ due: number; delivered: number; pruned: number }> {
  const due = await listDueInboundDeliveries(db, limit);
  let delivered = 0;
  for (const id of due) {
    if (await dispatchInboundDelivery(id)) delivered++;
  }
  const pruned = await pruneInboundDeliveries(db);
  return { due: due.length, delivered, pruned };
}
