/**
 * Webhook fan-out for API-side events — resolves WHO may receive an event,
 * then hands delivery to THE ONE webhook door (the `webhook-delivery` queue in
 * `@synap/jobs/workers/webhook-worker`), which owns the HTTP POST, the
 * signature, the delivery log and pg-boss retries. Nothing here sends HTTP.
 *
 * Called from `emitChatEvent` after the socket broadcast, and from entity
 * property updates.
 *
 * Wire format `chat.v1` (unchanged for existing subscribers): body
 * `{ event, data, timestamp }`, `X-Synap-Event`, and — when the subscription
 * has a secret — `X-Synap-Signature: sha256=<hmac-hex>`. The door adds
 * `X-Synap-Webhook-Format: chat.v1` and a stable `X-Synap-Delivery-Id`.
 * Match rule: `subscriptionWantsEvent` (empty list = all events).
 *
 * AUDIENCE — a subscription belongs to ONE user (`webhook_subscriptions.user_id`)
 * and receives an event only when that user may READ what the event is about.
 * The caller names the subject (`WebhookAudience`); the reader set comes from
 * the existing doors, never a rule invented here:
 *   - channel → `listChannelAudienceUserIds` (the channel read predicate). A
 *     channel named only in a caller-shaped payload is honoured only when the
 *     actor is one of its readers — the same trust rule `emitChatEvent` applies
 *     to its socket fan-out — otherwise only the actor's subscriptions match.
 *   - entity  → `scopedDb(AccessContext.operator({ userId: owner }))` over
 *     `entities` (the registered access-layer floor), per subscription owner.
 *   - user    → that user's subscriptions only.
 * A failed audience read delivers to NOBODY: a failed read is not "everyone".
 * (Before this, every active matching subscription on the pod was hit, so one
 * user's webhook received every other user's chat and entity events.)
 *
 * Failures are console.warn'd, never thrown — this must never block the API.
 */

import { randomUUID } from "node:crypto";
import { db, webhookSubscriptions, eq } from "@synap/database";
import { entities } from "@synap/database/schema";
import { getBoss } from "@synap/events";
import {
  buildWebhookBody,
  enqueueWebhookDeliveries,
  subscriptionWantsEvent,
} from "@synap/jobs/workers/webhook-worker.js";
import { listChannelAudienceUserIds } from "./channel-visibility.js";
import { AccessContext, scopedDb } from "../access/index.js";

/** What the event is ABOUT — decides whose subscriptions may receive it. */
export type WebhookAudience =
  | {
      kind: "channel";
      channelId: string;
      /**
       * `true` when the channel id came from an internal door that already
       * authorized it; `false` when it was only found in the payload.
       */
      trusted: boolean;
      actorUserId?: string | null;
    }
  | { kind: "entity"; entityId: string }
  | { kind: "user"; userId: string | null | undefined };

/** The subset of `ownerIds` allowed to read the event's subject. */
async function readersAmong(
  audience: WebhookAudience,
  ownerIds: string[]
): Promise<Set<string>> {
  switch (audience.kind) {
    case "user":
      return new Set(audience.userId ? [audience.userId] : []);
    case "channel": {
      const readers = await listChannelAudienceUserIds(db, audience.channelId);
      const actor = audience.actorUserId ?? null;
      if (!audience.trusted && !(actor && readers.includes(actor))) {
        return new Set(actor ? [actor] : []);
      }
      return new Set(readers);
    }
    case "entity": {
      const allowed = new Set<string>();
      for (const owner of ownerIds) {
        const rows = await scopedDb(
          AccessContext.operator({ userId: owner })
        ).findMany(entities, {
          where: eq(entities.id, audience.entityId),
          columns: { id: true },
          limit: 1,
        });
        if (rows.length > 0) allowed.add(owner);
      }
      return allowed;
    }
  }
}

/** Awaitable core of {@link dispatchWebhooksForEvent} (exported for tests). */
export async function deliverWebhooksForEvent(
  eventType: string,
  data: Record<string, unknown>,
  audience: WebhookAudience
): Promise<void> {
  try {
    const active = await db
      .select({
        id: webhookSubscriptions.id,
        userId: webhookSubscriptions.userId,
        eventTypes: webhookSubscriptions.eventTypes,
        retryConfig: webhookSubscriptions.retryConfig,
      })
      .from(webhookSubscriptions)
      .where(eq(webhookSubscriptions.active, true));
    const candidates = active.filter((s) =>
      subscriptionWantsEvent(s.eventTypes, eventType)
    );
    if (candidates.length === 0) return;

    let readers: Set<string>;
    try {
      readers = await readersAmong(audience, [
        ...new Set(candidates.map((s) => s.userId)),
      ]);
    } catch (err) {
      console.warn(
        `[webhook] audience read failed for '${eventType}'; delivering to nobody:`,
        err
      );
      return;
    }

    const subscribers = candidates.filter((s) => readers.has(s.userId));
    if (subscribers.length === 0) return;

    // ONE fan-out id for this call (not one per subscription / attempt), so
    // each subscriber's delivery id is derived from it.
    await enqueueWebhookDeliveries(
      getBoss(),
      subscribers,
      {
        eventType,
        format: "chat.v1",
        body: buildWebhookBody("chat.v1", { eventType, data }),
      },
      randomUUID()
    );
  } catch (err) {
    console.warn("[webhook] fanout failed:", err);
  }
}

export function dispatchWebhooksForEvent(
  eventType: string,
  data: Record<string, unknown>,
  audience: WebhookAudience
): void {
  void deliverWebhooksForEvent(eventType, data, audience);
}
