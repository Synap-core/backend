/**
 * Expo push transport — the `"os"` delivery channel.
 *
 * WHY A DIRECT CALL AND NOT THE `channel_egress` OUTBOX
 * -----------------------------------------------------
 * `channel_egress` is an outbox that an EXTERNAL adapter (the Discord bridge)
 * POLLS: its kinds are channel-shaped (`post_message`, `rename_channel`,
 * `pin_message`) and its (`externalSource`, `externalId`) pair names a channel
 * inside a chat platform. Nothing polls it for a provider named 'expo', and a
 * push token is a device, not a channel. Enqueuing there would be a write with
 * no consumer — a notification that looks delivered and never arrives. So this
 * calls Expo directly, but reuses the backend's existing outbound-HTTP
 * resilience pair — `withRetryResult` + `circuitBreakerRegistry` from
 * `@synap/shared-utils`, the same combination `DeliveryService` uses for every
 * other external surface — rather than inventing a second retry story.
 *
 * Nothing here throws: push is a delivery channel, and a dead phone must never
 * fail the notification that was already persisted.
 */

import {
  db,
  and,
  eq,
  messagingAccounts,
  MESSAGING_ACCOUNT_PROVIDER_EXPO,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import {
  withRetryResult,
  API_RETRY_OPTIONS,
  circuitBreakerRegistry,
} from "@synap/shared-utils";
import { MessagingAccountService } from "../services/messaging-account-service.js";

const logger = createLogger({ module: "expo-push" });

/** Expo's documented send endpoint. */
const EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send";

/** Expo accepts at most 100 messages per request. */
const EXPO_MAX_BATCH = 100;

/**
 * A ticket whose `details.error` is one of these is PERMANENT for that token —
 * the device can never receive again, so retrying it forever is pure waste.
 * `DeviceNotRegistered` is the one Expo documents for an uninstalled app or a
 * rotated token; it is the only one that revokes the account.
 */
const DEVICE_DEAD_ERROR = "DeviceNotRegistered";

export interface ExpoPushInput {
  userId: string;
  title: string;
  body: string;
  /** Delivered to the app as the notification's `data` payload (deep-link etc.). */
  data?: Record<string, unknown>;
}

interface ExpoTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

/** Circuit breaker shared by every push send — one open circuit pauses all. */
function pushCircuitBreaker() {
  return circuitBreakerRegistry.get("delivery-expo-push", {
    failureThreshold: 5,
    resetTimeoutMs: 60000,
    halfOpenMaxCalls: 3,
    successThreshold: 2,
  });
}

/**
 * The caller's CONNECTED expo device tokens. A row is floored on `user_id`, so
 * this can only ever read the recipient's own devices. A `disconnected` row
 * (revoked by the user, or killed by a `DeviceNotRegistered` ticket) is
 * deliberately excluded rather than deleted, so the unique index still absorbs
 * a later re-register on that device.
 */
async function connectedPushTokens(userId: string): Promise<string[]> {
  const rows = await db.query.messagingAccounts.findMany({
    where: and(
      eq(messagingAccounts.userId, userId),
      eq(messagingAccounts.provider, MESSAGING_ACCOUNT_PROVIDER_EXPO),
      eq(messagingAccounts.status, "connected")
    ),
    columns: { externalId: true },
  });
  return rows.map((r) => r.externalId);
}

/** POST one batch, returning its tickets in request order. */
async function postBatch(
  tokens: string[],
  input: ExpoPushInput
): Promise<ExpoTicket[]> {
  const accessToken = process.env.EXPO_ACCESS_TOKEN;

  const response = await fetch(EXPO_PUSH_ENDPOINT, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      // Only sent when the project has Expo's enhanced push security enabled;
      // Expo rejects an empty bearer, so the header is omitted when unset.
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(
      tokens.map((to) => ({
        to,
        title: input.title,
        body: input.body,
        sound: "default",
        ...(input.data ? { data: input.data } : {}),
      }))
    ),
  });

  if (!response.ok) {
    // The status code is IN the message on purpose: API_RETRY_OPTIONS matches
    // retryable failures (5xx, 429) against the error text, so a 4xx that is
    // our own fault stops immediately instead of being retried three times.
    throw new Error(
      `Expo push failed: ${response.status} ${response.statusText}`
    );
  }

  const json = (await response.json()) as { data?: ExpoTicket[] };
  return Array.isArray(json.data) ? json.data : [];
}

/**
 * Send one notification to every connected device of `userId`.
 *
 * Never throws. Returns what actually happened so a caller (or a test) can tell
 * "no devices" from "sent" from "the transport is down" — an outcome a
 * fire-and-forget `void` would hide.
 */
export async function sendExpoPush(
  input: ExpoPushInput
): Promise<{ sent: number; revoked: number; failed: number }> {
  const outcome = { sent: 0, revoked: 0, failed: 0 };

  let tokens: string[];
  try {
    tokens = await connectedPushTokens(input.userId);
  } catch (err) {
    logger.error({ err, userId: input.userId }, "Failed to load push devices");
    return outcome;
  }

  if (tokens.length === 0) {
    // The ordinary case for a user who has never opened the mobile app. Not a
    // warning — `"os"` is a default channel for most notification types, so
    // most sends legitimately land here.
    logger.debug(
      { userId: input.userId },
      "No connected expo devices — skipping push"
    );
    return outcome;
  }

  const breaker = pushCircuitBreaker();
  if (breaker.getStats().state === "open") {
    logger.warn(
      { userId: input.userId, devices: tokens.length },
      "Expo push circuit open — skipping push (notification already persisted)"
    );
    outcome.failed = tokens.length;
    return outcome;
  }

  for (let i = 0; i < tokens.length; i += EXPO_MAX_BATCH) {
    const batch = tokens.slice(i, i + EXPO_MAX_BATCH);

    const result = await withRetryResult(
      () => breaker.execute(() => postBatch(batch, input)),
      API_RETRY_OPTIONS
    );

    if (!result.success || !result.data) {
      logger.warn(
        { err: result.error, userId: input.userId, devices: batch.length },
        "Expo push batch failed after retries (notification already persisted)"
      );
      outcome.failed += batch.length;
      continue;
    }

    // Tickets come back positionally, one per message sent.
    for (let t = 0; t < batch.length; t++) {
      const ticket = result.data[t];
      const token = batch[t]!;

      if (ticket?.status === "ok") {
        outcome.sent++;
        continue;
      }

      outcome.failed++;

      if (ticket?.details?.error === DEVICE_DEAD_ERROR) {
        // The device is gone for good. Flip the account to `disconnected` so
        // the next send skips it — otherwise a stale token is retried on every
        // notification forever, and one uninstalled app slowly poisons the
        // circuit breaker for every other device the user owns.
        const revoked = await MessagingAccountService.setStatusForUser({
          userId: input.userId,
          provider: MESSAGING_ACCOUNT_PROVIDER_EXPO,
          externalId: token,
          status: "disconnected",
        }).catch((err) => {
          logger.warn({ err }, "Failed to revoke dead push token (non-fatal)");
          return false;
        });
        if (revoked) outcome.revoked++;
        logger.info(
          { userId: input.userId },
          "Expo reported DeviceNotRegistered — device disconnected"
        );
        continue;
      }

      logger.warn(
        {
          userId: input.userId,
          expoError: ticket?.details?.error,
          message: ticket?.message,
        },
        "Expo push ticket returned an error"
      );
    }
  }

  return outcome;
}
