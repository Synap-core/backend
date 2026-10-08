/**
 * Outbound webhooks — THE ONE DOOR.
 *
 * Every outbound webhook POST on the pod is sent here, by the
 * `webhook-delivery` pg-boss queue. Two producers feed it, and they differ only
 * in WHO decided the audience:
 *
 *   1. The domain-event reactor (`@synap/events` side-effects) enqueues the
 *      legacy FAN-OUT job `{ eventType, subjectId, userId, data, eventId? }`.
 *      Audience = that event's user: only their own subscriptions match (the
 *      rule this worker always had).
 *   2. `@synap/api`'s `dispatchWebhooksForEvent` (chat events, entity property
 *      updates) resolves the audience in the API — who may READ the subject,
 *      via the access layer jobs cannot import — then enqueues one DELIVER job
 *      per allowed subscription through {@link enqueueWebhookDeliveries}.
 *
 * Both end in {@link deliverWebhook}: one subscription, one frozen body, one
 * signature, one delivery log, pg-boss retries with backoff. A failed POST
 * THROWS so pg-boss retries it; the body (and its timestamp) is frozen at
 * enqueue, so every retry re-sends the same bytes under the same signature and
 * the same `X-Synap-Delivery-Id` — consumers dedupe on that id.
 *
 * WIRE FORMATS — two, kept byte-compatible on purpose. Existing subscribers of
 * each producer verify what they were always sent; one format winning would
 * break the other's signature check. Every request now also names its format in
 * `X-Synap-Webhook-Format`, so a consumer (or a later convergence) can tell them
 * apart without sniffing the body.
 *   - `chat.v1`  (producer 2): body `{ event, data, timestamp }`,
 *     `X-Synap-Event: <type>`, `X-Synap-Signature: sha256=<hmac-hex>`.
 *   - `event.v1` (producer 1): body `{ type, subjectId, userId, data, timestamp }`,
 *     `X-Synap-Event-Type`, `X-Synap-Event-Id: <subjectId>`,
 *     `X-Synap-Signature: <hmac-hex>` (no prefix), `User-Agent: Synap-Webhook/1.0`.
 *
 * MATCH RULE — one, {@link subscriptionWantsEvent}: an empty `eventTypes` list
 * means "all events", otherwise the type must be listed. (The create APIs
 * require ≥1 type, so the empty case is only reachable on legacy rows.)
 */

