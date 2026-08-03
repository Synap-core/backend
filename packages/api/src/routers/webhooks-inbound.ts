import { createHmac, timingSafeEqual } from "crypto";
import { Hono } from "hono";
import { createLogger } from "@synap-core/core";
import {
  db,
  eq,
  and,
  drizzleSql,
  workspaces,
  tools,
  entities,
  messagingAccounts,
  webhookSubscriptions,
  resolveVaultSecret,
  resolveIdentity,
} from "@synap/database";
import { emitSideEffects } from "@synap/events";
import { getBoss } from "@synap/jobs";
import {
  FIREFLIES_INGEST_QUEUE,
  type FirefliesIngestJobData,
} from "@synap/jobs/workers/fireflies-worker.js";
import { getMessagingConnector } from "../connectors/index.js";
import { MessagingAccountService } from "../services/messaging-account-service.js";
import { recordInboundMessage } from "../services/connectors/inbound-recorder.js";
import { markWebhookSeen } from "../services/connectors/mark-webhook-seen.js";
import { submitCaptureGraph } from "../services/capture-agent/submit-capture-graph.js";
import { getCaptureAgentUserId } from "../services/capture-agent/ensure-capture-agent.js";
import {
  mapBookingToGraph,
  type CalBookingPayload,
} from "../services/calcom/map-booking-to-graph.js";
import { mapMailgunInboundToMessage } from "../services/mailgun/map-inbound-to-message.js";

const logger = createLogger({ module: "webhooks-inbound" });

export const webhooksInboundRouter = new Hono();

// Generic inbound webhook — external backend → Synap
// Static route must appear before /:id dynamic routes (Hono ordering rule)
// Inbound webhook bodies are small trigger payloads, not bulk uploads — cap
// hard to blunt a memory-DoS via `c.req.text()`. (The app-wide rate limiter,
// `app.use("*", rateLimitMiddleware)` — multi-class crud default 500/15m per
// Bearer-hash or IP — already throttles.)
const MAX_INBOUND_WEBHOOK_BODY = 1 * 1024 * 1024; // 1 MB

webhooksInboundRouter.post("/inbound/:subscriptionId", async (c) => {
  const subscriptionId = c.req.param("subscriptionId");

  const contentLength = c.req.header("content-length");
  if (
    contentLength &&
    Number.parseInt(contentLength, 10) > MAX_INBOUND_WEBHOOK_BODY
  ) {
    return c.json({ error: "Payload too large" }, 413);
  }

  const rawBody = await c.req.text();
  if (rawBody.length > MAX_INBOUND_WEBHOOK_BODY) {
    return c.json({ error: "Payload too large" }, 413);
  }

  const subscription = await db.query.webhookSubscriptions.findFirst({
    where: and(
      eq(webhookSubscriptions.id, subscriptionId),
      eq(webhookSubscriptions.active, true)
    ),
  });

  // Uniform auth failure: an unknown/inactive subscription and a bad signature
  // return the SAME 401 body, so a caller cannot enumerate which subscription
  // ids exist. Verify HMAC-SHA256 — timingSafeEqual needs equal-length buffers.
  const signature = c.req.header("x-synap-signature") ?? "";
  const expected = subscription
    ? `sha256=${createHmac("sha256", subscription.secret).update(rawBody).digest("hex")}`
    : "";
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  const sigValid =
    subscription != null &&
    sigBuf.length === expBuf.length &&
    timingSafeEqual(sigBuf, expBuf);

  if (!sigValid || !subscription) {
    logger.warn(
      { subscriptionId, known: subscription != null },
      "Rejected inbound webhook (unknown subscription or invalid signature)"
    );
    return c.json({ error: "Unauthorized" }, 401);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    payload = rawBody;
  }

  // Update lastTriggeredAt
  await db
    .update(webhookSubscriptions)
    .set({ lastTriggeredAt: new Date() })
    .where(eq(webhookSubscriptions.id, subscriptionId));

  logger.info(
    { subscriptionId, workspaceId: subscription.workspaceId },
    "Inbound webhook received"
  );

  // Emit automation event (fire-and-forget, mirrors messaging inbound pattern)
  if (subscription.workspaceId) {
    emitSideEffects({
      subjectType: "external_webhook",
      action: "received",
      subjectId: subscriptionId,
      userId: subscription.userId,
      workspaceId: subscription.workspaceId,
      data: { subscriptionId, payload },
    }).catch((err) => {
      logger.warn(
        { err, subscriptionId },
        "emitSideEffects failed (non-fatal)"
      );
    });
  }

  return c.json({ received: true }, 200);
});

