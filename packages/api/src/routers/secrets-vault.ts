/**
 * Secrets Vault Router
 *
 * Secure storage for passwords, API keys, and sensitive credentials.
 *
 * Security Model (see the `encryptionMode` column on the `secrets` table —
 * `@synap/database/schema/secrets-vault.ts` — for the authoritative contract):
 * - AES-256-GCM encryption.
 * - 'server' mode (default + only write path): the server encrypts with
 *   VAULT_SERVER_KEY and CAN read the plaintext (`reveal` decrypts server-side)
 *   — required so AI credential grants can resolve secrets server-side on a
 *   sovereign pod. This is NOT zero-knowledge and the server is NOT blind to
 *   plaintext.
 * - 'client' mode: LEGACY zero-knowledge rows from before server-only
 *   consolidation — still readable for backward compatibility but no longer
 *   written and not grantable to AI.
 * - Complete audit trail.
 */

import { router, protectedProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  db,
  sql,
  eq,
  and,
  isNull,
  inArray,
  drizzleSql,
  getWorkspaceMembership,
  SECRET_TYPES,
  SecretsVaultRepository,
  EventRepository,
  encryptServerSide,
  decryptServerSide,
  fingerprintPassword,
  isServerVaultAvailable,
  assertGrantScoped,
} from "@synap/database";
import {
  proposals,
  secrets,
  secretUsages,
  secretAuditLog,
  vaultGrants,
  users,
  capabilities,
  ProposalStatus,
} from "@synap/database/schema";
import type {
  SecretUsage as SecretUsageDTO,
  SecretGrantView,
  SecretActivityEvent,
  SecretDetailBundle,
  SecretConsumerType,
} from "@synap-core/types";
import { auditLog } from "../utils/audit-log.js";
import { assertWorkspaceWrite } from "../utils/workspace-write-access.js";

// ============================================================================
// Validation Schemas
// ============================================================================

const secretTypeSchema = z.enum(SECRET_TYPES);

/**
 * Plaintext secret value. Either a bare string (api_key, note, env_variable)
 * or a structured object (credential, card, identity). The server encrypts
 * this into the {encryptedData, iv, authTag} blob via VAULT_SERVER_KEY before
 * it touches the DB — the client never encrypts post server-only consolidation.
 */
const secretValueSchema = z.union([
  z.string(),
  z.record(z.string(), z.unknown()),
]);

const createSecretSchema = z.object({
  name: z.string().min(1).max(255),
  type: secretTypeSchema,
  url: z.string().url().optional(),
  category: z.string().max(100).optional(),
  description: z.string().max(1000).optional(),
  iconUrl: z.string().url().optional(),
  value: secretValueSchema, // Plaintext — server-encrypted before storage
  passwordStrength: z.number().min(0).max(4).optional(),
  tags: z.array(z.string().max(100)).optional(),
  workspaceId: z.string().uuid().optional(),
});

const updateSecretSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(255).optional(),
  url: z.string().url().optional().nullable(),
  category: z.string().max(100).optional().nullable(),
  description: z.string().max(1000).optional().nullable(),
  iconUrl: z.string().url().optional().nullable(),
  value: secretValueSchema.optional(), // Plaintext — server-encrypted before storage
  isFavorite: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  passwordStrength: z.number().min(0).max(4).optional(),
  tags: z.array(z.string().max(100)).optional(),
});

/** Serialize a plaintext secret value to the string the server encrypts. */
function serializeSecretValue(value: string | Record<string, unknown>): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * Derive the Watchtower write-time security metadata (BF-7 / BF-8) from the
 * plaintext value while it is already in hand — the counterpart to encrypting
 * the blob. NEVER a decrypt-scan.
 *
 *   hasTotp             — true when a structured value carries a non-empty `totp`.
 *   passwordFingerprint — HMAC(VAULT_SERVER_KEY, normalize(password)) when the
 *                         value has a non-empty `password`, else null.
 *
 * A bare-string value (api_key/note/env_variable) has neither.
 */
function deriveSecurityMetadata(value: string | Record<string, unknown>): {
  hasTotp: boolean;
  passwordFingerprint: string | null;
} {
  if (typeof value === "string") {
    return { hasTotp: false, passwordFingerprint: null };
  }

  const totp = value.totp;
  const hasTotp =
    typeof totp === "string" ? totp.trim().length > 0 : Boolean(totp);

  const password = value.password;
  const passwordFingerprint =
    typeof password === "string" && password.trim().length > 0
      ? fingerprintPassword(password)
      : null;

  return { hasTotp, passwordFingerprint };
}

const shareSecretSchema = z
  .object({
    secretId: z.string().uuid(),
    sharedWithUserId: z.string().optional(),
    sharedWithWorkspaceId: z.string().uuid().optional(),
    permission: z.enum(["read", "write"]).default("read"),
    expiresAt: z.date().optional(),
  })
  .refine((data) => data.sharedWithUserId || data.sharedWithWorkspaceId, {
    message: "Must specify user or workspace to share with",
  });