import type PgBoss from "pg-boss";
import { createHmac } from "node:crypto";
import { deterministicUuidV5 } from "../utils/deterministic-uuid.js";
import {
  db,
  webhookSubscriptions,
  webhookDeliveries,
  eq,
  and,
  drizzleSql,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { getBoss } from "@synap/events";
import { safeExternalFetch } from "@synap/shared-utils";

const logger = createLogger({ module: "webhook-worker" });

export const WEBHOOK_DELIVERY_QUEUE = "webhook-delivery";

/** Per-request timeout for one POST. */
export const WEBHOOK_REQUEST_TIMEOUT_MS = 10_000;

/** Retries when a subscription does not set `retryConfig.maxRetries`. */
export const DEFAULT_WEBHOOK_MAX_RETRIES = 3;

export type WebhookFormat = "chat.v1" | "event.v1";

/** One subscription, one frozen body — the unit pg-boss retries. */
export interface WebhookDeliverJob {
  stage: "deliver";
  subscriptionId: string;
  eventType: string;
  format: WebhookFormat;
  /** Serialized body, frozen at enqueue so retries are byte-identical. */
  body: string;
  /** Stable across retries — `X-Synap-Delivery-Id`. */
  deliveryId: string;
  /** `event.v1` only — the subject id it always sent as `X-Synap-Event-Id`. */
  subjectId?: string;
  /**
   * The `events` row this delivery is about, when one exists. The delivery
   * log (`webhook_deliveries.event_id`) is an FK to `events.id`, so a row is
   * recorded only when this is set — never a subject id posing as an event id.
   */
  eventRowId?: string | null;
}

/** The domain-event reactor's job (audience: that event's user). */
export interface WebhookEventFanoutJob {
  stage?: undefined;
  eventType: string;
  subjectId: string;
  userId: string;
  workspaceId?: string | null;
  data?: Record<string, unknown>;
  /** The `events` row id (`SideEffectPayload.eventId`), when one was recorded. */
  eventId?: string | null;
}

export type WebhookJob = WebhookDeliverJob | WebhookEventFanoutJob;

/** THE match rule: empty list = all events; otherwise the type must be listed. */
export function subscriptionWantsEvent(
  eventTypes: readonly string[] | null | undefined,
  eventType: string
): boolean {
  return (
    !eventTypes || eventTypes.length === 0 || eventTypes.includes(eventType)
  );
}

/** Serialize a body in its format. */
export function buildWebhookBody(
  format: "chat.v1",
  fields: { eventType: string; data: Record<string, unknown> }
): string;
export function buildWebhookBody(
  format: "event.v1",
  fields: {
    eventType: string;
    subjectId: string;
    userId: string;
    data?: Record<string, unknown>;
  }
): string;
export function buildWebhookBody(
  format: WebhookFormat,
  fields: {
    eventType: string;
    data?: Record<string, unknown>;
    subjectId?: string;
    userId?: string;
  }
): string {
  const timestamp = new Date().toISOString();
  if (format === "chat.v1") {
    return JSON.stringify({
      event: fields.eventType,
      data: fields.data,
      timestamp,
    });
  }
  return JSON.stringify({
    type: fields.eventType,
    subjectId: fields.subjectId,
    userId: fields.userId,
    data: fields.data,
    timestamp,
  });
}

/** Request headers for one delivery, in its format. */
export function webhookHeaders(
  job: Pick<
    WebhookDeliverJob,
    "format" | "eventType" | "body" | "deliveryId" | "subjectId"
  >,
  secret: string | null | undefined
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Synap-Webhook-Format": job.format,
    "X-Synap-Delivery-Id": job.deliveryId,
  };
  const sig = secret
    ? createHmac("sha256", secret).update(job.body).digest("hex")
    : null;
  if (job.format === "chat.v1") {
    headers["X-Synap-Event"] = job.eventType;
    if (sig) headers["X-Synap-Signature"] = `sha256=${sig}`;
  } else {
    headers["X-Synap-Event-Type"] = job.eventType;
    if (job.subjectId) headers["X-Synap-Event-Id"] = job.subjectId;
    headers["User-Agent"] = "Synap-Webhook/1.0";
    if (sig) headers["X-Synap-Signature"] = sig;
  }
  return headers;
}

type JobSender = Pick<PgBoss, "send">;

function maxRetriesOf(retryConfig: unknown): number {
  const n = (retryConfig as { maxRetries?: unknown } | null)?.maxRetries;
  return typeof n === "number" && Number.isInteger(n) && n >= 0
    ? n
    : DEFAULT_WEBHOOK_MAX_RETRIES;
}

/**
 * THE delivery id of one subscription's copy of one fan-out — derived, never
 * minted per attempt: a retried fan-out re-derives the SAME id for the same
 * subscription, so the subscriber sees one `X-Synap-Delivery-Id`.
 */
export function webhookDeliveryId(
  fanoutKey: string,
  subscriptionId: string
): string {
  return deterministicUuidV5(`webhook-delivery:${fanoutKey}:${subscriptionId}`);
}

/**
 * Enqueue one DELIVER job per subscription. The caller has already decided
 * the audience; this never widens it.
 *
 * `fanoutKey` names the fan-out ONCE (the fan-out job's own id, which a
 * pg-boss retry keeps). The deliver job's id IS the delivery id, so a retried
 * fan-out's re-send conflicts on the job's primary key (pg-boss inserts with
 * `ON CONFLICT DO NOTHING`) instead of queueing a duplicate; the same value is
 * the job's `singletonKey`. (On this `standard` queue a singletonKey alone
 * does not dedupe — pg-boss only indexes it for singleton/stately/short
 * policies or with `singletonSeconds` — the derived job id is what does.)
 */
export async function enqueueWebhookDeliveries(
  boss: JobSender,
  subscriptions: ReadonlyArray<{ id: string; retryConfig?: unknown }>,
  delivery: Omit<WebhookDeliverJob, "stage" | "subscriptionId" | "deliveryId">,
  fanoutKey: string
): Promise<void> {
  for (const sub of subscriptions) {
    const deliveryId = webhookDeliveryId(fanoutKey, sub.id);
    const job: WebhookDeliverJob = {
      stage: "deliver",
      subscriptionId: sub.id,
      deliveryId,
      ...delivery,
    };
    await boss.send(WEBHOOK_DELIVERY_QUEUE, job, {
      id: deliveryId,
      singletonKey: deliveryId,
      retryLimit: maxRetriesOf(sub.retryConfig),
      retryDelay: 10,
      retryBackoff: true,
    });
  }
}

