/**
 * The ONE place both Cal.com lanes (the webhook, `webhooks-inbound.ts`, and
 * the backfill poller, `run-cal-backfill.ts`) turn a booking into the graph
 * they file, and name the key that dedupes it.
 *
 * The booking's `attribution-event` joins the graph only when that kind
 * resolves where the booking lands (`resolveProfile` for the tool's person in
 * the tool's space). A pod without the kind still records the booking: a
 * graph naming a kind that does not resolve would fail at materialize and
 * lose the booking with it.
 */
import { db, ProfileResolutionService } from "@synap/database";
import { createLogger } from "@synap-core/core";
import {
  BOOKING_ATTRIBUTION_KIND,
  mapBookingToGraph,
  type BookingGraph,
  type CalBookingPayload,
} from "./map-booking-to-graph.js";

const logger = createLogger({ module: "calcom-booking-graph" });

/**
 * The capture idempotency key of one booking event, SHARED by the webhook and
 * the backfill: a booking filed by one lane and re-sent by the other returns
 * the first proposal (pending or auto-applied) instead of filing a second
 * booking and a second attribution-event. Namespaced by tool, so two cal_com
 * tools never share a key.
 */
export function calBookingIdempotencyKey(
  toolId: string,
  uid: string,
  trigger = "BOOKING_CREATED"
): string {
  return `calcom:${toolId}:${uid}:${trigger}`;
}

/** True when the attribution-event kind resolves for this person and space. */
export async function attributionKindResolves(
  userId: string,
  workspaceId: string | null
): Promise<boolean> {
  try {
    const profile = await new ProfileResolutionService(db).resolveProfile(
      BOOKING_ATTRIBUTION_KIND,
      userId,
      workspaceId
    );
    return profile != null;
  } catch (err) {
    // Unreadable is not "absent", but the booking must still land: it is
    // filed without its attribution, and the log says so.
    logger.warn(
      { err, workspaceId },
      "cal.com booking: attribution kind lookup failed — booking filed without it"
    );
    return false;
  }
}

/**
 * A booking's graph: the person (lead), company, event, and — when its kind
 * resolves — the attribution-event linked to the person.
 */
export async function bookingGraphFor(
  payload: CalBookingPayload,
  ctx: { userId: string; workspaceId: string | null; receivedAt: string }
): Promise<BookingGraph & { attribution: boolean }> {
  const attribution = await attributionKindResolves(
    ctx.userId,
    ctx.workspaceId
  );
  if (!attribution) {
    logger.info(
      { workspaceId: ctx.workspaceId },
      "cal.com booking: no attribution-event kind here — booking filed without attribution"
    );
  }
  const graph = mapBookingToGraph(
    payload,
    attribution ? { attribution: { receivedAt: ctx.receivedAt } } : {}
  );
  return { ...graph, attribution };
}
