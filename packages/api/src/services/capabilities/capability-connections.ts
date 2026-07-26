/**
 * Capability-connection service — the SINGLE source of truth for CRUD over a
 * capability's connections (Wave 4).
 *
 * A "connection" is a `secrets` row (the vault IS the connection registry, plan
 * §3.2) that carries `capability_id`. It optionally binds to a context object
 * (`context_type`/`context_id`), is one of possibly-many under a capability with
 * exactly one `is_default`, and — for a Nango 1-of-N account — an `account_hint`.
 * `secrets.name` is the human label.
 *
 * This module NEVER hand-rolls crypto and NEVER returns a decrypted value: it
 * reuses the SAME `encryptServerSide` path the `POST /vault/secrets` route and the
 * capability-template applier (`create-from-definition.ts:createVaultSecret`) use.
 * Every function is OWNER-GATED — mirrors `tools.ts:bindCredential`
 * (`secret.userId === actorUserId`, with a pod-admin fallback).
 */

import { encryptServerSide, db, and, eq, isNull, asc } from "@synap/database";
import { secrets, secretAuditLog, secretUsages } from "@synap/database/schema";

import { requirePodAdmin, isPodAdmin } from "../../utils/workspace-role.js";
import { syncNangoConnectionsToRegistry } from "./capability-nango-sync.js";

// ── Public shapes ─────────────────────────────────────────────────────────────

/** A connection as surfaced to callers — NEVER carries the secret value. */
export interface CapabilityConnectionView {
  id: string;
  /** Human label (`secrets.name`). */
  label: string;
  contextType: string | null;
  contextId: string | null;
  isDefault: boolean;
  accountHint: string | null;
  /** 'nango' when the credential delegates to Nango, else 'vault' (direct key). */
  kind: "nango" | "vault";
  /**
   * Pod-wide (0211): a shared vault key any member may USE for this capability
   * without a per-user grant. VAULT ONLY; write-gated to pod-admins.
   */
  isPodWide: boolean;
}

/**
 * kind heuristic — determined WITHOUT decrypting the value (a list must stay
 * cheap and must never touch plaintext). A Nango connection is the one that
 * delegates its credential to a provider: it carries a `provider_integration_id`
 * FK or an `account_hint` (the 1-of-N account selector). Everything else is a
 * direct vault key.
 */
function connectionKind(row: {
  providerIntegrationId: string | null;
  accountHint: string | null;
}): "nango" | "vault" {
  return row.providerIntegrationId != null || row.accountHint != null
    ? "nango"
    : "vault";
}

// ── Ownership gate (mirrors tools.ts bindCredential) ──────────────────────────

/**
 * Load the connection (a `secrets` row) for `connectionId` scoped to
 * `capabilityId` (so a caller can never address a secret that is not this
 * capability's connection), then OWNER-gate it: `secret.userId === actorUserId`,
 * else fall back to pod-admin. Throws (Error) when not found; `requirePodAdmin`
 * throws a TRPCError when the actor is neither owner nor admin.
 */
async function loadOwnedConnection(
  capabilityId: string,
  connectionId: string,
  actorUserId: string
) {
  const [row] = await db
    .select()
    .from(secrets)
    .where(
      and(
        eq(secrets.id, connectionId),
        eq(secrets.capabilityId, capabilityId),
        isNull(secrets.deletedAt)
      )
    )
    .limit(1);
  if (!row) {
    throw new Error("Connection not found for this capability.");
  }
  // Owner floor, PLUS a pod-wide floor: a pod-wide connection (shared vault key)
  // is a pod-level object even though it is owned by the admin who created it, so
  // mutating it always requires pod-admin — never just the owning actor.
  if (row.isPodWide || row.userId !== actorUserId) {
    await requirePodAdmin(actorUserId);
  }
  return row;
}

/**
 * Unset the current default connection(s) for a capability WITHIN a tier
 * (respects the partial unique index `idx_secrets_capability_default`, which is
 * keyed on (capability_id, is_pod_wide) so a per-user default and a pod-wide
 * default coexist). Scoping to the SAME tier means promoting a pod-wide default
 * never clears a member's per-user default and vice-versa. Excludes `exceptId`
 * so a set-then-unset never clears the row we are promoting.
 */