/** Producer 1: a domain event reaches its own user's matching subscriptions. */
async function fanOutDomainEvent(
  boss: JobSender,
  job: WebhookEventFanoutJob,
  /** The fan-out job's own id — stable across its pg-boss retries. */
  fanoutKey: string
): Promise<void> {
  const { eventType, userId, subjectId, data, eventId } = job;
  const subs = await db
    .select({
      id: webhookSubscriptions.id,
      eventTypes: webhookSubscriptions.eventTypes,
      retryConfig: webhookSubscriptions.retryConfig,
    })
    .from(webhookSubscriptions)
    .where(
      and(
        eq(webhookSubscriptions.userId, userId),
        eq(webhookSubscriptions.active, true)
      )
    );
  const matching = subs.filter((s) =>
    subscriptionWantsEvent(s.eventTypes, eventType)
  );
  if (matching.length === 0) return;

  await enqueueWebhookDeliveries(
    boss,
    matching,
    {
      eventType,
      format: "event.v1",
      body: buildWebhookBody("event.v1", {
        eventType,
        subjectId,
        userId,
        data,
      }),
      subjectId,
      eventRowId: eventId ?? null,
    },
    fanoutKey
  );
}

/**
 * Send ONE delivery. Throws on a network error or a non-2xx response so
 * pg-boss retries it (with backoff, up to the subscription's maxRetries).
 */
export async function deliverWebhook(job: WebhookDeliverJob): Promise<void> {
  const [sub] = await db
    .select({
      id: webhookSubscriptions.id,
      url: webhookSubscriptions.url,
      secret: webhookSubscriptions.secret,
      active: webhookSubscriptions.active,
    })
    .from(webhookSubscriptions)
    .where(eq(webhookSubscriptions.id, job.subscriptionId))
    .limit(1);
  // Deleted or paused since enqueue: nothing to deliver, nothing to retry.
  if (!sub || !sub.active) return;

  let responseStatus = 0;
  let failure: string | null = null;
  try {
    const response = await safeExternalFetch(sub.url, {
      method: "POST",
      headers: webhookHeaders(job, sub.secret),
      body: job.body,
      signal: AbortSignal.timeout(WEBHOOK_REQUEST_TIMEOUT_MS),
    });
    responseStatus = response.status;
    if (!response.ok) failure = `HTTP ${response.status}`;
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }

  const status = failure ? "failed" : "success";
  if (job.eventRowId) {
    try {
      const [prior] = await db
        .select({ n: drizzleSql<number>`count(*)::int` })
        .from(webhookDeliveries)
        .where(
          and(
            eq(webhookDeliveries.subscriptionId, sub.id),
            eq(webhookDeliveries.eventId, job.eventRowId)
          )
        );
      await db.insert(webhookDeliveries).values({
        subscriptionId: sub.id,
        eventId: job.eventRowId,
        status,
        responseStatus: responseStatus || null,
        attempt: (prior?.n ?? 0) + 1,
        deliveredAt: failure ? null : new Date(),
      });
    } catch (err) {
      // The log is observability; a failed log write must not re-send a
      // delivery that already succeeded.
      logger.warn(
        { err, subscriptionId: sub.id },
        "Webhook delivery log write failed"
      );
    }
  }

  if (failure) {
    logger.warn(
      { subscriptionId: sub.id, deliveryId: job.deliveryId, failure },
      "Webhook delivery failed — pg-boss will retry"
    );
    throw new Error(
      `Webhook delivery ${job.deliveryId} to subscription ${sub.id} failed: ${failure}`
    );
  }

  await db
    .update(webhookSubscriptions)
    .set({ lastTriggeredAt: new Date() })
    .where(eq(webhookSubscriptions.id, sub.id));
}

/** pg-boss handler for the `webhook-delivery` queue. */
export async function handleWebhookDelivery(
  job: PgBoss.Job<WebhookJob>,
  boss?: JobSender
): Promise<void> {
  if (job.data.stage === "deliver") {
    await deliverWebhook(job.data);
    return;
  }
  await fanOutDomainEvent(boss ?? getBoss(), job.data, job.id);
}
