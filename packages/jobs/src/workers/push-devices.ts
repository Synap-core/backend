/**
 * Phone push hygiene — two jobs that stop the pod sending to phones that can
 * no longer receive (the `expo` rows of `messaging_accounts`).
 *
 * RECEIPTS (`push-receipts`, one job per send, ~15 minutes later). Expo
 * answers a send with a TICKET per message, and most "this token is dead"
 * answers (`DeviceNotRegistered`) arrive only in the RECEIPT fetched with
 * that ticket id later. Without this step an uninstalled app's token stays
 * `connected` and is sent to forever. The send (`api/notifications/
 * expo-push.ts`) queues the ticket ids with the phone's row id — never the
 * token, which is a delivery credential and has no business in a job table.
 *
 * STALE SWEEP (`push-device-sweep`, daily). A phone whose app registers on
 * every launch carries `metadata.lastSeenAt`; one unused for
 * `PUSH_DEVICE_STOP_DAYS` stops getting pushes (`disconnected`) and comes
 * back on its next launch. A row without `lastSeenAt` (an app that does not
 * register on every launch) is never swept: its age says nothing about use.
 *
 * Both only ever move `connected` → `disconnected`. A phone the person turned
 * off (`revoked`) is theirs to turn back on, never rewritten here.
 */

import {
  db,
  and,
  eq,
  inArray,
  drizzleSql,
  messagingAccounts,
  MESSAGING_ACCOUNT_PROVIDER_EXPO,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { PUSH_DEVICE_STOP_DAYS } from "@synap-core/types/push";

const logger = createLogger({ module: "push-devices-worker" });

export const PUSH_RECEIPTS_QUEUE = "push-receipts";
export const PUSH_DEVICE_SWEEP_QUEUE = "push-device-sweep";
/** Daily at 02:50 UTC, after the other nightly cleanups. */
export const PUSH_DEVICE_SWEEP_CRON = "50 2 * * *";

/** Expo keeps receipts ~24h and advises waiting ~15 minutes before asking. */
export const PUSH_RECEIPTS_DELAY_SECONDS = 15 * 60;

const EXPO_RECEIPTS_ENDPOINT = "https://exp.host/--/api/v2/push/getReceipts";
/** Expo accepts at most 1000 ids per receipts request. */
const EXPO_MAX_RECEIPT_IDS = 1000;
const DEVICE_DEAD_ERROR = "DeviceNotRegistered";

export interface PushReceiptsPayload {
  userId: string;
  /** One per `ok` ticket: Expo's ticket id and the phone row it went to. */
  tickets: Array<{ ticketId: string; deviceId: string }>;
}

interface ExpoReceipt {
  status: "ok" | "error";
  message?: string;
  details?: { error?: string };
}

type Fetch = typeof fetch;

async function fetchReceipts(
  ids: string[],
  fetchFn: Fetch
): Promise<Record<string, ExpoReceipt>> {
  const accessToken = process.env.EXPO_ACCESS_TOKEN;
  const response = await fetchFn(EXPO_RECEIPTS_ENDPOINT, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify({ ids }),
  });
  if (!response.ok) {
    throw new Error(
      `Expo receipts failed: ${response.status} ${response.statusText}`
    );
  }
  const json = (await response.json()) as {
    data?: Record<string, ExpoReceipt>;
  };
  return json.data && typeof json.data === "object" ? json.data : {};
}

/**
 * Turn `connected` phones of `userId` off. Floored on the owner and on the
 * current status, so a phone turned back on (or turned off by the person)
 * since the send is left alone.
 */
async function disconnectPhones(
  userId: string,
  deviceIds: string[]
): Promise<number> {
  if (deviceIds.length === 0) return 0;
  const done = await db
    .update(messagingAccounts)
    .set({ status: "disconnected", updatedAt: new Date() })
    .where(
      and(
        eq(messagingAccounts.userId, userId),
        eq(messagingAccounts.provider, MESSAGING_ACCOUNT_PROVIDER_EXPO),
        eq(messagingAccounts.status, "connected"),
        inArray(messagingAccounts.id, deviceIds)
      )
    )
    .returning({ id: messagingAccounts.id });
  return done.length;
}

/**
 * Read the receipts of one send and turn off every phone Expo reports as
 * `DeviceNotRegistered`. A receipt not there yet (or already expired) is
 * skipped: a later send queues its own check. Throws when Expo cannot be
 * reached, so pg-boss retries.
 */
export async function handlePushReceipts(
  payload: PushReceiptsPayload,
  fetchFn: Fetch = fetch
): Promise<{ checked: number; disconnected: number }> {
  const deviceOf = new Map(
    payload.tickets.map((t) => [t.ticketId, t.deviceId])
  );
  const ids = [...deviceOf.keys()];
  const dead = new Set<string>();
  let checked = 0;

  for (let i = 0; i < ids.length; i += EXPO_MAX_RECEIPT_IDS) {
    const receipts = await fetchReceipts(
      ids.slice(i, i + EXPO_MAX_RECEIPT_IDS),
      fetchFn
    );
    for (const [ticketId, receipt] of Object.entries(receipts)) {
      const deviceId = deviceOf.get(ticketId);
      if (!deviceId) continue;
      checked++;
      if (receipt.status !== "error") continue;
      if (receipt.details?.error === DEVICE_DEAD_ERROR) {
        dead.add(deviceId);
      } else {
        logger.warn(
          {
            userId: payload.userId,
            expoError: receipt.details?.error,
            message: receipt.message,
          },
          "Expo push receipt returned an error"
        );
      }
    }
  }

  const disconnected = await disconnectPhones(payload.userId, [...dead]);
  if (disconnected > 0) {
    logger.info(
      { userId: payload.userId, disconnected },
      "Expo receipts reported DeviceNotRegistered — phones disconnected"
    );
  }
  return { checked, disconnected };
}

/** Turn off every connected phone unused for `PUSH_DEVICE_STOP_DAYS`. */
export async function handlePushDeviceSweep(
  now: Date = new Date()
): Promise<number> {
  const cutoff = new Date(
    now.getTime() - PUSH_DEVICE_STOP_DAYS * 24 * 60 * 60 * 1000
  );
  const swept = await db
    .update(messagingAccounts)
    .set({ status: "disconnected", updatedAt: now })
    .where(
      and(
        eq(messagingAccounts.provider, MESSAGING_ACCOUNT_PROVIDER_EXPO),
        eq(messagingAccounts.status, "connected"),
        drizzleSql`(${messagingAccounts.metadata} ->> 'lastSeenAt')::timestamptz < ${cutoff.toISOString()}::timestamptz`
      )
    )
    .returning({ id: messagingAccounts.id });
  if (swept.length > 0) {
    logger.info(
      { disconnected: swept.length, days: PUSH_DEVICE_STOP_DAYS },
      "Unused phones stopped getting pushes"
    );
  }
  return swept.length;
}