async function unsetCapabilityDefault(
  capabilityId: string,
  opts: { isPodWide: boolean; exceptId?: string }
): Promise<void> {
  const { isPodWide, exceptId } = opts;
  const preds = [
    eq(secrets.capabilityId, capabilityId),
    eq(secrets.isDefault, true),
    eq(secrets.isPodWide, isPodWide),
    isNull(secrets.deletedAt),
  ];
  const rows = await db
    .select({ id: secrets.id })
    .from(secrets)
    .where(and(...preds));
  for (const r of rows) {
    if (exceptId && r.id === exceptId) continue;
    await db
      .update(secrets)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(eq(secrets.id, r.id));
  }
}

// ── list ──────────────────────────────────────────────────────────────────────

/**
 * List a capability's connections (metadata only, never values). Owner-scoped:
 * an actor sees their own connections; if the capability has connections owned by
 * ANOTHER user, the actor must be a pod-admin to see them (else `requirePodAdmin`
 * throws) — mirrors the bindCredential ownership floor.
 */
export async function listConnections(
  capabilityId: string,
  actorUserId: string
): Promise<CapabilityConnectionView[]> {
  // Reconcile live Nango OAuth connections into the registry first (backfill +
  // refresh) so a Nango-backed capability's accounts appear here and become
  // pickable. Best-effort: a Nango outage must never break the list.
  await syncNangoConnectionsToRegistry(capabilityId, actorUserId).catch(
    () => {}
  );

  const rows = await db
    .select()
    .from(secrets)
    .where(
      and(eq(secrets.capabilityId, capabilityId), isNull(secrets.deletedAt))
    )
    .orderBy(asc(secrets.createdAt));

  // A member always sees their OWN connections + any POD-WIDE connection (a shared
  // key they can legitimately use). Foreign PER-USER connections (another member's
  // private key) are only revealed to a pod-admin — but their mere existence must
  // NOT error a normal member (that was the old all-or-nothing `requirePodAdmin`
  // throw). So compute admin-ness non-throwingly and filter rather than throw.
  const hasForeignPerUser = rows.some(
    (r) => r.userId !== actorUserId && !r.isPodWide
  );
  const canSeeForeign = hasForeignPerUser
    ? await isPodAdmin(actorUserId)
    : true;
  const visible = canSeeForeign
    ? rows
    : rows.filter((r) => r.userId === actorUserId || r.isPodWide);

  return visible.map((r) => ({
    id: r.id,
    label: r.name,
    contextType: r.contextType ?? null,
    contextId: r.contextId ?? null,
    isDefault: r.isDefault,
    accountHint: r.accountHint ?? null,
    kind: connectionKind(r),
    isPodWide: r.isPodWide,
  }));
}

// ── add ────────────────────────────────────────────────────────────────────────

export interface AddConnectionInput {
  capabilityId: string;
  actorUserId: string;
  label: string;
  /** Optional secret value — a Nango connection has none of its own. */
  value?: string;
  contextType?: string | null;
  contextId?: string | null;
  accountHint?: string | null;
  isDefault?: boolean;
  /**
   * Mark this a POD-WIDE connection (shared vault key). Pod-admin only (enforced
   * here). VAULT ONLY — rejected for a Nango connection (one carrying an
   * accountHint), which would be an unsupported pod-wide OAuth.
   */
  isPodWide?: boolean;
}

/**
 * Create a server-encrypted connection stamped with `capability_id` + fields.
 * When `isDefault` is set OR this is the capability's FIRST connection IN ITS
 * TIER, any existing default of that tier is unset first and this one becomes
 * default (respects `idx_secrets_capability_default`, keyed on
 * (capability_id, is_pod_wide)). The secret is always owned by the actor.
 */
