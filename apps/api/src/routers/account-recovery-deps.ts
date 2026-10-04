/**
 * Real dependencies for `createAccountRecoveryRouter` and the Kratos
 * Cloud-trust hooks. Every decision lives in `account-recovery.ts` /
 * `../account-recovery/policy.ts`; this file only talks to Postgres and the
 * Kratos ADMIN API (loopback / compose network only — never routed publicly).
 *
 * Nothing here logs a request or response body: the Kratos recovery answer
 * carries a one-time code.
 */

import { TRPCError } from "@trpc/server";
import { authMiddleware } from "@synap/auth";
import { assertPodAdmin, refuseGuestSession } from "@synap/api";
import {
  AccountRecoveryCodeRepository,
  EventRepository,
  drizzleSql,
  eq,
  getDb,
  sql,
} from "@synap/database";
import { podSettings, users } from "@synap/database/schema";
import { createUnifiedEvent } from "@synap/jobs";
import { createLogger } from "@synap-core/core";
import {
  DEFAULT_CLOUD_TRUST,
  isCloudTrustMode,
  type CloudTrustMode,
} from "@synap-core/types/account-recovery";
import { courierStatus } from "../courier-status.js";
import { configuredPodAdminBase } from "../pod-admin-config.js";
import { identityHasPodHeldCredential } from "../account-recovery/policy.js";
import { readFederationOidcIssuer } from "./federation.js";
import {
  KRATOS_RECOVERY_EXPIRES_IN,
  type AccountRecoveryDeps,
  type KratosRecoveryLink,
  type PodAccount,
} from "./account-recovery.js";

const logger = createLogger({ module: "account-recovery" });

function kratosAdminUrl(): string {
  return (process.env.KRATOS_ADMIN_URL || "http://localhost:4434").replace(
    /\/$/,
    ""
  );
}

const KRATOS_TIMEOUT_MS = 8_000;

async function accountWhere(
  where: ReturnType<typeof drizzleSql>
): Promise<PodAccount | null> {
  const db = await getDb();
  const [row] = await db
    .select({ id: users.id, kratosIdentityId: users.kratosIdentityId })
    .from(users)
    .where(where)
    .limit(1);
  if (!row) return null;
  return { userId: row.id, identityId: row.kratosIdentityId || row.id };
}

/** `pod_settings.settings.accountRecovery` — the owner's Cloud trust choice. */
export async function readCloudTrust(): Promise<CloudTrustMode> {
  const db = await getDb();
  const [row] = await db
    .select({ settings: podSettings.settings })
    .from(podSettings)
    .orderBy(podSettings.createdAt)
    .limit(1);
  const value = (
    row?.settings as { accountRecovery?: { cloudTrust?: unknown } } | undefined
  )?.accountRecovery?.cloudTrust;
  return isCloudTrustMode(value) ? value : DEFAULT_CLOUD_TRUST;
}

async function writeCloudTrust(mode: CloudTrustMode): Promise<void> {
  const db = await getDb();
  const value = { cloudTrust: mode, updatedAt: new Date().toISOString() };
  const [existing] = await db
    .select({ id: podSettings.id })
    .from(podSettings)
    .orderBy(podSettings.createdAt)
    .limit(1);
  if (existing) {
    await db
      .update(podSettings)
      .set({
        settings: drizzleSql`jsonb_set(
          coalesce(${podSettings.settings}, '{}'::jsonb),
          '{accountRecovery}',
          ${JSON.stringify(value)}::jsonb,
          true
        )`,
        updatedAt: new Date(),
      })
      .where(eq(podSettings.id, existing.id));
  } else {
    await db.insert(podSettings).values({ settings: { accountRecovery: value } });
  }
}

/** Kratos admin identity read → does it hold a password / passkey? Throws on a failed read. */
export async function kratosIdentityHasPodHeldCredential(
  identityId: string
): Promise<boolean> {
  const res = await fetch(
    `${kratosAdminUrl()}/admin/identities/${encodeURIComponent(identityId)}`,
    { signal: AbortSignal.timeout(KRATOS_TIMEOUT_MS) }
  );
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`Kratos identity read failed: ${res.status}`);
  return identityHasPodHeldCredential(await res.json());
}

