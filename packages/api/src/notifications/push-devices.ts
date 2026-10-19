/**
 * A person's phones — the `expo` rows of `messaging_accounts` — and the four
 * things that change or read them: register (the phone itself, on every
 * launch), unregister (the phone signing out), revoke (the person, from any
 * other device) and list.
 *
 * THREE WAYS TO BE OFF, kept apart because they come back differently
 * (`PUSH_DEVICE_STATUSES`, `@synap-core/types/push`):
 *   `disconnected` — sign-out, a dead token, or unused for 90 days. The
 *                    phone's next registration turns it back on.
 *   `revoked`      — turned off from elsewhere. A plain registration leaves it
 *                    off and answers `revoked`, so the phone can say so; only
 *                    `reenable` — sent when the person turns push on FROM
 *                    THAT PHONE — turns it back on. The token is the proof it
 *                    is that phone: it is never returned by any read.
 *
 * Every statement pins `user_id`: a person reaches only their own phones, and
 * a pod admin has no door onto anyone else's (a phone is a personal delivery
 * address). Someone else's row and a missing row are the same "not found".
 *
 * LAST SEEN. `metadata.lastSeenAt` is written only by an app that registers on
 * EVERY launch (`everyLaunch`). An app that skips unchanged tokens registers
 * once per token, so its last registration says nothing about use — such a
 * row has no last-seen time and is never stopped for being unused.
 */

import {
  db,
  and,
  eq,
  ne,
  desc,
  drizzleSql,
  messagingAccounts,
  MESSAGING_ACCOUNT_PROVIDER_EXPO,
} from "@synap/database";
import { emitSideEffects } from "@synap/events";
import { createLogger } from "@synap-core/core";
import type { PushDeviceRow } from "@synap-core/types/push";

const logger = createLogger({ module: "push-devices" });

export interface RegisterPushDeviceInput {
  userId: string;
  token: string;
  platform: "ios" | "android";
  deviceName?: string;
  appVersion?: string;
  /** The person turned push on from this phone: lifts a `revoked`. */
  reenable?: boolean;
  /** The app registers on every launch, so this registration is a sighting. */
  everyLaunch?: boolean;
}

export type RegisteredDeviceStatus = "connected" | "revoked";

const ownExpo = (userId: string) =>
  and(
    eq(messagingAccounts.userId, userId),
    eq(messagingAccounts.provider, MESSAGING_ACCOUNT_PROVIDER_EXPO)
  );

/** Activity for a phone that was added or changed state — never a refresh. */
function emitDeviceEvent(
  userId: string,
  id: string,
  action: "created" | "updated" | "disconnected",
  status: string
): void {
  void emitSideEffects({
    subjectType: "messaging_account",
    action,
    subjectId: id,
    userId,
    workspaceId: null,
    data: { provider: MESSAGING_ACCOUNT_PROVIDER_EXPO, status },
  }).catch((err) => logger.warn({ err }, "emitSideEffects failed (non-fatal)"));
}

/**
 * Register or refresh this phone. One atomic upsert on the
 * (user, provider, token) index: a `revoked` row stays revoked (and keeps
 * `revokedAt`) unless `reenable`; any other row comes back `connected`.
 */