export async function addConnection(
  input: AddConnectionInput
): Promise<CapabilityConnectionView> {
  const {
    capabilityId,
    actorUserId,
    label,
    value,
    contextType,
    contextId,
    accountHint,
  } = input;
  const isPodWide = input.isPodWide === true;

  // Write RBAC: creating a pod-wide (shared) connection is a pod-level privileged
  // action. VAULT ONLY: reject a pod-wide Nango connection (accountHint present) —
  // a pod-wide OAuth would need run-as-owner proxying and is out of scope.
  if (isPodWide) {
    if (accountHint != null) {
      throw new Error(
        "A pod-wide connection must be a vault key — Nango/account connections cannot be pod-wide."
      );
    }
    await requirePodAdmin(actorUserId);
  }

  // First-connection auto-default (per TIER): if the capability has no connection
  // yet in this tier, this one must be its default (the resolver's is_default
  // fallback needs a target). Tier-scoped so the first pod-wide connection becomes
  // the pod-wide default without stealing a member's per-user default slot.
  const [existingAny] = await db
    .select({ id: secrets.id })
    .from(secrets)
    .where(
      and(
        eq(secrets.capabilityId, capabilityId),
        eq(secrets.isPodWide, isPodWide),
        isNull(secrets.deletedAt)
      )
    )
    .limit(1);
  const isFirst = !existingAny;
  const makeDefault = input.isDefault === true || isFirst;

  if (makeDefault) await unsetCapabilityDefault(capabilityId, { isPodWide });

  // Reuse the SAME server-side encryption the vault route + template applier use.
  // A connection with no value of its own (Nango) still stores an (empty) blob so
  // the row shape is uniform — the credential lives on the linked provider.
  const blob = encryptServerSide(value ?? "");

  const [secret] = await db
    .insert(secrets)
    .values({
      userId: actorUserId,
      workspaceId: null,
      name: label,
      type: "api_key",
      capabilityId,
      accountHint: accountHint ?? null,
      contextType: contextType ?? null,
      contextId: contextId ?? null,
      isDefault: makeDefault,
      isPodWide,
      encryptedData: blob.encryptedData,
      iv: blob.iv,
      authTag: blob.authTag,
      encryptionVersion: 1,
      encryptionMode: "server",
    })
    .returning();

  await db.insert(secretAuditLog).values({
    secretId: secret.id,
    userId: actorUserId,
    action: "created",
    metadata: { via: "capability-connections", capabilityId },
  });

  // Record the "used by" join so the vault's Connections face can show this
  // secret is consumed by the capability. context_id uses the '' sentinel when
  // none so context-less rows dedupe under the unique index (NULLs are distinct
  // in Postgres). Idempotent: refresh the label/context on conflict.
  // BEST-EFFORT: the "used by" join is presentational — a hiccup writing it must
  // never fail the connection creation (the secret + audit are already committed).
  try {
    await db
      .insert(secretUsages)
      .values({
        secretId: secret.id,
        consumerType: "capability",
        consumerId: capabilityId,
        consumerLabel: label,
        workspaceId: null,
        contextType: secret.contextType ?? null,
        contextId: secret.contextId ?? "",
      })
      .onConflictDoUpdate({
        target: [
          secretUsages.secretId,
          secretUsages.consumerType,
          secretUsages.consumerId,
          secretUsages.contextId,
        ],
        set: {
          consumerLabel: label,
          contextType: secret.contextType ?? null,
          workspaceId: null,
        },
      });
  } catch (usageErr) {
    console.error(
      "[capability-connections] secret_usages upsert failed (non-fatal):",
      usageErr
    );
  }

  return {
    id: secret.id,
    label: secret.name,
    contextType: secret.contextType ?? null,
    contextId: secret.contextId ?? null,
    isDefault: secret.isDefault,
    accountHint: secret.accountHint ?? null,
    kind: connectionKind(secret),
    isPodWide: secret.isPodWide,
  };
}

// ── update ─────────────────────────────────────────────────────────────────────

export interface UpdateConnectionInput {
  capabilityId: string;
  connectionId: string;
  actorUserId: string;
  label?: string;
  contextType?: string | null;
  contextId?: string | null;
  accountHint?: string | null;
  isDefault?: boolean;
  /** Promote/demote pod-wide (shared vault key). Pod-admin only. VAULT ONLY. */
  isPodWide?: boolean;
  /** New secret value → re-encrypt (credential rotation). */
  value?: string;
}

/**
 * Update a connection's fields; rotate (re-encrypt) when `value` is supplied;
 * enforce a single default PER TIER (unset the target tier's other default when
 * this row is/becomes default).
 */