// ── Cal.com inbound webhook — bookings → CRM graph ────────────────────────────
//
// Cal.com POSTs booking events here. We verify the signature (header
// `x-cal-signature-256` = hex HMAC-SHA256 of the RAW body, NO `sha256=` prefix —
// different from Synap's own `/inbound` scheme), dedup on booking uid + trigger,
// and turn a BOOKING_CREATED into ONE composite `capture/graph` proposal
// (person + company + deal(lead) + event) via the shared submitCaptureGraph door.
// The `event` entity is event-sync-shaped, so an approved booking also mirrors to
// a native Discord scheduled event with no Google-Calendar dependency.
//
// Config lives on the `cal_com` tool: metadata.calcom.webhook =
//   { token, secretVaultRef, workspaceId?, ownerUserId?, seen: { "<uid>:<trigger>": iso } }
// The `:token` path segment selects + authorizes the config (unknown → 404, no leak).
// Missed webhooks (pod down) are self-healed by the Cal backfill poller.
interface CalcomWebhookConfig {
  token?: string;
  secretVaultRef?: string;
  workspaceId?: string | null;
  ownerUserId?: string;
  seen?: Record<string, string>;
}

// Best-effort maintenance update of the event a prior BOOKING_CREATED materialized,
// matched by calBookingUid. Reschedule → new times/link; cancel → status flag.
// Returns the number of event rows patched — 0 means the event doesn't exist yet
// (its capture proposal is still pending approval) or the uid changed. The caller
// uses that to avoid falsely marking an unapplied reschedule/cancel as "seen".
//
// v1 LIMITATION (NEEDS-DOGFOOD against a real Cal.com reschedule): Cal may assign a
// NEW uid on reschedule (reschedule = cancel-old + new-booking), in which case this
// won't match the stored event. Verify the real payload before hardening; today a
// reschedule pre-approval, or with a changed uid, is left for manual reconciliation.
async function updateBookingEvent(
  uid: string,
  workspaceId: string | null,
  patch: Record<string, unknown>
): Promise<number> {
  const rows = await db.query.entities.findMany({
    where: and(
      eq(entities.type, "event"),
      drizzleSql`${entities.properties}->>'calBookingUid' = ${uid}`,
      workspaceId ? eq(entities.workspaceId, workspaceId) : drizzleSql`TRUE`
    ),
    columns: { id: true },
  });
  for (const r of rows) {
    await db
      .update(entities)
      .set({
        properties: drizzleSql`COALESCE(${entities.properties}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(entities.id, r.id));
  }
  return rows.length;
}

webhooksInboundRouter.post("/calcom/:token", async (c) => {
  const token = c.req.param("token");
  const rawBody = await c.req.text();

  // Resolve the cal_com tool + its webhook config; `:token` must match (else 404).
  const calTool = await db.query.tools.findFirst({
    where: eq(tools.name, "cal_com"),
    columns: {
      id: true,
      createdBy: true,
      workspaceId: true,
      metadata: true,
    },
  });
  const metadata = (calTool?.metadata ?? {}) as {
    calcom?: { webhook?: CalcomWebhookConfig };
  };
  const cfg = metadata.calcom?.webhook;
  if (!calTool || !cfg?.token || !cfg.secretVaultRef || cfg.token !== token) {
    return c.json({ error: "Not found" }, 404);
  }

  const ownerUserId = cfg.ownerUserId ?? calTool.createdBy;
  const workspaceId = cfg.workspaceId ?? calTool.workspaceId ?? null;

  // Redeem the webhook signing secret from the vault (never logged).
  const secret = await resolveVaultSecret(cfg.secretVaultRef, ownerUserId);
  if (!secret) {
    logger.error({ toolId: calTool.id }, "cal.com webhook: secret unresolved");
    return c.json({ error: "Webhook not configured" }, 500);
  }

  // Verify signature — Cal sends hex HMAC-SHA256 of the raw body, NO prefix.
  const signature = c.req.header("x-cal-signature-256") ?? "";
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    logger.warn({ toolId: calTool.id }, "cal.com webhook: invalid signature");
    return c.json({ error: "Invalid signature" }, 401);
  }

  let envelope: { triggerEvent?: string; payload?: CalBookingPayload } | null;
  try {
    envelope = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const trigger = envelope?.triggerEvent ?? "";
  const payload = envelope?.payload ?? {};
  const uid = payload.uid?.trim();
  if (!uid || !trigger) {
    // Ping/handshake or a payload we can't key — ack so Cal doesn't retry.
    return c.json({ received: true, ignored: true }, 200);
  }

  // Idempotency: dedup on uid + trigger. Already handled → ack no-op.
  const seenKey = `${uid}:${trigger}`;
  if (cfg.seen && cfg.seen[seenKey]) {
    return c.json({ received: true, deduped: true }, 200);
  }

  // Do the work best-effort. On failure we STILL 200 (Cal retries on non-2xx,
  // which would storm) — the backfill poller is the safety net for a lost event.
  // `markSeen` is only set once the work actually landed, so an unapplied
  // reschedule/cancel (event not materialized yet) is NOT recorded as handled.
  let markSeen = false;
  try {
    if (trigger === "BOOKING_CREATED") {
      const actor = (await getCaptureAgentUserId()) ?? ownerUserId;
      const { entities: graphEntities, relations } = mapBookingToGraph(payload);
      await submitCaptureGraph({
        userId: actor,
        workspaceId,
        entities: graphEntities,
        relations,
        summary: `Cal.com booking — ${payload.title ?? uid}`,
      });
      markSeen = true;
    } else if (trigger === "BOOKING_RESCHEDULED") {
      const startDate = (payload.startTime ?? payload.start)?.trim();
      const endDate = (payload.endTime ?? payload.end)?.trim();
      const matched = await updateBookingEvent(uid, workspaceId, {
        ...(startDate ? { startDate } : {}),
        ...(endDate ? { endDate } : {}),
      });
      markSeen = matched > 0;
      if (!matched)
        logger.info(
          { toolId: calTool.id, uid },
          "cal.com webhook: reschedule not applied — event not yet materialized or uid changed (left unmarked, not reconciled in v1)"
        );
    } else if (trigger === "BOOKING_CANCELLED") {
      const matched = await updateBookingEvent(uid, workspaceId, {
        status: "cancelled",
      });
      markSeen = matched > 0;
      if (!matched)
        logger.info(
          { toolId: calTool.id, uid },
          "cal.com webhook: cancel not applied — event not yet materialized or uid changed (left unmarked)"
        );
    } else {
      return c.json({ received: true, ignored: true }, 200);
    }
  } catch (err) {
    logger.error(
      { err, toolId: calTool.id, trigger, uid },
      "cal.com webhook: handler failed (backfill will retry)"
    );
    return c.json({ received: true, deferred: true }, 200);
  }

  // Nothing landed (e.g. a pre-approval reschedule) → don't mark seen, just ack.
  if (!markSeen) {
    return c.json({ received: true, unapplied: true }, 200);
  }

  // Mark seen via the shared race-safe single-leaf writer (see markWebhookSeen).
  await markWebhookSeen(calTool.id, "calcom", seenKey);

  return c.json({ received: true }, 200);
});

// ── Fireflies inbound webhook — meeting transcripts → channel/message ─────────
//
// Fireflies fires ONE event, `Transcription complete`, with a MINIMAL payload
// { meetingId, eventType, clientReferenceId } — no transcript body. We verify,
// dedup on meetingId, and ACK-THEN-PROCESS: enqueue a `fireflies-ingest` pg-boss
// job that follows up with a GraphQL fetch (fireflies_get_transcript) and lands
// the transcript as a channel MESSAGE via recordInboundMessage. Returning fast is
// deliberate — the fetch is off the request path (timeout/retry safety), and the
// backfill poller recovers anything the webhook drops.
//
// Config lives on the `fireflies` tool: metadata.fireflies.webhook =
//   { token, secretVaultRef?, workspaceId?, ownerUserId?, seen: { "<meetingId>": iso } }
// The `:token` path segment selects + authorizes the config (unknown → 404, no
// leak) — the same primary-auth contract as the cal.com route. When `secretVaultRef`
// is set we ADDITIONALLY verify the Fireflies `x-hub-signature` header (SHA-256 HMAC
// of the raw body, `sha256=<hex>`, vault-resolved secret) FAIL-CLOSED. When it is
// absent the unguessable `:token` is the shared secret (documented fallback — some
// Fireflies webhooks are configured without a signing secret).
// Docs: https://docs.fireflies.ai/graphql-api/webhooks (V2 sends X-Hub-Signature
// = `sha256=<hex>`).
//
// The seen-map is written by the INGEST RUNNER only, AFTER the message lands (not
// here) — so a fetch/ingest failure leaves the meeting unseen for the backfill
// poller to retry. This route only READS `seen` to skip re-enqueueing.
interface FirefliesWebhookConfig {
  token?: string;
  secretVaultRef?: string;
  workspaceId?: string | null;
  ownerUserId?: string;
  seen?: Record<string, string>;
}

webhooksInboundRouter.post("/fireflies/:token", async (c) => {
  const token = c.req.param("token");

  const contentLength = c.req.header("content-length");
  if (
    contentLength &&
    Number.parseInt(contentLength, 10) > MAX_INBOUND_WEBHOOK_BODY
  ) {
    return c.json({ error: "Payload too large" }, 413);
  }
  const rawBody = await c.req.text();
  if (rawBody.length > MAX_INBOUND_WEBHOOK_BODY) {
    return c.json({ error: "Payload too large" }, 413);
  }

  // Resolve the fireflies tool + its webhook config; `:token` must match (else 404).
  const ffTool = await db.query.tools.findFirst({
    where: eq(tools.name, "fireflies"),
    columns: { id: true, createdBy: true, workspaceId: true, metadata: true },
  });
  const metadata = (ffTool?.metadata ?? {}) as {
    fireflies?: { webhook?: FirefliesWebhookConfig };
  };
  const cfg = metadata.fireflies?.webhook;
  if (!ffTool || !cfg?.token || cfg.token !== token) {
    return c.json({ error: "Not found" }, 404);
  }

  const ownerUserId = cfg.ownerUserId ?? ffTool.createdBy;
  const workspaceId = cfg.workspaceId ?? ffTool.workspaceId ?? null;

  // Signature (defense-in-depth): only when a signing secret is provisioned. Verify
  // the SHA-256 HMAC in `x-hub-signature` (`sha256=<hex>`) against the vault secret.
  if (cfg.secretVaultRef) {
    const secret = await resolveVaultSecret(cfg.secretVaultRef, ownerUserId);
    if (!secret) {
      logger.error(
        { toolId: ffTool.id },
        "fireflies webhook: secret unresolved"
      );
      return c.json({ error: "Webhook not configured" }, 500);
    }
    const signature = c.req.header("x-hub-signature") ?? "";
    const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      logger.warn(
        { toolId: ffTool.id },
        "fireflies webhook: invalid signature"
      );
      return c.json({ error: "Invalid signature" }, 401);
    }
  }

  let envelope: {
    meetingId?: string;
    eventType?: string;
    clientReferenceId?: string;
  } | null;
  try {
    envelope = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const meetingId = envelope?.meetingId?.trim();
  const eventType = envelope?.eventType ?? "";
  if (!meetingId) {
    // Ping/handshake or a payload we can't key — ack so Fireflies doesn't retry.
    return c.json({ received: true, ignored: true }, 200);
  }
  // Fireflies fires exactly one event; match it leniently ("Transcription
  // complete"/"completed"). Anything else → ack no-op.
  if (!/transcription complet/i.test(eventType)) {
    return c.json({ received: true, ignored: true }, 200);
  }

  // Dedup: already ingested (seen-map keyed on meetingId) → ack no-op.
  if (cfg.seen && cfg.seen[meetingId]) {
    return c.json({ received: true, deduped: true }, 200);
  }

  // Ack-then-process: enqueue the fetch-then-land job with pg-boss retry safety.
  const jobData: FirefliesIngestJobData = {
    meetingId,
    clientReferenceId: envelope?.clientReferenceId ?? null,
    toolId: ffTool.id,
    workspaceId,
    ownerUserId,
  };
  await getBoss()
    .send(FIREFLIES_INGEST_QUEUE, jobData, {
      retryLimit: 5,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: 300,
    })
    .catch((err) =>
      logger.error(
        { err, toolId: ffTool.id, meetingId },
        "fireflies webhook: enqueue failed (backfill will retry)"
      )
    );

  return c.json({ received: true, queued: true }, 200);
});

// ── Mailgun inbound webhook — client email → channel/message ────────────────
//
// Mailgun's inbound route POSTs a `multipart/form-data` "Parsed" payload
// (https://documentation.mailgun.com/docs/mailgun/user-manual/receiving-forwarding-and-storing-messages/#parsed-messages-parameters)
// for every message delivered to our catch-all inbound address — this ALSO
// covers Proton Mail: a Proton user sets an auto-forward rule from their inbox
// to that address, so a client's Proton email lands here as an ordinary
// forwarded message (see the forwarding nuance in map-inbound-to-message.ts).
//
// Signature verification (Mailgun's webhook-signing scheme, same for tracking
// AND inbound-route webhooks):
//   expected = hex(HMAC-SHA256(key = signingKey, msg = timestamp + token))
// compared against the payload's own `signature` field. NOTE the payload's
// `token` FIELD (Mailgun's per-request nonce) is distinct from the `:token`
// URL segment below (our tenant/tool selector) — same naming collision as
// documented on the cal.com/fireflies routes for their own schemes.
// Docs: https://documentation.mailgun.com/docs/mailgun/user-manual/tracking-messages/#webhooks
// and https://documentation.mailgun.com/docs/mailgun/user-manual/receiving-forwarding-and-storing-messages/#webhook
//
// Config lives on the `mailgun` tool: metadata.mailgun.webhook =
//   { token, secretVaultRef, workspaceId?, ownerUserId?, seen: { "<Message-Id>": iso } }
// The `:token` path segment selects + authorizes the config (unknown → 404, no
// leak) — the same primary-auth contract as the cal.com/fireflies routes.
//
// One channel per CLIENT (not per email thread): externalId is the resolved
// client entity id when the sender's email strong-matches an existing entity,
// else the sender email itself (creates an unlinked channel for the review
// queue — same posture as the Fireflies unlinked-transcript fallback).
interface MailgunWebhookConfig {
  token?: string;
  secretVaultRef?: string;
  workspaceId?: string | null;
  ownerUserId?: string;
  seen?: Record<string, string>;
}

webhooksInboundRouter.post("/mailgun/:token", async (c) => {
  const token = c.req.param("token");

  const contentLength = c.req.header("content-length");
  if (
    contentLength &&
    Number.parseInt(contentLength, 10) > MAX_INBOUND_WEBHOOK_BODY
  ) {
    return c.json({ error: "Payload too large" }, 413);
  }

  // Resolve the mailgun tool + its webhook config; `:token` must match (else 404).
  const mgTool = await db.query.tools.findFirst({
    where: eq(tools.name, "mailgun"),
    columns: { id: true, createdBy: true, workspaceId: true, metadata: true },
  });
  const metadata = (mgTool?.metadata ?? {}) as {
    mailgun?: { webhook?: MailgunWebhookConfig };
  };
  const cfg = metadata.mailgun?.webhook;
  if (!mgTool || !cfg?.token || !cfg.secretVaultRef || cfg.token !== token) {
    return c.json({ error: "Not found" }, 404);
  }

  const ownerUserId = cfg.ownerUserId ?? mgTool.createdBy;
  const workspaceId = cfg.workspaceId ?? mgTool.workspaceId ?? null;

  // Redeem the webhook signing key from the vault (never logged).
  const secret = await resolveVaultSecret(cfg.secretVaultRef, ownerUserId);
  if (!secret) {
    logger.error({ toolId: mgTool.id }, "mailgun webhook: secret unresolved");
    return c.json({ error: "Webhook not configured" }, 500);
  }

  // Mailgun sends multipart/form-data, not JSON — parse it, cap size defensively
  // via content-length above (form parsing buffers the whole body regardless).
  let form: Record<string, string | File>;
  try {
    form = await c.req.parseBody();
  } catch {
    return c.json({ error: "Invalid payload" }, 400);
  }
  const field = (name: string): string =>
    typeof form[name] === "string" ? (form[name] as string) : "";

  const mgTimestamp = field("timestamp");
  const mgToken = field("token");
  const mgSignature = field("signature");
  if (!mgTimestamp || !mgToken || !mgSignature) {
    // Not a real Mailgun signed request — reject fail-closed rather than guess.
    logger.warn(
      { toolId: mgTool.id },
      "mailgun webhook: missing signature fields"
    );
    return c.json({ error: "Unauthorized" }, 401);
  }
  // Replay guard: reject a stale (timestamp,token,signature) triple. Mailgun's
  // `timestamp` field is Unix SECONDS; bound a captured POST to a ~15-min window.
  // (The seen-map dedup covers same-Message-Id replays; this closes the window
  // before an id is ever recorded, per Mailgun's own anti-replay guidance.)
  const tsSeconds = Number.parseInt(mgTimestamp, 10);
  if (
    !Number.isFinite(tsSeconds) ||
    Math.abs(Date.now() / 1000 - tsSeconds) > 900
  ) {
    logger.warn(
      { toolId: mgTool.id },
      "mailgun webhook: stale/invalid timestamp"
    );
    return c.json({ error: "Stale timestamp" }, 401);
  }
  const expected = createHmac("sha256", secret)
    .update(`${mgTimestamp}${mgToken}`)
    .digest("hex");
  const sigBuf = Buffer.from(mgSignature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    logger.warn({ toolId: mgTool.id }, "mailgun webhook: invalid signature");
    return c.json({ error: "Invalid signature" }, 401);
  }

  // Fall back to a deterministic seed when Mailgun omits Message-Id (rare,
  // malformed origin message) so we always have something stable to dedup on.
  const fallbackMessageId = `${mgTimestamp}:${mgToken}`;
  const mapped = mapMailgunInboundToMessage(
    {
      sender: field("sender"),
      recipient: field("recipient"),
      subject: field("subject"),
      "body-plain": field("body-plain"),
      "stripped-text": field("stripped-text"),
      "Message-Id": field("Message-Id"),
      From: field("From"),
      "Reply-To": field("Reply-To"),
    },
    fallbackMessageId
  );

  // Dedup: already ingested (seen-map keyed on Message-Id) → ack no-op.
  if (cfg.seen && cfg.seen[mapped.messageId]) {
    return c.json({ received: true, deduped: true }, 200);
  }

  if (!mapped.senderEmail) {
    // No usable sender address at all — nothing to resolve or land against.
    // Ack so Mailgun doesn't retry a message we can never process.
    logger.warn(
      { toolId: mgTool.id, messageId: mapped.messageId },
      "mailgun webhook: no parseable sender address — ignored"
    );
    return c.json({ received: true, ignored: true }, 200);
  }

  // Resolve the sender to an existing client entity via the strong `email`
  // signal. Unresolved → fall back to the sender email as the channel key
  // (unlinked channel, same posture as the Fireflies unlinked-transcript path).
  let resolvedClientEntityId: string | null = null;
  try {
    const resolution = await resolveIdentity(db, {
      userId: ownerUserId,
      signals: [{ type: "email", value: mapped.senderEmail }],
    });
    if (resolution.match === "strong" && resolution.entity) {
      resolvedClientEntityId = resolution.entity.id;
    }
  } catch (err) {
    logger.warn(
      { err, senderEmail: mapped.senderEmail },
      "mailgun webhook: identity resolution failed — falling back to sender-email channel"
    );
  }
  const externalId = resolvedClientEntityId ?? mapped.senderEmail;

  const result = await recordInboundMessage({
    provider: "mailgun",
    externalId,
    userId: ownerUserId,
    workspaceId,
    // `recordInboundMessage` has no separate subject field — the mapper folds
    // "Subject: <subject>" into the stored text (mirrors fireflies' header).
    text: mapped.text,
    participant: mapped.senderEmail,
    title: mapped.senderEmail,
    idempotencySeed: mapped.messageId,
    messageId: mapped.messageId,
  });

  // Mark seen via the shared race-safe single-leaf writer.
  if (result.recorded) {
    await markWebhookSeen(mgTool.id, "mailgun", mapped.messageId);
  }

  return c.json({ received: true, deduped: !result.recorded }, 200);
});

webhooksInboundRouter.post("/messaging", async (c) => {
  const rawBody = await c.req.text();
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((v, k) => {
    headers[k] = v;
  });

  const connector = await getMessagingConnector();
  if (!connector) {
    return c.json({ error: "Messaging connector not configured" }, 503);
  }

  let parsed: Awaited<ReturnType<typeof connector.parseWebhook>>;
  try {
    parsed = await connector.parseWebhook(headers, rawBody);
  } catch (err) {
    logger.warn({ err }, "Webhook parse error");
    return c.json({ ok: true }); // always 200 to prevent Unipile retries on auth failures
  }

  if (!parsed) return c.json({ ok: true });
  // Bind to a const so non-null narrowing holds inside the closures below
  // (e.g. liveAccounts.find(a => a.externalId === event.accountExternalId)).
  const event = parsed;

  try {
    if (event.type === "message.created") {
      const account = await db.query.messagingAccounts.findFirst({
        where: and(
          eq(messagingAccounts.externalId, event.accountExternalId),
          eq(messagingAccounts.provider, event.provider)
        ),
      });
      if (!account) return c.json({ ok: true });

      // Find the workspace owned by this user
      const workspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.ownerId, account.userId),
      });
      if (!workspace) {
        logger.warn(
          { userId: account.userId },
          "No workspace found for messaging account owner"
        );
        return c.json({ ok: true });
      }

      const senderName = event.message.senderName;

      // Resolve-or-create the EXTERNAL channel + dedup-record the inbound
      // message + fire `external_message.received` via the shared recorder.
      // Unipile has no native message id, so the idempotency seed is the same
      // composite the inline path hashed before: thread + sentAt + body.
      await recordInboundMessage({
        provider: event.provider,
        externalId: event.threadId,
        userId: account.userId,
        workspaceId: workspace.id,
        text: event.message.body,
        participant: senderName,
        accountExternalId: account.externalId,
        title: senderName,
        idempotencySeed: `${event.threadId}:${event.message.sentAt}:${event.message.body}`,
        sentAt: event.message.sentAt,
      });
    } else if (event.type === "account.created") {
      // notify_url callback: auto-sync the newly connected account into our DB
      const connector = await getMessagingConnector();
      if (connector) {
        const liveAccounts = await connector
          .getAccounts(event.userId)
          .catch(() => []);
        const account = liveAccounts.find(
          (a) => a.externalId === event.accountExternalId
        );
        if (account) {
          await MessagingAccountService.upsert({
            userId: event.userId,
            provider: account.provider,
            externalId: account.externalId,
            displayName: account.displayName,
            status: account.status,
          });
          logger.info(
            {
              userId: event.userId,
              externalId: event.accountExternalId,
              provider: account.provider,
            },
            "Account auto-synced after hosted auth connection"
          );
        }
      }
    } else if (event.type === "account.reconnection_required") {
      await MessagingAccountService.updateStatus(
        event.accountExternalId,
        event.provider,
        "reconnection_required",
        event.accountExternalId
      );
      logger.info(
        { externalId: event.accountExternalId },
        "Account reconnection required"
      );
    } else if (event.type === "account.disconnected") {
      await MessagingAccountService.updateStatus(
        event.accountExternalId,
        event.provider,
        "disconnected",
        event.accountExternalId
      );
      logger.info(
        { externalId: event.accountExternalId },
        "Account disconnected"
      );
    }
  } catch (err) {
    logger.error({ err, event }, "Webhook handler error");
  }

  return c.json({ ok: true });
});
