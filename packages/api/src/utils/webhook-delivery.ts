/**
 * Webhook delivery — fire-and-forget HTTP fanout to registered endpoints.
 *
 * Called from `emitChatEvent` after the socket broadcast so every realtime
 * event is automatically delivered to matching webhook subscribers.
 *
 * Delivery contract:
 *   - POST to subscriber.url with `Content-Type: application/json`
 *   - Body: `{ event, data, timestamp }` (same shape as the socket payload)
 *   - If subscriber.secret is set: `X-Synap-Signature: sha256=<hmac-hex>`
 *   - 5-second per-request timeout; no retry (callers can poll or re-subscribe)
 *   - Empty `events` array = "all events"; otherwise event must be in the list
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

import { createHmac } from "node:crypto";
import { db, webhookSubscriptions, eq, and, drizzleSql } from "@synap/database";
import { entities } from "@synap/database/schema";
import { safeExternalFetch } from "@synap/shared-utils";
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
    // Subscribers whose events list is empty (all events) OR contains this type.
    const candidates = await db
      .select({
        id: webhookSubscriptions.id,
        userId: webhookSubscriptions.userId,
        url: webhookSubscriptions.url,
        secret: webhookSubscriptions.secret,
      })
      .from(webhookSubscriptions)
      .where(
        and(
          eq(webhookSubscriptions.active, true),
          drizzleSql`(
            array_length(${webhookSubscriptions.eventTypes}, 1) IS NULL
            OR ${webhookSubscriptions.eventTypes} = '{}'::text[]
            OR ${eventType} = ANY(${webhookSubscriptions.eventTypes})
          )`
        )
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

    const body = JSON.stringify({
      event: eventType,
      data,
      timestamp: new Date().toISOString(),
    });

    for (const sub of subscribers) {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-Synap-Event": eventType,
      };
      if (sub.secret) {
        const sig = createHmac("sha256", sub.secret).update(body).digest("hex");
        headers["X-Synap-Signature"] = `sha256=${sig}`;
      }
      safeExternalFetch(sub.url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(5000),
      }).catch((err: unknown) => {
        console.warn(
          `[webhook] delivery to ${sub.url} (id: ${sub.id}) failed: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    }
  } catch (err) {
    console.warn("[webhook] fanout query failed:", err);
  }
}

export function dispatchWebhooksForEvent(
  eventType: string,
  data: Record<string, unknown>,
  audience: WebhookAudience
): void {
  void deliverWebhooksForEvent(eventType, data, audience);
}
