/**
 * Vault Reference Resolver
 *
 * Resolves `vault://secret-id` references in configuration objects.
 * Used by automation execution engine, MCP server env injection,
 * and webhook output configs.
 *
 * Only server-encrypted secrets (encryptionMode='server') can be resolved.
 * Client-encrypted secrets require user's master password and cannot be
 * resolved server-side — they will be left as-is with a warning.
 *
 * Usage:
 *   const resolved = await resolveVaultReferences(envVars, userId);
 *   // { API_KEY: "sk-live-..." } instead of { API_KEY: "vault://abc-123" }
 */

import { eq, and, sql as drizzleSql } from "drizzle-orm";
import { getDb } from "../client-pg.js";
import { secrets, vaultGrants } from "../schema/index.js";
import type { GrantableType, GrantExecMode } from "../schema/secrets-vault.js";
import {
  decryptServerSide,
  decryptConfig,
  encryptConfig,
  isServerVaultAvailable,
} from "./server-vault.js";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "vault-resolver" });

/** Pattern: vault://secret-uuid or vault://secret-uuid/field-name */
const VAULT_REF_PATTERN = /^vault:\/\/([0-9a-f-]{36})(?:\/(.+))?$/;

/**
 * Check if a string is a vault reference.
 */
export function isVaultReference(value: string): boolean {
  return VAULT_REF_PATTERN.test(value);
}

/**
 * Parse a vault reference string.
 * Returns null if the string is not a valid vault reference.
 */
export function parseVaultReference(
  value: string
): { secretId: string; fieldName?: string } | null {
  const match = value.match(VAULT_REF_PATTERN);
  if (!match) return null;
  return {
    secretId: match[1],
    fieldName: match[2] || undefined,
  };
}

/** Reason an agent/IS redemption was refused at the grant gate. */
export type GrantDenialCode =
  | "no_grant"
  | "grant_expired"
  | "grant_revoked"
  | "grant_exhausted";

/** Thrown by resolveVaultSecret when requireGrant is set and no active grant exists. */
export class VaultGrantError extends Error {
  readonly code: GrantDenialCode;
  constructor(code: GrantDenialCode, message?: string) {
    super(message ?? code);
    this.name = "VaultGrantError";
    this.code = code;
  }
}

/** Thrown by assertGrantScoped when a grant would be a fully-wildcard secret read. */
export class UnscopedVaultGrantError extends Error {
  constructor() {
    super(
      "A vault grant must be scoped to a user and/or a workspace; " +
        "fully-wildcard grants (both grantedTo and workspaceId null) are not allowed."
    );
    this.name = "UnscopedVaultGrantError";
  }
}

/**
 * FIREWALL — issuance-time guard against fully-wildcard vault grants.
 *
 * At redemption (`findRedeemableGrant`), a NULL `granted_to` and a NULL
 * `workspace_id` each act as a WILDCARD: the row matches ANY redeemer principal.
 * A grant with BOTH null is therefore a pod-wide, any-actor secret read — any
 * agent reaching `/vault/redeem` (via `secrets.get(ref)`) could redeem the
 * secret, regardless of owner scope. That is a cross-user secret-read footgun.
 *
 * This is the CANONICAL guard: call it at EVERY site that inserts into
 * `vault_grants`, immediately before the insert, so a future second issuance
 * path can't accidentally mint an unscoped grant. It throws
 * `UnscopedVaultGrantError` when both binding columns are null; a grant scoped to
 * a user, a workspace, or both passes.
 *
 * This is prevention only — it does NOT alter redemption semantics or touch
 * existing rows.
 */
export function assertGrantScoped(grant: {
  grantedTo: string | null | undefined;
  workspaceId: string | null | undefined;
}): void {
  if (!grant.grantedTo && !grant.workspaceId) {
    throw new UnscopedVaultGrantError();
  }
}

/**
 * The principal redeeming a grant. Used to bind redemption to the grantee so a
 * grant issued to one agent/workspace cannot be redeemed by another principal
 * that merely happens to resolve for the same secret owner.
 *
 * - `agentUserId`: the specific agent identity the grant was issued to
 *   (matches vault_grants.granted_to). NULL on a grant means "any agent".
 * - `workspaceId`: the workspace the grant is scoped to
 *   (matches vault_grants.workspace_id). NULL on a grant means "any workspace".
 *
 * A NULL column on the grant is treated as a wildcard (unscoped grant); a
 * non-NULL column MUST equal the redeemer's corresponding value.
 */
export interface GrantRedeemer {
  agentUserId?: string | null;
  workspaceId?: string | null;
}