export async function updateConnection(
  input: UpdateConnectionInput
): Promise<CapabilityConnectionView> {
  const { capabilityId, connectionId, actorUserId } = input;
  // loadOwnedConnection already requires pod-admin when the EXISTING row is
  // pod-wide (or foreign).
  const existing = await loadOwnedConnection(
    capabilityId,
    connectionId,
    actorUserId
  );

  // Promoting a per-user connection TO pod-wide is itself a pod-level privileged
  // action (loadOwnedConnection only gated the existing state). VAULT ONLY: a
  // Nango connection (accountHint present, existing or being set) can't be pod-wide.
  if (input.isPodWide === true && !existing.isPodWide) {
    const effectiveAccountHint =
      input.accountHint !== undefined
        ? input.accountHint
        : existing.accountHint;
    // Gate on the SAME discriminator the runtime resolver uses
    // (`connectionKind` = providerIntegrationId OR accountHint), not accountHint
    // alone. A row carrying `providerIntegrationId` with a null accountHint is
    // still Nango at dispatch time (external-dispatch routes on
    // providerIntegrationId first), so it must never be promotable pod-wide.
    const isNango =
      existing.providerIntegrationId != null || effectiveAccountHint != null;
    if (isNango) {
      throw new Error(
        "A pod-wide connection must be a vault key — Nango/account connections cannot be pod-wide."
      );
    }
    await requirePodAdmin(actorUserId);
  }

  // Single-default is enforced PER TIER. When this row is/becomes the default,
  // clear the OTHER default in the row's EFFECTIVE tier (covers both "set default"
  // and "move a default row to the other tier").
  const effectiveIsPodWide = input.isPodWide ?? existing.isPodWide;
  const effectiveIsDefault = input.isDefault ?? existing.isDefault;
  if (effectiveIsDefault) {
    await unsetCapabilityDefault(capabilityId, {
      isPodWide: effectiveIsPodWide,
      exceptId: connectionId,
    });
  }

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (input.label !== undefined) patch.name = input.label;
  if (input.contextType !== undefined) patch.contextType = input.contextType;
  if (input.contextId !== undefined) patch.contextId = input.contextId;
  if (input.accountHint !== undefined) patch.accountHint = input.accountHint;
  if (input.isDefault !== undefined) patch.isDefault = input.isDefault;
  if (input.isPodWide !== undefined) patch.isPodWide = input.isPodWide;
  if (input.value !== undefined) {
    const blob = encryptServerSide(input.value);
    patch.encryptedData = blob.encryptedData;
    patch.iv = blob.iv;
    patch.authTag = blob.authTag;
    patch.encryptionVersion = 1;
    patch.encryptionMode = "server";
  }

  const [row] = await db
    .update(secrets)
    .set(patch)
    .where(eq(secrets.id, existing.id))
    .returning();

  if (input.value !== undefined) {
    await db.insert(secretAuditLog).values({
      secretId: row.id,
      userId: actorUserId,
      action: "updated",
      metadata: { via: "capability-connections", capabilityId, rotated: true },
    });
  }

  return {
    id: row.id,
    label: row.name,
    contextType: row.contextType ?? null,
    contextId: row.contextId ?? null,
    isDefault: row.isDefault,
    accountHint: row.accountHint ?? null,
    kind: connectionKind(row),
    isPodWide: row.isPodWide,
  };
}

// ── remove ─────────────────────────────────────────────────────────────────────

/**
 * Soft-delete a connection (sets `deleted_at`/`deleted_by`). When the removed row
 * was the capability's default and other connections remain, the OLDEST remaining
 * connection is promoted to default so the capability always has a resolvable
 * default.
 */
export async function removeConnection(input: {
  capabilityId: string;
  connectionId: string;
  actorUserId: string;
}): Promise<{ ok: true; promotedDefaultId: string | null }> {
  const { capabilityId, connectionId, actorUserId } = input;
  const existing = await loadOwnedConnection(
    capabilityId,
    connectionId,
    actorUserId
  );

  await db
    .update(secrets)
    .set({
      deletedAt: new Date(),
      deletedBy: actorUserId,
      isDefault: false,
      updatedAt: new Date(),
    })
    .where(eq(secrets.id, existing.id));

  await db.insert(secretAuditLog).values({
    secretId: existing.id,
    userId: actorUserId,
    action: "deleted",
    metadata: { via: "capability-connections", capabilityId },
  });

  // Drop the "used by" join row(s) for this secret under this capability — the
  // Connections face must stop showing a removed connection. (Soft-deleting the
  // secret does not cascade the join; the FK cascade only fires on hard delete.)
  await db
    .delete(secretUsages)
    .where(
      and(
        eq(secretUsages.secretId, existing.id),
        eq(secretUsages.consumerType, "capability"),
        eq(secretUsages.consumerId, capabilityId)
      )
    );

  let promotedDefaultId: string | null = null;
  if (existing.isDefault) {
    // Promote WITHIN the removed row's tier — promoting across tiers would create a
    // second default in the target tier and violate idx_secrets_capability_default
    // (keyed on (capability_id, is_pod_wide)).
    const [oldest] = await db
      .select({ id: secrets.id })
      .from(secrets)
      .where(
        and(
          eq(secrets.capabilityId, capabilityId),
          eq(secrets.isPodWide, existing.isPodWide),
          isNull(secrets.deletedAt)
        )
      )
      .orderBy(asc(secrets.createdAt))
      .limit(1);
    if (oldest) {
      await db
        .update(secrets)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(eq(secrets.id, oldest.id));
      promotedDefaultId = oldest.id;
    }
  }

  return { ok: true, promotedDefaultId };
}
