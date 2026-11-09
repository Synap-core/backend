/**
 * "Add this device" (founder decision of 9 Nov 2026, session 84c74a23).
 *
 * A person who already holds a proof factor could not bring a NEW device in:
 * pod admin on a phone proves only with a passkey that browser reaches, adding
 * a passkey there needs a `passkey_change` grant only another device could
 * give, and Relay's device-key enrolment needs `device_enroll:<fingerprint>`
 * proved by an existing factor ON the phone. So:
 *
 *  1. the NEW device asks (`requestDeviceLink`) and shows a two-digit number;
 *     every device of the person is told (`security.device_link_requested`);
 *  2. a device the person already uses sees the request (`pendingDeviceLinks`,
 *     three numbers, never which one matches), picks the number the new
 *     device shows and proves presence with an existing factor
 *     (`device_link:<request id>`, `approveDeviceLink`). A wrong number
 *     DECLINES the request: a request an attacker started is never retried;
 *  3. the new device adds its own passkey (Kratos' settings guard, through
 *     `redeemPasskeyChangeGrant`) or device key (`enrollDeviceKey`) with no
 *     further proof: the approval is redeemed ONCE, within
 *     `DEVICE_LINK_TTL_SECONDS`, and only by the session that asked
 *     (`requester_session`, `callerSessionKey`).
 *
 * A person with no factor yet needs none of this (`needed: false`): their
 * first factor rests on the fresh sign-in its door checks.
 */
import crypto from "node:crypto";
import { TRPCError } from "@trpc/server";
import { createLogger } from "@synap-core/core";
import {
  DEVICE_LINK_RATE_WINDOW_SECONDS,
  DEVICE_LINK_REQUESTS_MAX,
  DEVICE_LINK_TTL_SECONDS,
  PRESENCE_DEVICE_LINK_GONE,
  PRESENCE_DEVICE_LINK_MISMATCH,
  PRESENCE_DEVICE_LINK_RATE,
  PRESENCE_DEVICE_LINK_SELF,
  presenceSessionKey,
  type DeviceLinkKind,
  type DeviceLinkReadStatus,
  type DeviceLinkStatus,
  type PresenceProof,
} from "@synap-core/types/presence";
import {
  and,
  count,
  db,
  desc,
  drizzleSql,
  eq,
  gt,
  inArray,
  isNull,
  ne,
  presenceDeviceLinks,
} from "@synap/database";
import { NotificationService } from "../../notifications/NotificationService.js";
import { auditLog } from "../../utils/audit-log.js";
import { assertPresenceForRequest } from "./gate.js";
import { hasProofFactor, PresenceError } from "./proof.js";

const logger = createLogger({ module: "presence-device-link" });

/** The door the approving device's proof is recorded under. */
export const DEVICE_LINK_APPROVE_DOOR = "presence.deviceLink.approve";

/**
 * The key that binds a request, a `passkey_change` grant and their
 * redemption to ONE signed-in session (`presenceSessionKey`, the one
 * derivation Kratos' settings guard uses too): `kratos:<Kratos session id>`
 * for a browser, `device:<person_devices id>` for a Synap app's device token
 * (`appSessionMiddleware` names the row as `session.device.id`). Null for any
 * other caller, or a session that names no id.
 */
export function callerSessionKey(ctx: {
  sessionKind?: string | null;
  session?: unknown;
}): string | null {
  const session = ctx.session as
    { id?: unknown; device?: { id?: unknown } | null } | null | undefined;
  if (ctx.sessionKind === "person_device") {
    const id = session?.device?.id;
    return presenceSessionKey("device", typeof id === "string" ? id : null);
  }
  if (ctx.sessionKind === "kratos" && !session?.device) {
    const id = session?.id;
    return presenceSessionKey("kratos", typeof id === "string" ? id : null);
  }
  return null;
}

/**
 * The number the new device shows and the three the approving device offers
 * (pure: `randomInt(max)` answers 0..max-1; the pod passes crypto's). Three
 * DISTINCT numbers from 10 to 99, drawn without replacement; the first is the
 * match; then shuffled (Fisher-Yates), so its place says nothing.
 */
export function makeDeviceLinkMatch(
  randomInt: (max: number) => number = (max) => crypto.randomInt(max)
): { number: string; choices: string[] } {
  const pool = Array.from({ length: 90 }, (_, i) => i + 10);
  const picked: number[] = [];
  for (let k = 0; k < 3; k++) {
    const [n] = pool.splice(randomInt(pool.length), 1);
    picked.push(n!);
  }
  const choices = [...picked];
  for (let i = choices.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [choices[i], choices[j]] = [choices[j]!, choices[i]!];
  }
  return { number: String(picked[0]), choices: choices.map(String) };
}

