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
 * Failures are console.warn'd, never thrown — this must never block the API.
 */

import { createHmac } from "node:crypto";
import { db, webhookSubscriptions, eq, and, drizzleSql } from "@synap/database";
import { safeExternalFetch } from "@synap/shared-utils";

export function dispatchWebhooksForEvent(
  eventType: string,
  data: Record<string, unknown>
): void {
  (async () => {
    try {
      // Subscribers whose events list is empty (all events) OR contains this type.
      const subscribers = await db
        .select({
          id: webhookSubscriptions.id,
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
          const sig = createHmac("sha256", sub.secret)
            .update(body)
            .digest("hex");
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
  })();
}
