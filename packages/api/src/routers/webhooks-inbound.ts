import { createHmac, timingSafeEqual } from "crypto";
import { Hono } from "hono";
import { createLogger } from "@synap-core/core";
import {
  db,
  eq,
  and,
  workspaces,
  messagingAccounts,
  webhookSubscriptions,
} from "@synap/database";
import { emitSideEffects } from "@synap/events";
import { getMessagingConnector } from "../connectors/index.js";
import { MessagingAccountService } from "../services/messaging-account-service.js";
import { recordInboundMessage } from "../services/connectors/inbound-recorder.js";

const logger = createLogger({ module: "webhooks-inbound" });

export const webhooksInboundRouter = new Hono();

// Generic inbound webhook — external backend → Synap
// Static route must appear before /:id dynamic routes (Hono ordering rule)
webhooksInboundRouter.post("/inbound/:subscriptionId", async (c) => {
  const subscriptionId = c.req.param("subscriptionId");
  const rawBody = await c.req.text();

  const subscription = await db.query.webhookSubscriptions.findFirst({
    where: and(
      eq(webhookSubscriptions.id, subscriptionId),
      eq(webhookSubscriptions.active, true)
    ),
  });

  if (!subscription) {
    return c.json({ error: "Not found" }, 404);
  }

  // Verify HMAC-SHA256 signature — timingSafeEqual requires equal-length buffers
  const signature = c.req.header("x-synap-signature") ?? "";
  const expected = `sha256=${createHmac("sha256", subscription.secret).update(rawBody).digest("hex")}`;
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  const sigValid =
    sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf);

  if (!sigValid) {
    logger.warn({ subscriptionId }, "Invalid signature on inbound webhook");
    return c.json({ error: "Invalid signature" }, 401);
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
