/**
 * Webhook Delivery Worker
 *
 * Delivers events to registered webhook subscribers with HMAC signing.
 * Ported from Inngest function: webhook-broker.ts
 */

import type PgBoss from "pg-boss";
import {
  db,
  webhookSubscriptions,
  webhookDeliveries,
  eq,
  and,
} from "@synap/database";
import { createHmac } from "crypto";
import { createLogger } from "@synap-core/core";
import { safeExternalFetch } from "@synap/shared-utils";

const logger = createLogger({ module: "webhook-worker" });

export async function handleWebhookDelivery(
  job: PgBoss.Job<{
    eventType: string;
    subjectId: string;
    userId: string;
    workspaceId?: string;
    data?: Record<string, unknown>;
  }>
): Promise<void> {
  const { eventType, userId, subjectId, data } = job.data;

  // Find active subscriptions for this user matching the event type
  const allSubs = await db
    .select()
    .from(webhookSubscriptions)
    .where(
      and(
        eq(webhookSubscriptions.userId, userId),
        eq(webhookSubscriptions.active, true)
      )
    );

  const matchingSubs = allSubs.filter((sub) =>
    sub.eventTypes.includes(eventType)
  );

  if (matchingSubs.length === 0) return;

  for (const sub of matchingSubs) {
    const payload = JSON.stringify({
      type: eventType,
      subjectId,
      userId,
      data,
      timestamp: new Date().toISOString(),
    });

    const signature = createHmac("sha256", sub.secret)
      .update(payload)
      .digest("hex");

    let status = "pending";
    let responseStatus = 0;

    try {
      const response = await safeExternalFetch(sub.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Synap-Signature": signature,
          "X-Synap-Event-Type": eventType,
          "X-Synap-Event-Id": subjectId,
          "User-Agent": "Synap-Webhook/1.0",
        },
        body: payload,
      });

      responseStatus = response.status;
      status = response.ok ? "success" : "failed";
    } catch (error) {
      status = "failed";
      logger.warn(
        { err: error, subscriptionId: sub.id },
        "Webhook delivery failed"
      );
    }

    await db.insert(webhookDeliveries).values({
      subscriptionId: sub.id,
      eventId: subjectId,
      status,
      responseStatus: responseStatus || null,
      attempt: 1,
      deliveredAt: status === "success" ? new Date() : null,
    });

    if (status === "success") {
      await db
        .update(webhookSubscriptions)
        .set({ lastTriggeredAt: new Date() })
        .where(eq(webhookSubscriptions.id, sub.id));
    }
  }
}