/**
 * Find the single best ACTIVE grant for a secret that the given redeemer is
 * entitled to redeem, WITHOUT consuming it. (Consumption happens later, only
 * after the secret successfully decrypts — see `incrementGrant` — so a decrypt
 * or missing-secret failure never burns a once-grant.)
 *
 * "Active" = revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
 * AND (max_uses IS NULL OR use_count < max_uses).
 *
 * Grantee binding: a grant is only a candidate when its granted_to / workspace_id
 * either is NULL (unscoped wildcard) or equals the redeemer's value. This makes
 * the granted_to / workspace_id columns enforcement-bearing (see schema comments
 * at secrets-vault.ts ~261-264), not just audit metadata.
 *
 * Ordering prefers the MOST-CONSTRAINED grant so single-use ('once') grants are
 * spent before broader ones:
 *   1. capped grants first              -> (max_uses IS NOT NULL) DESC
 *   2. then soonest expiry              -> expires_at ASC NULLS LAST
 *   3. then fewest remaining uses       -> (max_uses - use_count) ASC NULLS LAST
 *
 * Returns `{ ok: true, grantId, execMode }` with the chosen candidate, or
 * `{ ok: false, code }` with a specific denial reason (scoped to the same
 * redeemer predicate) for diagnostics. `execMode` is the grant ROW's governance
 * axis (auto | propose | dry-run) — the source of truth for how the capability
 * runs (see `findCapabilityGrant` / `gateCapabilityExecution`).
 */
export async function findRedeemableGrant(
  grantableType: GrantableType,
  grantableId: string,
  redeemer: GrantRedeemer
): Promise<
  | { ok: true; grantId: string; execMode: GrantExecMode }
  | { ok: false; code: GrantDenialCode }
> {
  const db = await getDb();
  const agentUserId = redeemer.agentUserId ?? null;
  const workspaceId = redeemer.workspaceId ?? null;

  // Read-only candidate find: most-constrained active grant for this redeemer.
  const candidate = await db.execute(drizzleSql`
    SELECT id, exec_mode FROM vault_grants
    WHERE grantable_type = ${grantableType}
      AND grantable_id = ${grantableId}
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > now())
      AND (max_uses IS NULL OR use_count < max_uses)
      AND (granted_to IS NULL OR granted_to = ${agentUserId})
      AND (workspace_id IS NULL OR workspace_id = ${workspaceId})
    ORDER BY
      (max_uses IS NOT NULL) DESC,
      expires_at ASC NULLS LAST,
      (max_uses - use_count) ASC NULLS LAST
    LIMIT 1
  `);

  // postgres-js: db.execute returns a RowList (array-like) of result rows.
  const chosen = (
    candidate as unknown as Array<{ id: string; exec_mode: GrantExecMode }>
  )[0];
  if (chosen?.id)
    return { ok: true, grantId: chosen.id, execMode: chosen.exec_mode };

  // No redeemable grant — classify why, scoped to the SAME redeemer predicate so
  // we don't misreport based on a grant this principal could never redeem. We
  // pick the newest matching grant and report its specific failure reason.
  const any = await db.query.vaultGrants.findFirst({
    where: and(
      eq(vaultGrants.grantableType, grantableType),
      eq(vaultGrants.grantableId, grantableId),
      drizzleSql`(${vaultGrants.grantedTo} IS NULL OR ${vaultGrants.grantedTo} = ${agentUserId})`,
      drizzleSql`(${vaultGrants.workspaceId} IS NULL OR ${vaultGrants.workspaceId} = ${workspaceId})`
    ),
    columns: {
      revokedAt: true,
      expiresAt: true,
      maxUses: true,
      useCount: true,
    },
    orderBy: (t, { desc }) => [desc(t.createdAt)],
  });
  if (!any) return { ok: false, code: "no_grant" };
  if (any.revokedAt) return { ok: false, code: "grant_revoked" };
  if (any.expiresAt && any.expiresAt.getTime() <= Date.now())
    return { ok: false, code: "grant_expired" };
  if (any.maxUses != null && any.useCount >= any.maxUses)
    return { ok: false, code: "grant_exhausted" };
  return { ok: false, code: "no_grant" };
}

/**
 * Atomically consume ONE use of a specific grant by id, guarded by the active
 * predicate. This is the serialization point that prevents over-redemption of a
 * capped grant under concurrency: the guarded UPDATE only succeeds for the
 * caller that wins the race in the window between candidate-find and increment.
 *
 * Returns true if this call consumed the use; false if the grant was revoked,
 * expired, or already exhausted by a concurrent redeemer (lost race).
 */