/**
 * A request's status as a reader sees it: a pending request past its wait,
 * or an approval nobody redeemed within `DEVICE_LINK_TTL_SECONDS`, reads
 * `expired` (derived, never stored).
 */
export function deviceLinkReadStatus(
  row: {
    status: string;
    expiresAt: Date;
    decidedAt: Date | null;
    redeemedAt: Date | null;
  },
  now: Date = new Date()
): DeviceLinkReadStatus {
  const status = row.status as DeviceLinkStatus;
  if (status === "pending" && row.expiresAt <= now) return "expired";
  if (
    status === "approved" &&
    !row.redeemedAt &&
    (!row.decidedAt ||
      row.decidedAt.getTime() + DEVICE_LINK_TTL_SECONDS * 1000 <= now.getTime())
  ) {
    return "expired";
  }
  return status;
}

function gone(): PresenceError {
  return new PresenceError(
    PRESENCE_DEVICE_LINK_GONE,
    "This request is no longer waiting. Ask again from the new device."
  );
}

function audit(
  userId: string,
  id: string,
  action: "request" | "approve" | "decline" | "redeem",
  data: Record<string, unknown> = {}
): void {
  void auditLog({
    subjectType: "presence_device_link",
    action,
    phase: "completed",
    subjectId: id,
    userId,
    workspaceId: null,
    data,
  });
}

/**
 * Tell every device of the person a new device asks. The request stands
 * either way: a notice that cannot be written is logged as an error.
 */
async function notifyDeviceLinkRequested(
  userId: string,
  id: string,
  label: string
): Promise<void> {
  try {
    await NotificationService.create({
      type: "security.device_link_requested",
      userId,
      sourceType: "system",
      sourceId: id,
      data: { label, id },
    });
  } catch (err) {
    logger.error(
      { err, userId, id },
      "a new device asked to be approved, but the person could not be notified"
    );
  }
}

/**
 * Step 1, on the NEW device. A person with no proof factor gets
 * `needed: false` (their first factor needs no approval). Otherwise their
 * pending request, if any, is replaced by this one, under the per-person
 * factor lock (`factors.ts`), where the rate limit is counted too, so a burst
 * cannot slip past it.
 */
export async function requestDeviceLink(args: {
  userId: string;
  sessionKey: string;
  kind: DeviceLinkKind;
  label: string;
  keyFingerprint?: string | null;
}): Promise<
  | { needed: false }
  | { needed: true; id: string; number: string; expiresAt: Date }
> {
  const keyFingerprint =
    args.kind === "device_key" ? (args.keyFingerprint ?? null) : null;
  if (args.kind === "device_key" && !keyFingerprint) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "A device key request names the key it will add.",
    });
  }
  if (!(await hasProofFactor(args.userId))) return { needed: false };

  const match = makeDeviceLinkMatch();
  const created = await db.transaction(async (tx) => {
    await tx.execute(
      drizzleSql`select pg_advisory_xact_lock(hashtextextended(${`presence-factor:${args.userId}`}, 0))`
    );
    const now = new Date();
    const [recent] = await tx
      .select({ n: count() })
      .from(presenceDeviceLinks)
      .where(
        and(
          eq(presenceDeviceLinks.userId, args.userId),
          gt(
            presenceDeviceLinks.createdAt,
            new Date(now.getTime() - DEVICE_LINK_RATE_WINDOW_SECONDS * 1000)
          )
        )
      );
    if (Number(recent?.n ?? 0) >= DEVICE_LINK_REQUESTS_MAX) return null;
    await tx
      .update(presenceDeviceLinks)
      .set({ status: "replaced", decidedAt: now })
      .where(
        and(
          eq(presenceDeviceLinks.userId, args.userId),
          eq(presenceDeviceLinks.status, "pending")
        )
      );
    const [row] = await tx
      .insert(presenceDeviceLinks)
      .values({
        userId: args.userId,
        kind: args.kind,
        label: args.label,
        requesterSession: args.sessionKey,
        keyFingerprint,
        matchNumber: match.number,
        choices: match.choices,
        status: "pending",
        createdAt: now,
        expiresAt: new Date(now.getTime() + DEVICE_LINK_TTL_SECONDS * 1000),
      })
      .returning({
        id: presenceDeviceLinks.id,
        expiresAt: presenceDeviceLinks.expiresAt,
      });
    return row ?? null;
  });
  if (!created) {
    throw new PresenceError(
      PRESENCE_DEVICE_LINK_RATE,
      "Too many requests to add a device. Wait 15 minutes, then try again."
    );
  }
  audit(args.userId, created.id, "request", {
    kind: args.kind,
    label: args.label,
  });
  await notifyDeviceLinkRequested(args.userId, created.id, args.label);
  return {
    needed: true,
    id: created.id,
    number: match.number,
    expiresAt: created.expiresAt,
  };
}