const setupVaultSchema = z.object({
  /**
   * The server handles all encryption via VAULT_SERVER_KEY. All key-derivation
   * fields are optional so the UI can call setupVault without sending inert
   * placeholders. (A `mode` field was removed — it was never consumed.)
   */
  salt: z.string().optional(),
  keyDerivationAlgorithm: z.string().optional(),
  keyDerivationParams: z
    .object({
      N: z.number(),
      r: z.number(),
      p: z.number(),
    })
    .optional(),
  verificationCipher: z.string().optional(),
  verificationIv: z.string().optional(),
  verificationTag: z.string().optional(),
  recoveryKeyHash: z.string().optional(),
});

// ============================================================================
// Helper to get repository
// ============================================================================

function getRepository(): SecretsVaultRepository {
  const eventRepo = new EventRepository(sql);
  return new SecretsVaultRepository(db, eventRepo);
}

// ============================================================================
// Grant helpers (shared by listGrants / listAllGrants / getDetailBundle —
// extracted to kill the 2-3x copy-paste of this exact logic)
// ============================================================================

/** A `vault_grants` row shape, as returned by drizzle's query API. */
type VaultGrantRow = {
  id: string;
  grantableId: string;
  execMode: string;
  grantedTo: string | null;
  proposalId: string | null;
  scope: string;
  expiresAt: Date | null;
  maxUses: number | null;
  useCount: number;
  workspaceId: string | null;
  revokedAt: Date | null;
  createdAt: Date;
};

/** Drizzle where-predicate for secret-kind vault_grants rows on the given secret id(s). */
function secretGrantsWhere(secretIds: string | string[]) {
  return Array.isArray(secretIds)
    ? and(
        eq(vaultGrants.grantableType, "secret"),
        inArray(vaultGrants.grantableId, secretIds)
      )
    : and(
        eq(vaultGrants.grantableType, "secret"),
        eq(vaultGrants.grantableId, secretIds)
      );
}

/** True when a grant is not revoked, not expired, and has uses remaining. */
function isGrantActive(
  g: Pick<VaultGrantRow, "revokedAt" | "expiresAt" | "maxUses" | "useCount">,
  now = Date.now()
): boolean {
  return (
    !g.revokedAt &&
    (!g.expiresAt || g.expiresAt.getTime() > now) &&
    (g.maxUses == null || g.useCount < g.maxUses)
  );
}

/** Uses remaining: null = unlimited; clamped at 0 when exhausted. */
function usesRemaining(
  g: Pick<VaultGrantRow, "maxUses" | "useCount">
): number | null {
  return g.maxUses == null ? null : Math.max(0, g.maxUses - g.useCount);
}

/**
 * Batched `users` lookup for a set of ids → best-effort display label
 * (name → email → raw id) + agent/user kind. One query for N grants/audit
 * rows rather than N queries.
 */
async function resolveActorLabels(
  userIds: string[]
): Promise<Map<string, { label: string; isAgent: boolean }>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Map();
  const rows = await db.query.users.findMany({
    where: inArray(users.id, ids),
    columns: { id: true, name: true, email: true, userType: true },
  });
  return new Map(
    rows.map((u) => [
      u.id,
      { label: u.name ?? u.email ?? u.id, isAgent: u.userType === "agent" },
    ])
  );
}

/** Map a raw `vault_grants` row to the canonical `SecretGrantView` wire shape. */
function toGrantView(
  g: VaultGrantRow,
  extra?: {
    secretName?: string | null;
    secretType?: string | null;
    granteeLabel?: string | null;
    granteeType?: "user" | "agent" | "workspace" | null;
  }
): SecretGrantView {
  return {
    grantId: g.id,
    grantedTo: g.grantedTo ?? "",
    scope: g.scope,
    expiresAt: g.expiresAt ? g.expiresAt.toISOString() : null,
    usesRemaining: usesRemaining(g),
    workspaceId: g.workspaceId ?? null,
    revokedAt: g.revokedAt ? g.revokedAt.toISOString() : null,
    active: isGrantActive(g),
    secretName: extra?.secretName ?? null,
    secretType: (extra?.secretType as SecretGrantView["secretType"]) ?? null,
    granteeLabel: extra?.granteeLabel ?? null,
    granteeType: extra?.granteeType ?? null,
  };
}

/**
 * Resolve the "used by" rows for a secret from the `secret_usages` join.
 *
 * The caller has ALREADY owner-scoped the secret (findById by ctx.userId), so
 * this reads the join rows for that secret. When the join has no rows yet but the
 * secret still carries a legacy `capability_id` (an un-backfilled connection),
 * synthesize a single capability usage from the row so the Connections face is
 * never empty for a secret that IS a connection. Labels are best-effort: the
 * stored `consumer_label` (or `consumer_id`) for join rows; the capability name
 * (falling back to the secret name / capability id) for the synthesized row.
 */