export async function incrementGrant(grantId: string): Promise<boolean> {
  const db = await getDb();
  const updated = await db.execute(drizzleSql`
    UPDATE vault_grants
    SET use_count = use_count + 1
    WHERE id = ${grantId}
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > now())
      AND (max_uses IS NULL OR use_count < max_uses)
    RETURNING id
  `);
  return (updated as unknown as Array<{ id: string }>).length > 0;
}

/**
 * NON-CONSUMING capability-grant existence + exec-mode check for non-secret
 * grantables (tool / skill / command). This is the EXISTENCE-and-mode half of
 * the capability gate (the model's namesake): it answers "does an active grant
 * authorize THIS redeemer to run this capability, and in what exec-mode?" WITHOUT
 * burning a use.
 *
 * Use this INSIDE `gateCapabilityExecution` to make the verdict: an approved tool
 * with NO grant for an agent must route to a proposal (never auto-run); a grant's
 * `execMode` is the source of truth for auto/propose/dry-run. The use-count is
 * consumed separately, only when the final verdict is `run` (see
 * `resolveCapabilityGrant` / `incrementGrant` at the dispatch point) — so a run
 * that routes to propose/deny never spends a once-grant.
 *
 * Returns `{ ok: true, grantId, execMode }` (no use consumed) or `{ ok: false,
 * code }`. The redeemer MUST be server-derived — same firewall as redemption.
 */
export async function findCapabilityGrant(
  grantableType: Exclude<GrantableType, "secret">,
  grantableId: string,
  redeemer: GrantRedeemer
): Promise<
  | { ok: true; grantId: string; execMode: GrantExecMode }
  | { ok: false; code: GrantDenialCode }
> {
  return findRedeemableGrant(grantableType, grantableId, redeemer);
}

/**
 * Authorize-only capability-grant gate for non-secret grantables (tool / skill /
 * command). This is the generic counterpart to `resolveVaultSecret`'s grant
 * check: it finds a redeemable grant for the grantable and CONSUMES one use, but
 * has NO decrypt step (there is no secret payload to return — the grant simply
 * authorizes the capability to run).
 *
 * Use this at a capability-execution chokepoint when an agent invokes a tool/
 * skill/command on a delegated path. Owner-invoked runs bypass it (the owner is
 * never gated on a grant for their own capability — same rule as the secret
 * owner-bypass, expressed by NOT calling this).
 *
 * Returns `{ ok: true, grantId, execMode }` on success (one use consumed), or
 * `{ ok: false, code }` with a specific denial reason. The redeemer MUST be
 * server-derived (never request-supplied) — same firewall as secret redemption.
 *
 * Note: like the secret path, consumption is "find then increment". Here the
 * increment runs immediately after find (no intervening decrypt), so the guarded
 * UPDATE is still the serialization point under concurrency.
 */
export async function resolveCapabilityGrant(
  grantableType: Exclude<GrantableType, "secret">,
  grantableId: string,
  redeemer: GrantRedeemer
): Promise<
  | { ok: true; grantId: string; execMode: GrantExecMode }
  | { ok: false; code: GrantDenialCode }
> {
  const grant = await findRedeemableGrant(grantableType, grantableId, redeemer);
  if (!grant.ok) {
    logger.warn(
      { grantableType, grantableId, code: grant.code },
      "Capability grant check failed"
    );
    return grant;
  }
  const consumed = await incrementGrant(grant.grantId);
  if (!consumed) {
    logger.warn(
      { grantableType, grantableId, grantId: grant.grantId },
      "Capability grant exhausted in redemption window"
    );
    return { ok: false, code: "grant_exhausted" };
  }
  logger.info(
    { grantableType, grantableId, grantId: grant.grantId },
    "Capability grant consumed for agent/IS redemption"
  );
  return { ok: true, grantId: grant.grantId, execMode: grant.execMode };
}

/**
 * Resolve a single vault reference to its plaintext value.
 *
 * @param secretId - UUID of the secret
 * @param userId - Owner of the secret (for access control)
 * @param fieldName - Optional JSON field within the decrypted data
 * @param opts.requireGrant - When true, enforce AI access grant semantics: an
 *   ACTIVE vault_grants row redeemable by `opts.redeemer` must exist for the
 *   secret, and one use is consumed ONLY AFTER the secret successfully decrypts
 *   (so a decrypt/missing-secret failure never burns a once-grant). Set ONLY by
 *   agent/IS redemption paths. Throws VaultGrantError if no redeemable grant
 *   exists. Internal/service redemption paths leave this unset.
 * @param opts.redeemer - The principal redeeming the grant (see GrantRedeemer).
 *   Binds redemption to the grantee so a grant issued to one agent/workspace is
 *   not redeemable by another. Required in practice whenever requireGrant is set.
 * @returns Resolved plaintext value, or null if unresolvable
 */