async function createKratosRecovery(
  identityId: string
): Promise<KratosRecoveryLink> {
  const res = await fetch(`${kratosAdminUrl()}/admin/recovery/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      identity_id: identityId,
      expires_in: KRATOS_RECOVERY_EXPIRES_IN,
      flow_type: "browser",
    }),
    signal: AbortSignal.timeout(KRATOS_TIMEOUT_MS),
  });
  // Status only — the body of a success carries the one-time code.
  if (res.status !== 201) {
    throw new Error(`Kratos recovery code failed: ${res.status}`);
  }
  const body = (await res.json()) as {
    recovery_link?: unknown;
    recovery_code?: unknown;
    expires_at?: unknown;
  };
  if (
    typeof body.recovery_link !== "string" ||
    typeof body.recovery_code !== "string"
  ) {
    throw new Error("Kratos recovery code answer is malformed");
  }
  return {
    recoveryLink: body.recovery_link,
    recoveryCode: body.recovery_code,
    expiresAt:
      typeof body.expires_at === "string"
        ? body.expires_at
        : new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  };
}

async function revokeIdentitySessions(identityId: string): Promise<void> {
  const res = await fetch(
    `${kratosAdminUrl()}/admin/identities/${encodeURIComponent(identityId)}/sessions`,
    { method: "DELETE", signal: AbortSignal.timeout(KRATOS_TIMEOUT_MS) }
  );
  if (res.status !== 204) {
    throw new Error(`Kratos session revoke failed: ${res.status}`);
  }
}

async function isPodAdmin(userId: string): Promise<boolean> {
  try {
    await assertPodAdmin(userId);
    return true;
  } catch (err) {
    if (err instanceof TRPCError && err.code === "FORBIDDEN") return false;
    throw err;
  }
}

/** `users.update.completed` with `data.change` — visible in pod-admin Audit. */
async function audit(entry: {
  userId: string;
  change: string;
  data?: Record<string, unknown>;
}): Promise<void> {
  try {
    const event = createUnifiedEvent({
      subjectType: "users",
      action: "update",
      phase: "completed",
      subjectId: entry.userId,
      data: { change: entry.change, ...entry.data, userId: entry.userId },
      userId: entry.userId,
      source: "api",
    });
    await new EventRepository(sql).append({
      id: event.id,
      version: event.version,
      type: event.type,
      subjectId: event.subjectId,
      subjectType: event.subjectType,
      data: event.data as Record<string, unknown>,
      metadata: event.metadata as Record<string, unknown>,
      userId: event.userId,
      source: "api",
      timestamp: event.timestamp,
    });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), change: entry.change },
      "[account-recovery] audit append failed"
    );
  }
}

const codes = new AccountRecoveryCodeRepository();

export const accountRecoveryDeps: AccountRecoveryDeps = {
  now: () => new Date(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  logger,
  // Session doors serve pod participants; a guest has no account to recover here.
  authenticate: [authMiddleware, refuseGuestSession],
  findAccountByEmail: (email) =>
    accountWhere(
      drizzleSql`lower(${users.email}) = ${email} and ${users.userType} = 'human'`
    ),
  findAccountByIdentity: (identityId) =>
    accountWhere(
      drizzleSql`(${users.id} = ${identityId} or ${users.kratosIdentityId} = ${identityId}) and ${users.userType} = 'human'`
    ),
  codes: {
    listUnused: (userId) => codes.listUnused(userId),
    claim: (id, at) => codes.claim(id, at),
    release: (id, at) => codes.release(id, at),
    replaceBatch: (userId, batchId, hashes, at) =>
      codes.replaceBatch(userId, batchId, hashes, at),
    summary: (userId) => codes.summary(userId),
    anyUnused: () => codes.anyUnused(),
  },
  createKratosRecovery,
  revokeIdentitySessions,
  identityHasPodHeldCredential: kratosIdentityHasPodHeldCredential,
  readCloudTrust,
  writeCloudTrust,
  cloudSignInAvailable: async () => (await readFederationOidcIssuer()) !== null,
  courierStatus: () => courierStatus().status,
  podAdminConfig: () => configuredPodAdminBase(),
  isPodAdmin,
  audit,
};

/** Account `users` row by Kratos identity — shared with the Cloud-trust hooks. */
export const findAccountByIdentity = accountRecoveryDeps.findAccountByIdentity;
export const recoveryCodeSummary = (userId: string) => codes.summary(userId);
