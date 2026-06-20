/**
 * Secrets Vault Router
 *
 * Secure storage for passwords, API keys, and sensitive credentials.
 *
 * Security Model:
 * - Client-side encryption (AES-256-GCM)
 * - Server never sees plaintext secrets
 * - Zero-knowledge architecture
 * - Complete audit trail
 */

import { router, protectedProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  db,
  sql,
  eq,
  and,
  inArray,
  drizzleSql,
  getWorkspaceMembership,
  secretVaultKeys,
  SECRET_TYPES,
  SecretsVaultRepository,
  EventRepository,
  encryptionService,
  encryptServerSide,
  decryptServerSide,
  isServerVaultAvailable,
  assertGrantScoped,
} from "@synap/database";
import {
  proposals,
  secrets,
  vaultGrants,
  ProposalStatus,
} from "@synap/database/schema";
import { auditLog } from "../utils/audit-log.js";

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
   * Get vault metadata (for client-side password verification)
   */
  getVaultMetadata: protectedProcedure.query(async ({ ctx }) => {
    const repo = getRepository();
    const metadata = await repo.getVaultKeyMetadata(ctx.userId);

    if (!metadata) {
      return null;
    }

    return {
      salt: metadata.salt,
      keyDerivationAlgorithm: metadata.keyDerivationAlgorithm,
      keyDerivationParams: metadata.keyDerivationParams,
      verificationCipher: metadata.verificationCipher,
      verificationIv: metadata.verificationIv,
      verificationTag: metadata.verificationTag,
      hasRecoveryKey: !!metadata.recoveryKeyHash,
    };
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

  /**
   * Record vault unlock (for audit trail)
   */
  recordUnlock: protectedProcedure.mutation(async ({ ctx }) => {
    const repo = getRepository();
    await repo.recordVaultUnlock(ctx.userId);
    return { success: true };
  }),

  /**
   * Generate recovery key (server-side for security)
   */
  generateRecoveryKey: protectedProcedure.mutation(async ({ ctx }) => {
    const recoveryKey = encryptionService.generateRecoveryKey();
    const hash = await encryptionService.hashRecoveryKey(recoveryKey);

    // Store hash in vault keys
    await db
      .update(secretVaultKeys)
      .set({
        recoveryKeyHash: hash,
        recoveryKeyCreatedAt: new Date(),
      })
      .where(eq(secretVaultKeys.userId, ctx.userId));

    // Return the recovery key ONCE (user must save it)
    return {
      recoveryKey,
      message:
        "Save this recovery key securely. It will not be displayed again.",
    };
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
   * Get a single secret (includes encrypted data for client decryption)
   *
   * @legacy This procedure returns raw encrypted blobs for client-side decryption,
   * which is no longer supported post server-only consolidation. Use `reveal` to
   * retrieve the plaintext value of a server-encrypted secret.
   */
  get: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const repo = getRepository();
      const secret = await repo.findById(input.id, ctx.userId);

      if (!secret) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Secret not found",
        });
      }

      // Record access
      await repo.recordAccess(input.id, ctx.userId);

      return {
        id: secret.id,
        name: secret.name,
        type: secret.type,
        url: secret.url,
        category: secret.category,
        description: secret.description,
        iconUrl: secret.iconUrl,
        encryptedData: secret.encryptedData,
        iv: secret.iv,
        authTag: secret.authTag,
        encryptionVersion: secret.encryptionVersion,
        isFavorite: secret.isFavorite,
        isShared: secret.isShared,
        isCompromised: secret.isCompromised,
        passwordStrength: secret.passwordStrength,
        passwordLastChanged: secret.passwordLastChanged,
        lastAccessedAt: secret.lastAccessedAt,
        accessCount: secret.accessCount,
        createdAt: secret.createdAt,
        updatedAt: secret.updatedAt,
        tags: (secret as Record<string, unknown>).tags
          ? (
              (secret as Record<string, unknown>).tags as Array<{ tag: string }>
            ).map((t) => t.tag)
          : [],
      };
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
      } catch (err) {
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
              return {
                encryptedData: blob.encryptedData,
                iv: blob.iv,
                authTag: blob.authTag,
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
   * Permanently delete a secret
   */
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

    const [compromised, weakPasswords, oldPasswords, total] = await Promise.all(
      [
        repo.getCompromisedCount(ctx.userId),
        repo.getWeakPasswordsCount(ctx.userId),
        repo.getOldPasswordsCount(ctx.userId, 90),
        repo.list(ctx.userId, { limit: 1 }).then((r: unknown[]) => r.length),
      ]
    );

    return {
      compromised,
      weakPasswords,
      oldPasswords,
      total,
    };
  }),

  /**
   * Mark a secret as compromised
   */
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
      // 1. Verify secret exists and belongs to this user/workspace
      const secret = await db.query.secrets.findFirst({
        where: and(
          eq(secrets.id, input.secretId),
          eq(secrets.userId, ctx.userId)
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
      const [grant] = await db
        .insert(vaultGrants)
        .values({
          secretId: secret.id,
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
    .query(async ({ ctx, input }) => {
      // Ownership check — only the secret owner may view its grants.
      const secret = await db.query.secrets.findFirst({
        where: and(
          eq(secrets.id, input.secretId),
          eq(secrets.userId, ctx.userId)
        ),
        columns: { id: true },
      });
      if (!secret)
        throw new TRPCError({ code: "NOT_FOUND", message: "Secret not found" });

      const rows = await db.query.vaultGrants.findMany({
        where: eq(vaultGrants.secretId, input.secretId),
        orderBy: (t, { desc }) => [desc(t.createdAt)],
      });

      const now = Date.now();
      return rows.map((g) => ({
        id: g.id,
        scope: g.scope,
        grantedTo: g.grantedTo,
        proposalId: g.proposalId,
        expiresAt: g.expiresAt ? g.expiresAt.toISOString() : null,
        maxUses: g.maxUses,
        useCount: g.useCount,
        revokedAt: g.revokedAt ? g.revokedAt.toISOString() : null,
        createdAt: g.createdAt.toISOString(),
        active:
          !g.revokedAt &&
          (!g.expiresAt || g.expiresAt.getTime() > now) &&
          (g.maxUses == null || g.useCount < g.maxUses),
      }));
    }),

  /**
   * List grants across ALL of the caller's secrets — the owner's "who has AI
   * access to what" view (vault Access tab). Per-secret `listGrants` stays for
   * the secret-detail context. Field names match the UI contract directly:
   * `grantId` (not `id`) and `secretName` are included so clients need no
   * remapping.
   */
  listAllGrants: protectedProcedure.query(async ({ ctx }) => {
    const owned = await db.query.secrets.findMany({
      where: eq(secrets.userId, ctx.userId),
      columns: { id: true, name: true },
    });
    if (owned.length === 0) return [];
    const nameById = new Map(owned.map((s) => [s.id, s.name]));

    const rows = await db.query.vaultGrants.findMany({
      where: inArray(
        vaultGrants.secretId,
        owned.map((s) => s.id)
      ),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });

    const now = Date.now();
    return rows.map((g) => ({
      grantId: g.id,
      secretId: g.secretId,
      secretName: nameById.get(g.secretId) ?? null,
      grantedTo: g.grantedTo,
      proposalId: g.proposalId,
      scope: g.scope,
      expiresAt: g.expiresAt ? g.expiresAt.toISOString() : null,
      maxUses: g.maxUses,
      useCount: g.useCount,
      revokedAt: g.revokedAt ? g.revokedAt.toISOString() : null,
      createdAt: g.createdAt.toISOString(),
      active:
        !g.revokedAt &&
        (!g.expiresAt || g.expiresAt.getTime() > now) &&
        (g.maxUses == null || g.useCount < g.maxUses),
    }));
  }),

  /**
   * Revoke an AI access grant (owner-only). Idempotent — re-revoking is a no-op.
   */
  revokeGrant: protectedProcedure
    .input(z.object({ grantId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      // Join to the owning secret to enforce owner-only revocation.
      const grant = await db.query.vaultGrants.findFirst({
        where: eq(vaultGrants.id, input.grantId),
        columns: { id: true, secretId: true, revokedAt: true },
      });
      if (!grant)
        throw new TRPCError({ code: "NOT_FOUND", message: "Grant not found" });

      const secret = await db.query.secrets.findFirst({
        where: and(
          eq(secrets.id, grant.secretId),
          eq(secrets.userId, ctx.userId)
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
          subjectId: grant.secretId,
          userId: ctx.userId,
          data: { grantId: input.grantId },
        });
      }

      return { success: true };
    }),
});