/**
 * Where a request stands, for the NEW device that asked: only the session
 * that asked may read it (any other reads GONE). `expiresAt` is when the
 * request stops waiting, or, once approved, when the approval can no longer
 * be redeemed.
 */
export async function deviceLinkStatus(args: {
  userId: string;
  sessionKey: string;
  id: string;
}): Promise<{ status: DeviceLinkReadStatus; expiresAt: Date }> {
  const row = await db.query.presenceDeviceLinks.findFirst({
    where: and(
      eq(presenceDeviceLinks.id, args.id),
      eq(presenceDeviceLinks.userId, args.userId)
    ),
  });
  if (!row || row.requesterSession !== args.sessionKey) throw gone();
  const expiresAt =
    row.status === "approved" && row.decidedAt
      ? new Date(row.decidedAt.getTime() + DEVICE_LINK_TTL_SECONDS * 1000)
      : row.expiresAt;
  return { status: deviceLinkReadStatus(row), expiresAt };
}

/**
 * The requests a device the person already uses may approve: theirs, pending,
 * unexpired, asked by ANOTHER session. Never the match number: the person
 * reads it on the new device.
 */
export async function pendingDeviceLinks(args: {
  userId: string;
  sessionKey: string;
}): Promise<
  Array<{
    id: string;
    kind: DeviceLinkKind;
    label: string;
    createdAt: Date;
    expiresAt: Date;
    choices: string[];
  }>
> {
  const rows = await db
    .select({
      id: presenceDeviceLinks.id,
      kind: presenceDeviceLinks.kind,
      label: presenceDeviceLinks.label,
      createdAt: presenceDeviceLinks.createdAt,
      expiresAt: presenceDeviceLinks.expiresAt,
      choices: presenceDeviceLinks.choices,
    })
    .from(presenceDeviceLinks)
    .where(
      and(
        eq(presenceDeviceLinks.userId, args.userId),
        eq(presenceDeviceLinks.status, "pending"),
        gt(presenceDeviceLinks.expiresAt, new Date()),
        ne(presenceDeviceLinks.requesterSession, args.sessionKey)
      )
    )
    .orderBy(desc(presenceDeviceLinks.createdAt));
  return rows.map((r) => ({ ...r, kind: r.kind as DeviceLinkKind }));
}

/**
 * Step 2, on a device the person already uses: the number the new device
 * shows, and a proof from an existing factor for `device_link:<id>`.
 *
 * Order matters: the request must be the person's, pending and unexpired
 * (else GONE), and asked by ANOTHER session (else SELF); a wrong number
 * DECLINES it before any proof is spent (MISMATCH: the person picked a number
 * another device showed, so the request is not theirs to approve); only then
 * is the proof checked (`assertPresenceForRequest`: refused under `enforce`
 * with none; in `report` the missing proof is recorded and the approval
 * stands, as at every other door).
 */
export async function approveDeviceLink(args: {
  userId: string;
  sessionKey: string;
  id: string;
  number: string;
  proof?: PresenceProof | null;
}): Promise<{ approved: true }> {
  const row = await db.query.presenceDeviceLinks.findFirst({
    where: and(
      eq(presenceDeviceLinks.id, args.id),
      eq(presenceDeviceLinks.userId, args.userId)
    ),
  });
  if (!row || deviceLinkReadStatus(row) !== "pending") throw gone();
  if (row.requesterSession === args.sessionKey) {
    throw new PresenceError(
      PRESENCE_DEVICE_LINK_SELF,
      "Approve this from a device you already use, not from the one asking."
    );
  }
  if (args.number !== row.matchNumber) {
    await db
      .update(presenceDeviceLinks)
      .set({ status: "declined", decidedAt: new Date() })
      .where(
        and(
          eq(presenceDeviceLinks.id, row.id),
          eq(presenceDeviceLinks.status, "pending")
        )
      );
    audit(args.userId, row.id, "decline", { why: "number_mismatch" });
    throw new PresenceError(
      PRESENCE_DEVICE_LINK_MISMATCH,
      "That is not the number the new device shows, so the request was declined. If it is your device, ask again from it."
    );
  }
  const verdict = await assertPresenceForRequest({
    userId: args.userId,
    kind: "device_link",
    id: row.id,
    proof: args.proof ?? null,
    door: DEVICE_LINK_APPROVE_DOOR,
  });
  const now = new Date();
  const [approved] = await db
    .update(presenceDeviceLinks)
    .set({
      status: "approved",
      decidedAt: now,
      approvedMethod: verdict?.method ?? null,
    })
    .where(
      and(
        eq(presenceDeviceLinks.id, row.id),
        eq(presenceDeviceLinks.status, "pending"),
        gt(presenceDeviceLinks.expiresAt, now)
      )
    )
    .returning({ id: presenceDeviceLinks.id });
  if (!approved) throw gone();
  audit(args.userId, row.id, "approve", {
    kind: row.kind,
    label: row.label,
    method: verdict?.method ?? null,
  });
  return { approved: true };
}