export async function resolveVaultSecret(
  secretId: string,
  userId: string,
  fieldName?: string,
  opts?: { requireGrant?: boolean; redeemer?: GrantRedeemer }
): Promise<string | null> {
  if (!isServerVaultAvailable()) {
    logger.warn("VAULT_SERVER_KEY not configured — cannot resolve vault refs");
    return null;
  }

  // FIX 2: when this is an agent/IS path, find a redeemable grant BEFORE
  // decrypting (throws if none) but DEFER the consuming increment until after a
  // successful decrypt, so a decrypt/missing-secret failure cannot burn a grant.
  let pendingGrantId: string | null = null;
  if (opts?.requireGrant) {
    // A vault secret is just one grantable KIND — gate on grantableType='secret'.
    const grant = await findRedeemableGrant(
      "secret",
      secretId,
      opts.redeemer ?? {}
    );
    if (!grant.ok) {
      logger.warn({ secretId, code: grant.code }, "Vault grant check failed");
      throw new VaultGrantError(grant.code);
    }
    pendingGrantId = grant.grantId;
  }

  const db = await getDb();
  const secret = await db.query.secrets.findFirst({
    where: and(eq(secrets.id, secretId), eq(secrets.userId, userId)),
    columns: {
      id: true,
      encryptedData: true,
      iv: true,
      authTag: true,
      encryptionMode: true,
      deletedAt: true,
    },
  });

  if (!secret) {
    logger.warn({ secretId, userId }, "Vault secret not found");
    return null;
  }

  if (secret.deletedAt) {
    logger.warn({ secretId }, "Vault secret has been deleted");
    return null;
  }

  if (secret.encryptionMode === "client") {
    logger.warn(
      { secretId },
      "Cannot resolve client-encrypted secret server-side — requires user master password"
    );
    return null;
  }

  let plaintext: string;
  try {
    plaintext = decryptServerSide({
      encryptedData: secret.encryptedData!,
      iv: secret.iv!,
      authTag: secret.authTag!,
    });
  } catch (err) {
    logger.error({ err, secretId }, "Failed to decrypt vault secret");
    return null;
  }

  // Decrypt succeeded — NOW consume the grant. The guarded increment is the
  // serialization point that prevents over-redemption of a capped grant under
  // concurrency; if we lost the race in the window, the grant is exhausted.
  if (pendingGrantId) {
    const consumed = await incrementGrant(pendingGrantId);
    if (!consumed) {
      logger.warn(
        { secretId, grantId: pendingGrantId },
        "Vault grant exhausted in redemption window"
      );
      throw new VaultGrantError("grant_exhausted");
    }
    logger.info(
      { secretId, grantId: pendingGrantId },
      "Vault grant consumed for agent/IS redemption"
    );
  }

  // If a field name is specified, parse as JSON and extract
  if (fieldName) {
    try {
      const data = JSON.parse(plaintext) as Record<string, unknown>;
      const value = data[fieldName];
      return value != null ? String(value) : null;
    } catch {
      // Not JSON — return full plaintext if no field specified
      logger.warn(
        { secretId, fieldName },
        "Secret data is not JSON, cannot extract field"
      );
      return null;
    }
  }

  return plaintext;
}

/**
 * Resolve all vault references in a key-value config object.
 * Non-vault values are passed through unchanged.
 * Unresolvable references are replaced with empty string + warning logged.
 *
 * SECURITY: This path is INTENTIONALLY ungated — it does NOT enforce grant
 * semantics (no requireGrant) because it serves the service/automation bootstrap
 * path (e.g. injecting env vars into automation/MCP/webhook execution). It must
 * therefore NEVER be called with agent-controlled `config` or secretIds. Callers
 * that redeem on behalf of an agent must use resolveVaultSecret({ requireGrant,
 * redeemer }) instead so the grant gate runs.
 *
 * @param config - Key-value pairs that may contain vault:// references
 * @param userId - Owner for access control
 * @returns New object with all vault references resolved
 */
export async function resolveVaultReferences(
  config: Record<string, string>,
  userId: string
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};

  for (const [key, value] of Object.entries(config)) {
    const ref = parseVaultReference(value);
    if (ref) {
      const secret = await resolveVaultSecret(
        ref.secretId,
        userId,
        ref.fieldName
      );
      if (secret !== null) {
        resolved[key] = secret;
      } else {
        logger.warn(
          { key, secretId: ref.secretId },
          "Could not resolve vault reference — using empty string"
        );
        resolved[key] = "";
      }
    } else {
      resolved[key] = value;
    }
  }

  return resolved;
}

