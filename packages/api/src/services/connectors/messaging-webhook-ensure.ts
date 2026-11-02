/**
 * The messaging webhook registers itself (channels design §3).
 *
 * Before, the pod asked Unipile to deliver its events only when someone synced
 * accounts by hand (`POST /messaging/accounts/sync`), so a pod whose endpoint
 * was never registered, or lost an event, received no inbound message and
 * nothing said so. This runs from the `messaging-webhook-ensure` job: every
 * hour, shortly after boot, and when an account connects. It registers (or
 * completes) the endpoint, then reads it back and records the result for
 * `GET /messaging/service-config` (`webhook`).
 */

import { createLogger } from "@synap-core/core";
import { getMessagingConnector } from "../../connectors/index.js";
import {
  recordMessagingWebhookState,
  type MessagingWebhookState,
} from "../../connectors/unipile-connection.js";
import type { MessagingConnector } from "../../connectors/MessagingConnector.js";

const logger = createLogger({ module: "messaging-webhook-ensure" });

export interface RunMessagingWebhookEnsureResult {
  /** False when the pod has no messaging service (nothing to register). */
  configured: boolean;
  webhook?: MessagingWebhookState;
}

/** Register the endpoint, read it back, record what it says. Never throws. */
export async function runMessagingWebhookEnsure(
  deps: {
    connector?: MessagingConnector | null;
    publicUrl?: string | null;
    now?: Date;
  } = {}
): Promise<RunMessagingWebhookEnsureResult> {
  const connector =
    deps.connector !== undefined
      ? deps.connector
      : await getMessagingConnector().catch((err) => {
          logger.warn({ err }, "messaging connector unreadable");
          return null;
        });
  if (!connector) return { configured: false };

  const publicUrl =
    deps.publicUrl !== undefined
      ? deps.publicUrl
      : (process.env.PUBLIC_URL ?? null);
  const checkedAt = (deps.now ?? new Date()).toISOString();

  let registerError: string | null = null;
  if (publicUrl) {
    try {
      await connector.ensureWebhooksRegistered(publicUrl);
    } catch (err) {
      registerError = err instanceof Error ? err.message : String(err);
      logger.warn({ err }, "messaging webhook registration failed");
    }
  }

  let webhook: MessagingWebhookState;
  if (connector.describeWebhook) {
    const health = await connector.describeWebhook(publicUrl);
    webhook = {
      state: health.state,
      url: health.url,
      missingEvents: health.missingEvents,
      error: health.error ?? registerError,
      checkedAt,
    };
  } else {
    webhook = {
      state: "unknown",
      url: null,
      missingEvents: [],
      error:
        registerError ?? "This messaging connector cannot report its webhook.",
      checkedAt,
    };
  }
  recordMessagingWebhookState(webhook);
  if (webhook.state !== "registered") {
    logger.warn({ webhook }, "messaging webhook is not fully registered");
  }
  return { configured: true, webhook };
}