async function loadSecretUsages(secret: {
  id: string;
  name: string;
  capabilityId: string | null;
  contextType: string | null;
  contextId: string | null;
  workspaceId: string | null;
}): Promise<SecretUsageDTO[]> {
  const rows = await db.query.secretUsages.findMany({
    where: eq(secretUsages.secretId, secret.id),
    orderBy: (t, { asc }) => [asc(t.createdAt)],
  });

  if (rows.length > 0) {
    return rows.map((r) => ({
      id: r.id,
      secretId: r.secretId,
      consumerType: r.consumerType as SecretConsumerType,
      consumerId: r.consumerId,
      consumerLabel: r.consumerLabel ?? r.consumerId,
      contextType: r.contextType,
      contextId: r.contextId,
      workspaceId: r.workspaceId,
    }));
  }

  // Fallback: no join rows yet but the secret is a capability connection.
  if (secret.capabilityId) {
    const cap = await db.query.capabilities.findFirst({
      where: eq(capabilities.id, secret.capabilityId),
      columns: { name: true },
    });
    return [
      {
        id: `capability:${secret.capabilityId}`,
        secretId: secret.id,
        consumerType: "capability",
        consumerId: secret.capabilityId,
        consumerLabel: cap?.name ?? secret.name ?? secret.capabilityId,
        contextType: secret.contextType,
        contextId: secret.contextId,
        workspaceId: secret.workspaceId,
      },
    ];
  }

  return [];
}

// ============================================================================
// Router
// ============================================================================