/**
 * Outcome of a service-credential lookup.
 *
 * `absent` ("you never configured this") is a NORMAL state. The other three are
 * FAULTS — the credential may well exist and be unreadable. Collapsing them into
 * one `null` is what let a broken vault masquerade as an empty one: the caller
 * silently fell through to the env tier and the pod kept working, so the fault
 * stayed invisible until the env tier was removed and every failure alike
 * surfaced as "you never configured Nango".
 */
export type ServiceSecretResult =
  | { ok: true; config: Record<string, string> }
  | {
      ok: false;
      reason: "absent" | "vault-unavailable" | "undecryptable" | "db-error";
      error: string;
    };

/**
 * Resolve a service credential secret by serviceId, distinguishing "not
 * configured" from "configured but unreadable". Never throws.
 *
 * Only works for server-encrypted secrets (encryptionMode='server').
 */
export async function getServiceSecretResult(
  serviceId: string,
  userId: string
): Promise<ServiceSecretResult> {
  if (!isServerVaultAvailable()) {
    logger.warn(
      { serviceId },
      "VAULT_SERVER_KEY not configured — cannot read service secret"
    );
    return {
      ok: false,
      reason: "vault-unavailable",
      error: "VAULT_SERVER_KEY is not configured on this pod",
    };
  }

  let secret;
  try {
    const db = await getDb();
    secret = await db.query.secrets.findFirst({
      where: and(
        eq(secrets.userId, userId),
        eq(secrets.serviceId, serviceId),
        eq(secrets.encryptionMode, "server")
      ),
      columns: {
        id: true,
        encryptedData: true,
        iv: true,
        authTag: true,
        deletedAt: true,
      },
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ serviceId, error }, "Vault read failed — database error");
    return { ok: false, reason: "db-error", error };
  }

  if (!secret || secret.deletedAt) {
    return {
      ok: false,
      reason: "absent",
      error: `No '${serviceId}' credential stored for this user`,
    };
  }

  // `decryptConfig` swallows its own failure and returns null (it does not
  // throw) — so a null here means the row EXISTS and could not be read, almost
  // always a rotated or mismatched VAULT_SERVER_KEY. Loud, because "reconnect
  // it" is the wrong advice: reconnecting writes a second unreadable row.
  const config = decryptConfig({
    encryptedData: secret.encryptedData!,
    iv: secret.iv!,
    authTag: secret.authTag!,
  });
  if (!config) {
    const error =
      "decryption returned null — VAULT_SERVER_KEY may have rotated or the blob is corrupt";
    logger.error(
      { serviceId, secretId: secret.id },
      "Vault secret exists but could not be decrypted — VAULT_SERVER_KEY may have rotated"
    );
    return { ok: false, reason: "undecryptable", error };
  }
  return { ok: true, config };
}

/**
 * Compat wrapper over {@link getServiceSecretResult} — returns the config, or
 * null for EVERY failure.
 *
 * Prefer `getServiceSecretResult` in new code. This exists so the callers that
 * genuinely only branch on "do I have a config?" stay unchanged; it deliberately
 * keeps the lossy shape rather than leaving those call sites to hand-roll it.
 */
export async function getServiceSecret(
  serviceId: string,
  userId: string
): Promise<Record<string, string> | null> {
  const result = await getServiceSecretResult(serviceId, userId);
  return result.ok ? result.config : null;
}

/**
 * Store or update a service credential in the vault (server-encrypted).
 * Creates if not exists, updates if serviceId already exists for this user.
 */
export async function upsertServiceSecret(
  serviceId: string,
  userId: string,
  name: string,
  config: Record<string, string>
): Promise<string> {
  const blob = encryptConfig(config);
  const db = await getDb();

  const existing = await db.query.secrets.findFirst({
    where: and(eq(secrets.userId, userId), eq(secrets.serviceId, serviceId)),
    columns: { id: true },
  });

  if (existing) {
    await db
      .update(secrets)
      .set({
        encryptedData: blob.encryptedData,
        iv: blob.iv,
        authTag: blob.authTag,
        updatedAt: new Date(),
      })
      .where(eq(secrets.id, existing.id));
    return existing.id;
  }

  const [row] = await db
    .insert(secrets)
    .values({
      userId,
      name,
      type: "api_key",
      serviceId,
      encryptionMode: "server",
      encryptedData: blob.encryptedData,
      iv: blob.iv,
      authTag: blob.authTag,
    })
    .returning({ id: secrets.id });
  return row.id;
}