export async function registerPushDevice(
  input: RegisterPushDeviceInput,
  now: Date = new Date()
): Promise<{ id: string; status: RegisteredDeviceStatus }> {
  const t = messagingAccounts;
  const before = await db.query.messagingAccounts.findFirst({
    where: and(ownExpo(input.userId), eq(t.externalId, input.token)),
    columns: { status: true },
  });

  const metadata: Record<string, unknown> = {
    platform: input.platform,
    ...(input.deviceName ? { deviceName: input.deviceName } : {}),
    ...(input.appVersion ? { appVersion: input.appVersion } : {}),
    ...(input.everyLaunch ? { lastSeenAt: now.toISOString() } : {}),
  };

  const [row] = await db
    .insert(t)
    .values({
      userId: input.userId,
      provider: MESSAGING_ACCOUNT_PROVIDER_EXPO,
      externalId: input.token,
      displayName: input.deviceName ?? `${input.platform} device`,
      status: "connected",
      metadata,
    })
    .onConflictDoUpdate({
      target: [t.userId, t.provider, t.externalId],
      set: input.reenable
        ? {
            displayName: drizzleSql`excluded.display_name`,
            status: "connected",
            metadata: drizzleSql`excluded.metadata`,
            updatedAt: now,
          }
        : {
            displayName: drizzleSql`excluded.display_name`,
            status: drizzleSql`case when ${t.status} = 'revoked' then 'revoked' else 'connected' end`,
            metadata: drizzleSql`jsonb_strip_nulls(jsonb_build_object('revokedAt', ${t.metadata} -> 'revokedAt')) || excluded.metadata`,
            updatedAt: now,
          },
    })
    .returning({ id: t.id, status: t.status });

  const status: RegisteredDeviceStatus =
    row!.status === "revoked" ? "revoked" : "connected";
  if (!before) emitDeviceEvent(input.userId, row!.id, "created", status);
  else if (before.status !== status)
    emitDeviceEvent(input.userId, row!.id, "updated", status);
  return { id: row!.id, status };
}

/**
 * The phone signing out: `connected` → `disconnected`. A `revoked` row stays
 * revoked, so signing out and back in does not undo a turn-off from
 * elsewhere. Answers whether the phone is now off (false = no such row).
 */
export async function unregisterPushDevice(input: {
  userId: string;
  token: string;
}): Promise<boolean> {
  const t = messagingAccounts;
  const mine = and(ownExpo(input.userId), eq(t.externalId, input.token));
  const [row] = await db
    .update(t)
    .set({ status: "disconnected", updatedAt: new Date() })
    .where(and(mine, ne(t.status, "revoked")))
    .returning({ id: t.id });
  if (row) {
    emitDeviceEvent(input.userId, row.id, "disconnected", "disconnected");
    return true;
  }
  const revoked = await db.query.messagingAccounts.findFirst({
    where: mine,
    columns: { id: true },
  });
  return !!revoked;
}

/**
 * Turn a phone off from another device. `null` = no such phone of THIS
 * person (missing and someone else's answer the same). Idempotent: an
 * already-revoked phone keeps its first `revokedAt`.
 */
export async function revokePushDevice(
  input: { userId: string; id: string },
  now: Date = new Date()
): Promise<{ id: string; status: "revoked" } | null> {
  const t = messagingAccounts;
  const mine = and(ownExpo(input.userId), eq(t.id, input.id));
  const [row] = await db
    .update(t)
    .set({
      status: "revoked",
      metadata: drizzleSql`${t.metadata} || jsonb_build_object('revokedAt', ${now.toISOString()}::text)`,
      updatedAt: now,
    })
    .where(and(mine, ne(t.status, "revoked")))
    .returning({ id: t.id });
  if (row) {
    emitDeviceEvent(input.userId, row.id, "disconnected", "revoked");
    return { id: row.id, status: "revoked" };
  }
  const already = await db.query.messagingAccounts.findFirst({
    where: mine,
    columns: { id: true },
  });
  return already ? { id: already.id, status: "revoked" } : null;
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim().length > 0 ? v : null;

/**
 * The person's phones, newest activity first. The token is never returned (a
 * delivery credential); a phone that passes its own `token` learns which row
 * is itself (`isThisDevice`).
 */
export async function listPushDevices(input: {
  userId: string;
  token?: string;
}): Promise<PushDeviceRow[]> {
  const rows = await db.query.messagingAccounts.findMany({
    where: ownExpo(input.userId),
    columns: {
      id: true,
      externalId: true,
      status: true,
      metadata: true,
      createdAt: true,
    },
    orderBy: [desc(messagingAccounts.updatedAt)],
  });
  return rows.map((r) => {
    const m = r.metadata ?? {};
    return {
      id: r.id,
      name: str(m.deviceName),
      platform: str(m.platform),
      appVersion: str(m.appVersion),
      status: r.status,
      lastSeenAt: str(m.lastSeenAt),
      createdAt: r.createdAt,
      revokedAt: str(m.revokedAt),
      isThisDevice: !!input.token && r.externalId === input.token,
    };
  });
}