export const secretsVaultRouter = router({
  // ==========================================================================
  // Vault Setup & Unlock
  // ==========================================================================

  /**
   * Check if vault is set up for current user
   */
  hasVault: protectedProcedure.query(async ({ ctx }) => {
    const repo = getRepository();
    return repo.hasVaultSetup(ctx.userId);
  }),

  /**
   * Setup vault with master password
   * Client generates the key derivation params and verification cipher
   */
  setupVault: protectedProcedure
    .input(setupVaultSchema)
    .mutation(async ({ ctx, input }) => {
      const repo = getRepository();

      const hasVault = await repo.hasVaultSetup(ctx.userId);
      if (hasVault) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Vault already set up",
        });
      }

      await repo.setupVault(ctx.userId, {
        salt: input.salt,
        keyDerivationAlgorithm: input.keyDerivationAlgorithm,
        keyDerivationParams: input.keyDerivationParams as
          | Record<string, unknown>
          | undefined,
        verificationCipher: input.verificationCipher,
        verificationIv: input.verificationIv,
        verificationTag: input.verificationTag,
        recoveryKeyHash: input.recoveryKeyHash,
      });

      return { success: true };
    }),

  // ==========================================================================
  // Secret CRUD
  // ==========================================================================

  /**
   * List secrets (metadata only, not decrypted)
   */
  list: protectedProcedure
    .input(
      z
        .object({
          type: secretTypeSchema.optional(),
          category: z.string().optional(),
          search: z.string().optional(),
          tags: z.array(z.string()).optional(),
          includeDeleted: z.boolean().optional(),
          limit: z.number().int().min(1).max(500).optional(),
          offset: z.number().int().min(0).optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const repo = getRepository();
      const secrets = await repo.list(ctx.userId, input ?? {});

      // Return secrets without exposing encrypted data in list
      return secrets.map((secret: any) => ({
        id: secret.id,
        name: secret.name,
        type: secret.type,
        url: secret.url,
        category: secret.category,
        description: secret.description,
        iconUrl: secret.iconUrl,
        isFavorite: secret.isFavorite,
        isShared: secret.isShared,
        isCompromised: secret.isCompromised,
        passwordStrength: secret.passwordStrength,
        lastAccessedAt: secret.lastAccessedAt,
        accessCount: secret.accessCount,
        createdAt: secret.createdAt,
        updatedAt: secret.updatedAt,
        tags: secret.tags?.map((t: any) => t.tag) ?? [],
      }));
    }),

  /**
   * Reveal the plaintext value of an owner-only, server-encrypted secret.
   *
   * Input:  { id: string }  — UUID of the secret to reveal.
   * Output: { value: string | Record<string, unknown> }  — decrypted plaintext.
   *         String secrets are returned as-is; JSON-object secrets are returned
   *         as parsed objects (matching what `create` stored via serializeSecretValue).
   *
   * Access control:
   *   - Owner-only: the calling user must own the secret (same check as get/update).
   *   - No vault_grant required: grants gate agent/IS redemption, not owner reads.
   *   - Legacy client-mode rows are refused with a clear message (no server key available).
   *
   * Audit: writes a `revealed` row to secret_audit_log.
   */
  reveal: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      // 1. Ownership check — reuses the same findById guard as get/update.
      const repo = getRepository();
      const secret = await repo.findById(input.id, ctx.userId);

      if (!secret) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Secret not found",
        });
      }

      // 2. Refuse legacy client-encrypted rows — server has no key for these.
      if (secret.encryptionMode !== "server") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "This secret predates the server-side vault consolidation. " +
            "Delete and re-create it to enable owner reveal.",
        });
      }

      // 3. Ensure VAULT_SERVER_KEY is configured on this pod.
      if (!isServerVaultAvailable()) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            "VAULT_SERVER_KEY is not configured on this server — cannot decrypt.",
        });
      }

      // 4. Decrypt via the same server-vault machinery used by create/update.
      //    decryptServerSide is the counterpart to encryptServerSide (server-vault.ts).
      let plaintext: string;
      try {
        plaintext = decryptServerSide({
          encryptedData: secret.encryptedData,
          iv: secret.iv,
          authTag: secret.authTag,
        });
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch (_err) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            "Failed to decrypt secret — key mismatch or data corruption.",
        });
      }

      // 5. Attempt JSON parse so object-valued secrets come back as objects;
      //    plain strings are returned as-is (mirrors serializeSecretValue behaviour).
      let value: string | Record<string, unknown>;
      try {
        const parsed = JSON.parse(plaintext) as unknown;
        value =
          parsed !== null &&
          typeof parsed === "object" &&
          !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : plaintext;
      } catch {
        value = plaintext;
      }

      // 6. Audit log — record the reveal action.
      await repo.logAudit(secret.id, ctx.userId, "revealed");

      return { value };
    }),

  /**
   * Create a new secret
   */
  create: protectedProcedure
    .input(createSecretSchema)
    .mutation(async ({ ctx, input }) => {
      const repo = getRepository();

      // Server-only consolidation: encrypt the plaintext value with VAULT_SERVER_KEY.
      // The row is persisted with encryptionMode 'server' (the schema default), so
      // it is resolvable by the vault resolver and grantable to AI.
      const blob = encryptServerSide(serializeSecretValue(input.value));
      // Watchtower cohorts, computed while the plaintext is in hand (BF-7/BF-8).
      const { hasTotp, passwordFingerprint } = deriveSecurityMetadata(
        input.value
      );

      const secret = await repo.create(
        {
          name: input.name,
          type: input.type,
          url: input.url,
          category: input.category,
          description: input.description,
          iconUrl: input.iconUrl,
          encryptedData: blob.encryptedData,
          iv: blob.iv,
          authTag: blob.authTag,
          passwordStrength: input.passwordStrength,
          tags: input.tags,
          workspaceId: input.workspaceId,
          hasTotp,
          passwordFingerprint,
        },
        ctx.userId
      );

      return {
        id: secret.id,
        name: secret.name,
        type: secret.type,
        createdAt: secret.createdAt,
      };
    }),

  /**
   * Update a secret
   */
  update: protectedProcedure
    .input(updateSecretSchema)
    .mutation(async ({ ctx, input }) => {
      const repo = getRepository();
      const { id, value, ...rest } = input;

      // Server-encrypt the new plaintext value (if a rotation was supplied).
      const encryptedFields =
        value !== undefined
          ? (() => {
              const blob = encryptServerSide(serializeSecretValue(value));
              // Recompute Watchtower cohorts from the rotated plaintext
              // (BF-7/BF-8) — a removed password/totp clears the stamp.
              const { hasTotp, passwordFingerprint } =
                deriveSecurityMetadata(value);
              return {
                encryptedData: blob.encryptedData,
                iv: blob.iv,
                authTag: blob.authTag,
                // Stamp server mode so a legacy 'client' row that re-enters its
                // value here migrates and `reveal` stops refusing it.
                encryptionMode: "server",
                hasTotp,
                passwordFingerprint,
              };
            })()
          : {};

      const secret = await repo.update(
        id,
        { ...rest, ...encryptedFields },
        ctx.userId
      );

      return {
        id: secret.id,
        name: secret.name,
        updatedAt: secret.updatedAt,
      };
    }),

  /**
   * Delete a secret (soft delete)
   */
  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const repo = getRepository();
      await repo.delete(input.id, ctx.userId);
      return { success: true };
    }),

  /**
   * Soft-delete a secret via the capability write-gate (used by the headless
   * Hub `DELETE /vault/secrets/:id` door). Unlike `delete` (owner-only), this
   * keys off the LOADED row's workspaceId through `assertWorkspaceWrite`
   * (editor+ member of the row's workspace, or the owner for an ownerless
   * pod-wide secret). NEVER hard-deletes — grants/audit reference the row, and
   * `resolveVaultSecret` already returns null for a soft-deleted secret (lazy
   * grant death). Active grants therefore need no cascade.
   */
  deleteSecret: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.userId;
      const secret = await db.query.secrets.findFirst({
        where: eq(secrets.id, input.id),
        columns: { id: true, workspaceId: true, userId: true, deletedAt: true },
      });
      if (!secret || secret.deletedAt) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Secret not found" });
      }

      // Write-gate on the LOADED row's workspaceId (never a request-supplied
      // one). For an ownerless pod-wide secret the owner is the secret's userId.
      await assertWorkspaceWrite(db, userId, {
        workspaceId: secret.workspaceId,
        ownerId: secret.userId,
      });

      await db
        .update(secrets)
        .set({ deletedAt: new Date(), deletedBy: userId })
        .where(eq(secrets.id, input.id));

      auditLog({
        subjectType: "secret",
        action: "delete",
        phase: "completed",
        subjectId: input.id,
        userId,
        workspaceId: secret.workspaceId ?? undefined,
        data: { id: input.id },
      });

      return { success: true as const };
    }),

  /**
   * Permanently delete a secret
   */
  // PARKED: no trash UI yet (see VAULT-CONSOLIDATION-PLAN §4)
  permanentDelete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const repo = getRepository();
      await repo.permanentDelete(input.id, ctx.userId);
      return { success: true };
    }),

  /**
   * Restore a deleted secret
   */
  // PARKED: no trash UI yet (see VAULT-CONSOLIDATION-PLAN §4)
  restore: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const repo = getRepository();
      await repo.restore(input.id, ctx.userId);
      return { success: true };
    }),

  // ==========================================================================
  // Autofill & Quick Access
  // ==========================================================================

  /**
   * Find secrets by URL (for autofill)
   */
  findByUrl: protectedProcedure
    .input(z.object({ url: z.string() }))
    .query(async ({ ctx, input }) => {
      const repo = getRepository();
      const secrets = await repo.findByUrl(ctx.userId, input.url);

      return secrets.map((secret: any) => ({
        id: secret.id,
        name: secret.name,
        type: secret.type,
        url: secret.url,
        encryptedData: secret.encryptedData,
        iv: secret.iv,
        authTag: secret.authTag,
      }));
    }),

  /**
   * Record copy to clipboard (for audit)
   */
  recordCopy: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const repo = getRepository();
      await repo.recordCopy(input.id, ctx.userId);
      return { success: true };
    }),

  // ==========================================================================
  // Organization
  // ==========================================================================

  /**
   * Get all categories
   */
  getCategories: protectedProcedure.query(async ({ ctx }) => {
    const repo = getRepository();
    return repo.getCategories(ctx.userId);
  }),

  /**
   * Get all tags
   */
  getTags: protectedProcedure.query(async ({ ctx }) => {
    const repo = getRepository();
    return repo.getTags(ctx.userId);
  }),

  // ==========================================================================
  // Sharing
  // ==========================================================================

  /**
   * Share a secret
   */
  // PARKED: sharing not yet built — deferred/re-scoped as a vault_grants
  // extension to human principals (see VAULT-CONSOLIDATION-PLAN §4)
  share: protectedProcedure
    .input(shareSecretSchema)
    .mutation(async ({ ctx, input }) => {
      const repo = getRepository();
      const share = await repo.share(
        {
          secretId: input.secretId,
          sharedWithUserId: input.sharedWithUserId,
          sharedWithWorkspaceId: input.sharedWithWorkspaceId,
          permission: input.permission,
          expiresAt: input.expiresAt,
        },
        ctx.userId
      );

      return {
        id: share.id,
        secretId: share.secretId,
        permission: share.permission,
      };
    }),

  /**
   * Revoke a share
   */
  // PARKED: sharing not yet built (see VAULT-CONSOLIDATION-PLAN §4)
  revokeShare: protectedProcedure
    .input(z.object({ shareId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const repo = getRepository();
      await repo.revokeShare(input.shareId, ctx.userId);
      return { success: true };
    }),

  /**
   * Get secrets shared with me
   */
  // PARKED: sharing not yet built (see VAULT-CONSOLIDATION-PLAN §4)
  sharedWithMe: protectedProcedure.query(async ({ ctx }) => {
    const repo = getRepository();
    const shares = await repo.getSharedWithMe(ctx.userId);

    return shares.map((share: any) => ({
      shareId: share.id,
      permission: share.permission,
      sharedBy: share.sharedBy,
      expiresAt: share.expiresAt,
      secret: {
        id: share.secret.id,
        name: share.secret.name,
        type: share.secret.type,
        url: share.secret.url,
        encryptedData: share.secret.encryptedData,
        iv: share.secret.iv,
        authTag: share.secret.authTag,
      },
    }));
  }),

  // ==========================================================================
  // Audit & Security
  // ==========================================================================

  /**
   * Get audit log for a secret
   */
  getAuditLog: protectedProcedure
    .input(
      z.object({
        secretId: z.string().uuid(),
        limit: z.number().int().min(1).max(100).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const repo = getRepository();
      return repo.getAuditLog(input.secretId, ctx.userId, input.limit);
    }),

  /**
   * Get security stats (compromised, weak passwords, old passwords)
   */
  getSecurityStats: protectedProcedure.query(async ({ ctx }) => {
    const repo = getRepository();

    const [compromised, weakPasswords, oldPasswords, noTotp, reused] =
      await Promise.all([
        repo.getCompromisedCount(ctx.userId),
        repo.getWeakPasswordsCount(ctx.userId),
        repo.getOldPasswordsCount(ctx.userId, 90),
        // BF-7 "logins without 2FA" + BF-8 reused-password — both server-side
        // column reads, never a decrypt-scan. Owner-scoped by ctx.userId.
        repo.getNoTotpCount(ctx.userId),
        repo.getReusedPasswordCount(ctx.userId),
      ]);

    return {
      compromised,
      weakPasswords,
      oldPasswords,
      noTotp,
      reused,
    };
  }),

  /**
   * Mark a secret as compromised
   */
  // PARKED: no breach scan yet (see VAULT-CONSOLIDATION-PLAN §4)
  markCompromised: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const repo = getRepository();
      await repo.markCompromised(input.id, ctx.userId);
      return { success: true };
    }),

  // ==========================================================================
  // AI Access
  // ==========================================================================

  /**
   * Grant an AI agent access to a vault secret.
   * Called from the browser when user approves a vault.request proposal.
   *
   * Only works with server-encrypted secrets — client-encrypted secrets
   * cannot be resolved by the vault resolver (no master password on server).
   *
   * Returns the vault:// reference for the approved secret.
   */
  grantAIAccess: protectedProcedure
    .input(
      z.object({
        secretId: z.string().uuid(),
        proposalId: z.string().uuid(),
        // Grant scope chosen by the user via the "Once / Session / Permanent"
        // pills. Defaults to 'session' when omitted.
        scope: z.enum(["once", "session", "permanent"]).default("session"),
        // Optional explicit session TTL (minutes). Overrides the proposal's
        // requested ttl for 'session' scope. Ignored for 'once'/'permanent'.
        ttlMinutes: z.number().int().positive().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // 1. Verify secret exists, belongs to this user/workspace, and isn't
      //    soft-deleted (a deleted secret can't be granted — resolveVaultSecret
      //    would return null for it at redemption anyway).
      const secret = await db.query.secrets.findFirst({
        where: and(
          eq(secrets.id, input.secretId),
          eq(secrets.userId, ctx.userId),
          isNull(secrets.deletedAt)
        ),
      });
      if (!secret)
        throw new TRPCError({ code: "NOT_FOUND", message: "Secret not found" });

      // 2. Tolerance check for LEGACY client-encrypted rows only. Post server-only
      //    consolidation all new secrets are server-encrypted and grantable; a
      //    non-'server' row can only be a pre-consolidation client-mode secret,
      //    which the vault resolver cannot decrypt (no master password on server).
      if (secret.encryptionMode !== "server") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "This secret predates the server-side vault consolidation and cannot be granted to AI. Delete and re-create it to enable AI access.",
        });
      }

      // 3. Load the proposal to read its requested ttl (the agent's vault.request
      //    embeds { ttl } in proposal data — see hub-protocol/rest/vault.ts).
      //    Vault grants are USER/DEVICE-level, not gated on the frontend's active
      //    workspace: the proposal already carries its workspaceId, so we read it
      //    from there. Authorization = secret ownership (checked above) PLUS
      //    membership of the proposal's workspace (below) — so a grant works even
      //    when the UI isn't currently focused on that workspace.
      const proposalRow = await db.query.proposals.findFirst({
        where: eq(proposals.id, input.proposalId),
        columns: {
          id: true,
          data: true,
          createdBy: true,
          agentUserId: true,
          workspaceId: true,
        },
      });
      if (!proposalRow)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Proposal not found",
        });

      // Workspace from the request, not the UI. If the proposal is workspace-
      // scoped, require the approver to be a member of THAT workspace (defense
      // against approving another tenant's proposal). Pod-wide proposals
      // (workspaceId null) are gated by secret ownership alone.
      const grantWorkspaceId = proposalRow.workspaceId ?? null;
      if (grantWorkspaceId) {
        const membership = await getWorkspaceMembership(
          db,
          grantWorkspaceId,
          ctx.userId
        );
        if (!membership)
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Not a member of this proposal's workspace",
          });
      }

      const proposalData = (proposalRow.data ?? {}) as { ttl?: number };
      const requestedTtl =
        typeof proposalData.ttl === "number" ? proposalData.ttl : undefined;

      // 4. Compute the grant window from scope.
      //    once: 15min default & single use.
      //    session: explicit ttlMinutes ?? requested ttl ?? 60 minutes.
      //    permanent: no expiry, unlimited uses.
      const now = Date.now();
      let expiresAt: Date | null;
      let maxUses: number | null;
      if (input.scope === "once") {
        expiresAt = new Date(now + 15 * 60 * 1000);
        maxUses = 1;
      } else if (input.scope === "permanent") {
        expiresAt = null;
        maxUses = null;
      } else {
        const minutes = input.ttlMinutes ?? requestedTtl ?? 60;
        expiresAt = new Date(now + minutes * 60 * 1000);
        maxUses = null;
      }

      // The agent the grant is issued to (best-effort): the proposal's agent
      // author, falling back to its creator.
      const grantedTo =
        proposalRow.agentUserId ?? proposalRow.createdBy ?? null;

      // FIREWALL: a grant MUST be scoped to a specific agent OR a workspace. A
      // grant with BOTH null would be a pod-wide, any-principal wildcard at
      // redemption (findRedeemableGrant treats a NULL column as a wildcard). The
      // canonical guard lives next to the grant semantics so every issuance path
      // is covered — see assertGrantScoped in @synap/database vault-resolver.
      assertGrantScoped({ grantedTo, workspaceId: grantWorkspaceId });

      // 5. Build the vault:// reference
      const vaultRef = `vault://${secret.id}`;

      // 6. Insert the grant row (the enforcement record consulted at redemption).
      //    A vault secret is just one grantable KIND — write the generalized
      //    capability-grant columns (grantableType='secret', grantableId=secret
      //    id, execMode='auto'). The legacy `secret_id` column still exists in
      //    the DB (kept for audit) but is no longer in the Drizzle model — the
      //    subject is carried by grantableId now.
      const [grant] = await db
        .insert(vaultGrants)
        .values({
          grantableType: "secret",
          grantableId: secret.id,
          execMode: "auto",
          proposalId: input.proposalId,
          grantedTo,
          workspaceId: grantWorkspaceId,
          scope: input.scope,
          expiresAt,
          maxUses,
          createdBy: ctx.userId,
        })
        .returning({ id: vaultGrants.id });

      // 7. Approve the proposal and embed the vault ref + scope in data
      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          updatedAt: new Date(),
          data: drizzleSql`data || jsonb_build_object('vaultRef', ${vaultRef}::text, 'secretId', ${secret.id}::text, 'approvedAt', ${new Date().toISOString()}::text, 'grantId', ${grant.id}::text, 'scope', ${input.scope}::text, 'expiresAt', ${expiresAt ? expiresAt.toISOString() : null})`,
        })
        .where(eq(proposals.id, input.proposalId));

      // 8. Audit log — record the scope and window.
      auditLog({
        subjectType: "vault_secret",
        action: "grant_ai_access",
        phase: "completed",
        subjectId: secret.id,
        userId: ctx.userId,
        workspaceId: grantWorkspaceId ?? undefined,
        data: {
          proposalId: input.proposalId,
          vaultRef,
          grantId: grant.id,
          scope: input.scope,
          expiresAt: expiresAt ? expiresAt.toISOString() : null,
          maxUses,
        },
      });

      return {
        vaultRef,
        secretId: secret.id,
        proposalId: input.proposalId,
        grantId: grant.id,
        scope: input.scope,
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
      };
    }),

  // ==========================================================================
  // Grant Management
  // ==========================================================================

  /**
   * List grants for a secret (owner-only). Shows scope, window, and usage so the
   * UI can render and revoke active AI access.
   */
  listGrants: protectedProcedure
    .input(z.object({ secretId: z.string().uuid() }))
    .query(async ({ ctx, input }): Promise<SecretGrantView[]> => {
      // Ownership check — only the secret owner may view its grants. Exclude
      // soft-deleted secrets for parity with listAllGrants (a grant on a
      // deleted secret is dead — resolveVaultSecret returns null for it).
      const secret = await db.query.secrets.findFirst({
        where: and(
          eq(secrets.id, input.secretId),
          eq(secrets.userId, ctx.userId),
          isNull(secrets.deletedAt)
        ),
        columns: { id: true },
      });
      if (!secret)
        throw new TRPCError({ code: "NOT_FOUND", message: "Secret not found" });

      // Grants are now keyed by (grantableType, grantableId). For a secret-detail
      // view that's grantableType='secret', grantableId=<secret id>.
      const rows = await db.query.vaultGrants.findMany({
        where: secretGrantsWhere(input.secretId),
        orderBy: (t, { desc }) => [desc(t.createdAt)],
      });

      return rows.map((g) => toGrantView(g));
    }),

  /**
   * List grants across ALL of the caller's secrets — the owner's "who has AI
   * access to what" view (vault Access tab). Per-secret `listGrants` stays for
   * the secret-detail context. Field names match the UI contract directly:
   * `grantId` (not `id`) and `secretName` are included so clients need no
   * remapping.
   */
  listAllGrants: protectedProcedure.query(
    async ({ ctx }): Promise<SecretGrantView[]> => {
      const owned = await db.query.secrets.findMany({
        // Exclude soft-deleted secrets — a grant on a deleted secret is dead
        // (resolveVaultSecret returns null), so it must not show as active access.
        where: and(eq(secrets.userId, ctx.userId), isNull(secrets.deletedAt)),
        columns: { id: true, name: true, type: true },
      });
      if (owned.length === 0) return [];
      const secretById = new Map(owned.map((s) => [s.id, s]));

      // Owner's "who has AI access to which of MY secrets" view — secret-kind
      // grants whose grantableId is one of the caller's owned secrets.
      const rows = await db.query.vaultGrants.findMany({
        where: secretGrantsWhere(owned.map((s) => s.id)),
        orderBy: (t, { desc }) => [desc(t.createdAt)],
      });

      // Resolve grantee type (user vs agent) + display label with ONE batched
      // users lookup. A grant may be workspace-scoped (grantedTo null); those
      // resolve to a null label and a "workspace" granteeType.
      const granteeById = await resolveActorLabels(
        rows.map((g) => g.grantedTo).filter((id): id is string => !!id)
      );

      return rows.map((g) => {
        const secret = secretById.get(g.grantableId);
        const grantee = g.grantedTo ? granteeById.get(g.grantedTo) : undefined;
        const granteeType: "user" | "agent" | "workspace" = g.grantedTo
          ? grantee?.isAgent
            ? "agent"
            : "user"
          : "workspace";
        return toGrantView(g, {
          secretName: secret?.name ?? null,
          secretType: secret?.type ?? null,
          granteeLabel: g.grantedTo ? (grantee?.label ?? g.grantedTo) : null,
          granteeType,
        });
      });
    }
  ),

  /**
   * Revoke an AI access grant (owner-only). Idempotent — re-revoking is a no-op.
   */
  revokeGrant: protectedProcedure
    .input(z.object({ grantId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      // Load the grant, then enforce owner-only revocation PER grantableType.
      const grant = await db.query.vaultGrants.findFirst({
        where: eq(vaultGrants.id, input.grantId),
        columns: {
          id: true,
          grantableType: true,
          grantableId: true,
          revokedAt: true,
        },
      });
      if (!grant)
        throw new TRPCError({ code: "NOT_FOUND", message: "Grant not found" });

      // This router owns secret-kind grants. Tool/skill/command grants are
      // revoked through their own management surfaces (later waves); fail loud
      // rather than silently allow a cross-kind revoke here.
      if (grant.grantableType !== "secret") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `revokeGrant on this router handles secret grants only (got "${grant.grantableType}").`,
        });
      }

      const secret = await db.query.secrets.findFirst({
        where: and(
          eq(secrets.id, grant.grantableId),
          eq(secrets.userId, ctx.userId),
          isNull(secrets.deletedAt)
        ),
        columns: { id: true },
      });
      if (!secret)
        throw new TRPCError({ code: "FORBIDDEN", message: "Not your secret" });

      if (!grant.revokedAt) {
        await db
          .update(vaultGrants)
          .set({ revokedAt: new Date() })
          .where(eq(vaultGrants.id, input.grantId));

        auditLog({
          subjectType: "vault_secret",
          action: "revoke_ai_access",
          phase: "completed",
          subjectId: grant.grantableId,
          userId: ctx.userId,
          data: { grantId: input.grantId },
        });
      }

      return { success: true };
    }),

  // ==========================================================================
  // Connected Vault (WP-B2) — "where is this secret used", + one-call bundle
  // ==========================================================================

  /**
   * List where a secret is used (owner-only) — the Connections face.
   *
   * Reads `secret_usages WHERE secret_id = id`. When the join is still empty but
   * the secret carries a legacy `capability_id`, a single capability usage is
   * synthesized from the row (fallback for un-backfilled connections). Labels are
   * resolved best-effort (stored consumer_label, else the capability name).
   */
  usedBy: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }): Promise<SecretUsageDTO[]> => {
      // Owner-scoped: findById filters on ctx.userId — a user only sees usages
      // for their own secret.
      const repo = getRepository();
      const secret = await repo.findById(input.id, ctx.userId);
      if (!secret) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Secret not found" });
      }
      return loadSecretUsages(secret);
    }),

  /**
   * One-call detail bundle (owner-only) — identity metadata (NOT the encrypted
   * value) + usages + grants + recent activity. Reduces the detail view's
   * round-trips (reveal stays a separate, explicit action).
   */
  getDetailBundle: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }): Promise<SecretDetailBundle> => {
      const repo = getRepository();
      // Owner-scoped ownership + metadata load (never the plaintext value).
      const secret = await repo.findById(input.id, ctx.userId);
      if (!secret) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Secret not found" });
      }

      const [usages, grantRows, auditRows] = await Promise.all([
        loadSecretUsages(secret),
        // Grants for this secret (same predicate as listGrants).
        db.query.vaultGrants.findMany({
          where: secretGrantsWhere(secret.id),
          orderBy: (t, { desc }) => [desc(t.createdAt)],
        }),
        // Newest ~20 audit rows. Ownership was already verified by findById
        // above, so read the log directly (typed) rather than via the repo.
        db.query.secretAuditLog.findMany({
          where: eq(secretAuditLog.secretId, secret.id),
          orderBy: (t, { desc }) => [desc(t.createdAt)],
          limit: 20,
        }),
      ]);

      const grants: SecretGrantView[] = grantRows.map((g) => toGrantView(g));

      // Resolve actor type (user vs agent) for the audit rows — one batched
      // users lookup, best-effort label (name → email → raw id).
      const actorById = await resolveActorLabels(
        auditRows.map((r) => r.userId)
      );

      const recentActivity: SecretActivityEvent[] = auditRows.map((r) => {
        const actor = actorById.get(r.userId);
        return {
          id: r.id,
          action: r.action,
          actorType: actor?.isAgent ? "agent" : "user",
          actorLabel: actor?.label ?? r.userId,
          createdAt: r.createdAt.toISOString(),
        };
      });

      return {
        id: secret.id,
        name: secret.name,
        type: secret.type,
        category: secret.category ?? null,
        url: secret.url ?? null,
        description: secret.description ?? null,
        isFavorite: secret.isFavorite,
        createdAt: secret.createdAt.toISOString(),
        updatedAt: secret.updatedAt.toISOString(),
        usages,
        grants,
        recentActivity,
      };
    }),
});
