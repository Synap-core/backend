/**
 * WHAT BECAME OF A SECRET HANDED OVER for one ask — the read the card draws
 * after the answer from: "Used 2 times · last at 14:02 · Take back".
 *
 * The slot's grant is the one the answer door named on the session
 * (`metadata.provideSecretGrantBySlot`, `provide-secret-grant.ts`). Its use
 * count is the grant's own (`vault_grants.use_count`, the number the redeem
 * gate counts); the last read is the newest `read` row the redeem wrote to
 * `secret_audit_log` for that grant (`consumeSecretGrantRead`). A standing
 * grant (a permanent one the agent already held) counts every read made
 * through it, before this hand-over too.
 *
 * Owner-floored twice, like the answer door: the session must be the
 * caller's, and so must the secret (only its owner may take the grant back,
 * `secretsVault.revokeGrant`). Never a value: the rows it reads hold none.
 */

import {
  db,
  and,
  eq,
  isNull,
  desc,
  drizzleSql,
  focusSessions,
} from "@synap/database";
import { secretAuditLog, secrets, vaultGrants } from "@synap/database/schema";
import type { ProvideSecretGrantUses } from "@synap-core/types/ask";
import { agentDisplayName } from "../agent-dispatch/binding-call.js";
import { normalizeExpectedLabel } from "./expected-label.js";
import { PROVIDE_SECRET_SLOT_GRANTS_META_KEY } from "./session-metadata.js";
import type { SlotGrantEntry } from "./provide-secret-grant.js";

/** The door the card's Take back calls, with `{ grantId }`. */
export const PROVIDE_SECRET_TAKE_BACK_DOOR = "secretsVault.revokeGrant";

export interface ProvideSecretUse {
  grantId: string;
  secretId: string;
  /** The secret's own name in the vault (never its value). */
  secretName: string;
  agentUserId: string;
  agentName: string;
  /** `standing`: a permanent grant the agent already held, reused. */
  uses: ProvideSecretGrantUses;
  /** ISO; null = no end of its own (a standing grant). */
  expiresAt: string | null;
  /** ISO, when it was taken back. */
  revokedAt: string | null;
  /** Not taken back, not expired, uses left: the agent can read it now. */
  active: boolean;
  /** Reads made through the grant (the redeem gate's own count). */
  useCount: number;
  /** null = unlimited; 1 for a one-read grant. */
  maxUses: number | null;
  /** ISO of the newest recorded read; null when none was recorded. */
  lastUsedAt: string | null;
  /** How to take it back; null when there is nothing left to take back. */
  takeBack: {
    door: typeof PROVIDE_SECRET_TAKE_BACK_DOOR;
    grantId: string;
  } | null;
}

export type ProvideSecretUseRead =
  | { status: "ok"; use: ProvideSecretUse }
  /** The slot handed over no secret with a read (or before this was kept). */
  | { status: "none" }
  | { status: "not_found" };

function slotEntry(
  metadata: unknown,
  expectedLabel: string
): SlotGrantEntry | null {
  const bag =
    metadata && typeof metadata === "object"
      ? (metadata as Record<string, unknown>)[
          PROVIDE_SECRET_SLOT_GRANTS_META_KEY
        ]
      : null;
  if (!bag || typeof bag !== "object") return null;
  const wanted = normalizeExpectedLabel(expectedLabel);
  for (const [label, entry] of Object.entries(bag as Record<string, unknown>)) {
    if (normalizeExpectedLabel(label) !== wanted) continue;
    const e = entry as Partial<SlotGrantEntry> | null;
    if (
      typeof e?.grantId === "string" &&
      typeof e.secretId === "string" &&
      typeof e.agentUserId === "string" &&
      (e.uses === "once" || e.uses === "session" || e.uses === "standing")
    ) {
      return e as SlotGrantEntry;
    }
  }
  return null;
}

export async function readProvideSecretUse(p: {
  sessionId: string;
  userId: string;
  expectedLabel: string;
}): Promise<ProvideSecretUseRead> {
  const [session] = await db
    .select({ metadata: focusSessions.metadata })
    .from(focusSessions)
    .where(
      and(eq(focusSessions.id, p.sessionId), eq(focusSessions.userId, p.userId))
    )
    .limit(1);
  if (!session) return { status: "not_found" };
  const entry = slotEntry(session.metadata, p.expectedLabel);
  if (!entry) return { status: "none" };

  const [row] = await db
    .select({
      grantId: vaultGrants.id,
      expiresAt: vaultGrants.expiresAt,
      revokedAt: vaultGrants.revokedAt,
      useCount: vaultGrants.useCount,
      maxUses: vaultGrants.maxUses,
      secretName: secrets.name,
    })
    .from(vaultGrants)
    .innerJoin(
      secrets,
      drizzleSql`${secrets.id}::text = ${vaultGrants.grantableId}`
    )
    .where(
      and(
        eq(vaultGrants.id, entry.grantId),
        eq(vaultGrants.grantableType, "secret"),
        eq(vaultGrants.grantableId, entry.secretId),
        eq(secrets.userId, p.userId),
        isNull(secrets.deletedAt)
      )
    )
    .limit(1);
  // The grant is gone or the secret is no longer the caller's: nothing to say.
  if (!row) return { status: "none" };

  const [last] = await db
    .select({ at: secretAuditLog.createdAt })
    .from(secretAuditLog)
    .where(
      and(
        eq(secretAuditLog.secretId, entry.secretId),
        eq(secretAuditLog.action, "read"),
        drizzleSql`${secretAuditLog.metadata} ->> 'grantId' = ${entry.grantId}`
      )
    )
    .orderBy(desc(secretAuditLog.createdAt))
    .limit(1);

  const now = Date.now();
  const active =
    !row.revokedAt &&
    (!row.expiresAt || row.expiresAt.getTime() > now) &&
    (row.maxUses == null || row.useCount < row.maxUses);
  return {
    status: "ok",
    use: {
      grantId: row.grantId,
      secretId: entry.secretId,
      secretName: row.secretName,
      agentUserId: entry.agentUserId,
      agentName: await agentDisplayName(entry.agentUserId),
      uses: entry.uses,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
      active,
      useCount: row.useCount,
      maxUses: row.maxUses,
      lastUsedAt: last ? new Date(last.at).toISOString() : null,
      takeBack: active
        ? { door: PROVIDE_SECRET_TAKE_BACK_DOOR, grantId: row.grantId }
        : null,
    },
  };
}