/**
 * Decline a request, from ANY session of the person: the new device cancels,
 * or another device says "not me". An approval not yet redeemed is declined
 * too (it only takes power away). Idempotent: an already-settled request
 * answers its status unchanged. Another person's request reads GONE.
 */
export async function declineDeviceLink(args: {
  userId: string;
  id: string;
}): Promise<{ status: DeviceLinkReadStatus }> {
  const [declined] = await db
    .update(presenceDeviceLinks)
    .set({ status: "declined", decidedAt: new Date() })
    .where(
      and(
        eq(presenceDeviceLinks.id, args.id),
        eq(presenceDeviceLinks.userId, args.userId),
        inArray(presenceDeviceLinks.status, ["pending", "approved"]),
        isNull(presenceDeviceLinks.redeemedAt)
      )
    )
    .returning({ id: presenceDeviceLinks.id });
  if (declined) {
    audit(args.userId, declined.id, "decline", { why: "declined" });
    return { status: "declined" };
  }
  const row = await db.query.presenceDeviceLinks.findFirst({
    where: and(
      eq(presenceDeviceLinks.id, args.id),
      eq(presenceDeviceLinks.userId, args.userId)
    ),
  });
  if (!row) throw gone();
  return { status: deviceLinkReadStatus(row) };
}

/**
 * Step 3: redeem the approval of THIS session, once. The person's newest
 * `approved` request of `kind` asked by `sessionKey`, approved within
 * `DEVICE_LINK_TTL_SECONDS`, not yet redeemed, and for a device key naming
 * that key's fingerprint; then a conditional update, so a racing second
 * redemption loses. `tx`: an enrolment's transaction, under its lock (a
 * rollback there gives the approval back). False when there is none.
 */
export async function redeemDeviceLink(args: {
  userId: string;
  sessionKey: string | null;
  kind: DeviceLinkKind;
  keyFingerprint?: string | null;
  /** Narrows to one request when the client names it. */
  id?: string | null;
  tx?: Pick<typeof db, "select" | "update">;
}): Promise<boolean> {
  if (!args.sessionKey) return false;
  if (args.kind === "device_key" && !args.keyFingerprint) return false;
  const ex = args.tx ?? db;
  const since = new Date(Date.now() - DEVICE_LINK_TTL_SECONDS * 1000);
  const [link] = await ex
    .select({ id: presenceDeviceLinks.id })
    .from(presenceDeviceLinks)
    .where(
      and(
        eq(presenceDeviceLinks.userId, args.userId),
        eq(presenceDeviceLinks.kind, args.kind),
        eq(presenceDeviceLinks.requesterSession, args.sessionKey),
        eq(presenceDeviceLinks.status, "approved"),
        gt(presenceDeviceLinks.decidedAt, since),
        isNull(presenceDeviceLinks.redeemedAt),
        args.kind === "device_key"
          ? eq(presenceDeviceLinks.keyFingerprint, args.keyFingerprint!)
          : undefined,
        args.id ? eq(presenceDeviceLinks.id, args.id) : undefined
      )
    )
    .orderBy(desc(presenceDeviceLinks.decidedAt))
    .limit(1);
  if (!link) return false;
  const [redeemed] = await ex
    .update(presenceDeviceLinks)
    .set({ status: "redeemed", redeemedAt: new Date() })
    .where(
      and(
        eq(presenceDeviceLinks.id, link.id),
        eq(presenceDeviceLinks.status, "approved"),
        isNull(presenceDeviceLinks.redeemedAt)
      )
    )
    .returning({ id: presenceDeviceLinks.id });
  if (!redeemed) return false;
  audit(args.userId, redeemed.id, "redeem", { kind: args.kind });
  return true;
}
