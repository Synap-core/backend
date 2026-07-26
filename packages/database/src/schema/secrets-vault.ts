/**
 * Secrets Vault Schema - Drizzle ORM
 *
 * Secure storage for passwords, API keys, and sensitive credentials.
 * Based on industry best practices from 1Password, Bitwarden, and AWS Secrets Manager.
 *
 * Security Model (see the `encryptionMode` column for the authoritative contract):
 * - AES-256-GCM encryption.
 * - 'server' mode (default + only write path): the server encrypts with
 *   VAULT_SERVER_KEY and can read the plaintext — required so AI credential grants
 *   can resolve secrets server-side on a sovereign pod.
 * - 'client' mode: LEGACY zero-knowledge rows, still readable for backward
 *   compatibility but no longer written and not grantable to AI.
 * - Complete audit trail.
 */

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  boolean,
  timestamp,
  integer,
  jsonb,
  unique,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { users } from "./users.js";
import { workspaces } from "./workspaces.js";

// ============================================================================
// Enums
// ============================================================================

export const secretTypeEnum = pgEnum("secret_type", [
  "password", // Website/app passwords
  "api_key", // API keys & tokens
  "credential", // Username/password pairs
  "note", // Secure notes
  "card", // Payment cards
  "identity", // Personal identity info
  "ssh_key", // SSH keys
  "certificate", // SSL/TLS certificates
  "env_variable", // Environment variables
  "database", // Database connection strings
  "oauth", // OAuth tokens
]);

// Local type derived from the pgEnum above (mirrors @synap-core/types SecretType)
export const SECRET_TYPES = secretTypeEnum.enumValues;
export type SecretType = (typeof SECRET_TYPES)[number];

// ============================================================================
// Secrets Table
// ============================================================================

/**
 * Main secrets table
 *
 * Stores encrypted secrets with metadata for organization and search.
 * The `encryptedData` field holds a server-encrypted (VAULT_SERVER_KEY,
 * AES-256-GCM) JSON blob in the default `encryptionMode='server'` path; legacy
 * `'client'` rows are the old zero-knowledge blobs (read-only). See the
 * `encryptionMode` column doc below for the authoritative contract.
 */
export const secrets = pgTable(
  "secrets",
  {
    // Primary Key
    id: uuid("id").primaryKey().defaultRandom(),

    // Ownership
    userId: text("user_id").notNull(),
    workspaceId: uuid("workspace_id"),

    // Secret Metadata (searchable, not encrypted)
    name: text("name").notNull(),
    type: secretTypeEnum("type").notNull().default("password"),
    url: text("url"), // For autofill matching (domain-based)
    category: text("category"), // User-defined category
    description: text("description"), // Optional description
    iconUrl: text("icon_url"), // Favicon or custom icon

    // Encrypted Payload (AES-256-GCM)
    // Contains: { username, password, notes, customFields, ... }
    encryptedData: text("encrypted_data").notNull(),
    encryptionVersion: integer("encryption_version").notNull().default(1),
    iv: text("iv").notNull(), // Initialization vector (base64)
    authTag: text("auth_tag").notNull(), // GCM authentication tag (base64)

    // Encryption mode:
    //   'server' (default) — encrypted by the server using VAULT_SERVER_KEY; readable server-side.
    //                        This is the ONLY write path post server-only consolidation: on a
    //                        sovereign pod the server already holds all data plaintext, and AI
    //                        credential grants require server-readable secrets.
    //   'client'           — LEGACY: zero-knowledge, encrypted by the client with user's master key.
    //                        Still readable (list/get) for backward compatibility on pods that hold
    //                        such rows, but no longer written and cannot be granted to AI.
    encryptionMode: text("encryption_mode").notNull().default("server"),

    // Optional: links this secret to a registered intelligence service (e.g. "openclaw-abc12345").
    // Used by getServiceConfig to fetch credentials by serviceId without scanning all user secrets.
    serviceId: text("service_id"),

    /**
     * Optional FK to provider_integrations. When set, this secret's credential
     * routes through the linked provider for OAuth lifecycle (token refresh, proxy)
     * instead of being injected as a raw API key. Null -> direct vault injection
     * (existing behavior, unchanged).
     */
    providerIntegrationId: uuid("provider_integration_id"),

    // Organization
    isFavorite: boolean("is_favorite").notNull().default(false),
    sortOrder: integer("sort_order").default(0),

    // State
    lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }),
    accessCount: integer("access_count").notNull().default(0),

    // Password-specific metadata (unencrypted for breach monitoring)
    passwordStrength: integer("password_strength"), // 0-4 scale
    passwordLastChanged: timestamp("password_last_changed", {
      withTimezone: true,
    }),
    isCompromised: boolean("is_compromised").default(false),
    compromisedAt: timestamp("compromised_at", { withTimezone: true }),

    // Watchtower write-time security metadata (BF-7 / BF-8). Both are computed
    // when the plaintext value is in hand (create/update) — NEVER by decrypting
    // and scanning stored rows.
    //   has_totp — true when the structured plaintext carried a non-empty `totp`.
    //     Powers the "N logins without 2FA" cohort.
    //   password_fingerprint — HMAC-SHA256(VAULT_SERVER_KEY, normalize(password)),
    //     a keyed digest (NOT a bare hash — defeats an offline dictionary on the
    //     column) that lets two secrets be compared for password reuse without
    //     ever re-holding plaintext. Null when the value has no password.
    hasTotp: boolean("has_totp").notNull().default(false),
    passwordFingerprint: text("password_fingerprint"),

    // Sharing
    isShared: boolean("is_shared").notNull().default(false),

    // ── Capability-connection registry (0161) ──
    // This secret IS a capability connection when `capabilityId` is set; NULL =
    // a plain personal-vault entry. `contextType`/`contextId` optionally bind the
    // connection to a context object (entity/participant/project/workspace) so a
    // per-entity / per-user run resolves the right credential. `isDefault` marks
    // the connection picked when no selector is supplied. `accountHint` selects
    // 1-of-N Nango connections under one provider.
    capabilityId: uuid("capability_id"),
    accountHint: text("account_hint"),
    contextType: text("context_type"),
    contextId: text("context_id"),
    isDefault: boolean("is_default").notNull().default(false),

    // ── Pod-wide connection tier (0211) ──
    // When true, this capability connection is a SHARED vault key any pod member
    // can USE for the capability without holding a per-user vault grant (the run
    // still passes the capability-execution gate). VAULT ONLY — never set on a
    // Nango/provider-delegated connection. Precedence: a member's OWN connection
    // wins over the pod-wide default. Write RBAC (service layer): pod-admin only.
    isPodWide: boolean("is_pod_wide").notNull().default(false),

    // Soft delete
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedBy: text("deleted_by"),

    // Audit Trail
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    // Indexes for common queries
    userIdIdx: index("idx_secrets_user_id").on(table.userId),
    workspaceIdIdx: index("idx_secrets_workspace_id").on(table.workspaceId),
    typeIdx: index("idx_secrets_type").on(table.type),
    categoryIdx: index("idx_secrets_category").on(table.category),
    urlIdx: index("idx_secrets_url").on(table.url),
    deletedAtIdx: index("idx_secrets_deleted_at").on(table.deletedAt),
    // Compound index for common list query
    userTypeIdx: index("idx_secrets_user_type").on(table.userId, table.type),
    serviceIdIdx: index("idx_secrets_service_id").on(table.serviceId),
    encryptionModeIdx: index("idx_secrets_encryption_mode").on(
      table.encryptionMode
    ),
    userServiceIdx: index("idx_secrets_user_service").on(
      table.userId,
      table.serviceId
    ),
    providerIntegrationIdx: index("idx_secrets_provider_integration").on(
      table.providerIntegrationId
    ),
    // Capability-connection registry (0161)
    capabilityIdx: index("idx_secrets_capability").on(table.capabilityId),
    contextIdx: index("idx_secrets_context").on(
      table.contextType,
      table.contextId
    ),
    // Watchtower reused-password partition (BF-8): the `count(*) OVER (PARTITION
    // BY user_id, password_fingerprint)` scan groups on exactly this pair.
    passwordFingerprintIdx: index("idx_secrets_password_fingerprint").on(
      table.userId,
      table.passwordFingerprint
    ),
  })
);

// ============================================================================
// Secret Tags (Many-to-Many)
// ============================================================================

export const secretTags = pgTable(
  "secret_tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    secretId: uuid("secret_id")
      .notNull()
      .references(() => secrets.id, { onDelete: "cascade" }),
    tag: text("tag").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    // Unique tag per secret
    uniqueSecretTag: unique("secret_tags_unique").on(table.secretId, table.tag),
    // Index for tag-based queries
    tagIdx: index("idx_secret_tags_tag").on(table.tag),
  })
);

// ============================================================================
// Secret Usages (Many-to-Many "this secret is used by X")
// ============================================================================

/**
 * Records WHERE a secret is used — the "Connections" face of the vault.
 *
 * A single secret can be consumed by many things (a capability connection, a
 * bound tool credential, a channel connection, an entity binding, an automation,
 * or a raw url match). This join makes that many-to-many explicit so the detail
 * view can render a "Used by" list without scanning every consumer table.
 *
 * The connection registry columns already on `secrets` (`capability_id`,
 * `context_type`/`context_id`) cover the 1:1 capability-connection case; this
 * table generalizes it. `consumer_id` is polymorphic TEXT (no FK — it can point
 * at a capability, tool, channel, entity, automation, or a url string), so the
 * label is denormalized into `consumer_label` for cheap display.
 *
 * Written by the single connection/credential writers (capability-connections,
 * tool credential binding); backfilled once from every `secrets` row that
 * already carries a non-null `capability_id`.
 */
export const secretUsages = pgTable(
  "secret_usages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    secretId: uuid("secret_id")
      .notNull()
      .references(() => secrets.id, { onDelete: "cascade" }),

    // WHAT kind of thing consumes the secret. Polymorphic — no FK.
    //   'capability' | 'tool' | 'connection' | 'entity' | 'automation' | 'url'
    consumerType: text("consumer_type").notNull(),
    consumerId: text("consumer_id").notNull(),
    // Denormalized human label (capability name, connector, entity name, url).
    consumerLabel: text("consumer_label"),

    // Optional scoping / context binding, mirroring the secrets registry columns.
    workspaceId: uuid("workspace_id"),
    contextType: text("context_type"),
    contextId: text("context_id"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    // One usage row per (secret, consumer, context). NULL context_id rows are
    // distinct under Postgres unique semantics — intended (many context-less
    // usages of the same secret by the same consumer never collide).
    uniqueUsage: unique("secret_usages_unique").on(
      table.secretId,
      table.consumerType,
      table.consumerId,
      table.contextId
    ),
    secretIdIdx: index("idx_secret_usages_secret_id").on(table.secretId),
    consumerIdx: index("idx_secret_usages_consumer").on(
      table.consumerType,
      table.consumerId
    ),
  })
);

// ============================================================================
// Secret Shares (Workspace/User Sharing)
// ============================================================================

export const secretShares = pgTable(
  "secret_shares",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    secretId: uuid("secret_id")
      .notNull()
      .references(() => secrets.id, { onDelete: "cascade" }),

    // Share target (one must be set)
    sharedWithUserId: text("shared_with_user_id"),
    sharedWithWorkspaceId: uuid("shared_with_workspace_id"),

    // Permission level
    permission: text("permission").notNull().default("read"), // read, write

    // Share metadata
    sharedBy: text("shared_by").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: text("revoked_by"),

    // Audit
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    secretIdIdx: index("idx_secret_shares_secret_id").on(table.secretId),
    sharedWithUserIdx: index("idx_secret_shares_shared_with_user").on(
      table.sharedWithUserId
    ),
    sharedWithWorkspaceIdx: index("idx_secret_shares_shared_with_workspace").on(
      table.sharedWithWorkspaceId
    ),
  })
);

// ============================================================================
// Vault Grants (AI Access Scopes)
// ============================================================================

/**
 * Scope of an AI access grant:
 *   'once'      — single redemption (max_uses=1), short default TTL (15min).
 *   'session'   — time-boxed (expires_at set from requested/explicit TTL).
 *   'permanent' — never expires, unlimited uses (expires_at null, max_uses null).
 */
export const vaultGrantScopeEnum = pgEnum("vault_grant_scope", [
  "once",
  "session",
  "permanent",
]);

export const VAULT_GRANT_SCOPES = vaultGrantScopeEnum.enumValues;
export type VaultGrantScope = (typeof VAULT_GRANT_SCOPES)[number];

/**
 * What KIND of thing a capability grant authorizes. A `secret` grant is the
 * original vault-secret read; `tool`/`skill`/`command` generalize the SAME
 * enforcement shape (scope/TTL/uses/binding) to any grantable capability
 * (see @synap/playbooks GrantableKind). The subject id is `grantable_id`
 * (polymorphic text — no FK, since it can point at any of these tables).
 */
export const grantableTypeEnum = pgEnum("grantable_type", [
  "secret",
  "tool",
  "skill",
  "command",
]);

export const GRANTABLE_TYPES = grantableTypeEnum.enumValues;
export type GrantableType = (typeof GRANTABLE_TYPES)[number];

/**
 * What happens when a grant is exercised — the governance/execMode axis (the
 * same axis as Capability.governance in @synap/playbooks):
 *   'auto'    — run the capability directly (today's secret-read behavior).
 *   'propose' — route the exercise through a reviewable proposal.
 *   'dry-run' — preview only (stub external writes/sends, keep reads + checks).
 */
export const grantExecModeEnum = pgEnum("grant_exec_mode", [
  "auto",
  "propose",
  "dry-run",
]);

export const GRANT_EXEC_MODES = grantExecModeEnum.enumValues;
export type GrantExecMode = (typeof GRANT_EXEC_MODES)[number];

/**
 * Capability Grants (formerly Vault Grants — generalized in 0142)
 *
 * Records an AI/agent access grant to a GRANTABLE capability (a vault secret, a
 * tool, a skill, or a command), created when a user approves a capability/vault
 * request proposal (grantAIAccess / focus-sessions.grantCapability). Enforced at
 * redemption: the resolver looks up an ACTIVE grant (not revoked, not expired,
 * use_count < max_uses), bound to the redeemer, and atomically increments
 * use_count.
 *
 * The table is still named `vault_grants` (rename-in-place per G1 — only the
 * subject column generalized from `secret_id` FK to `grantable_type` +
 * `grantable_id`). The pod's own internal/service redemption paths
 * (getServiceConfig / getServiceSecret bootstrap creds) deliberately do NOT
 * consult this table — grants gate agent/IS redemption only.
 */
export const vaultGrants = pgTable(
  "vault_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Polymorphic subject: WHAT this grant authorizes. `grantableType`
    // discriminates; `grantableId` is the id of the secret/tool/skill/command
    // (text, no FK — a polymorphic id can't reference one table).
    grantableType: grantableTypeEnum("grantable_type").notNull(),
    grantableId: text("grantable_id").notNull(),

    // What happens when the grant is exercised (governance axis).
    execMode: grantExecModeEnum("exec_mode").notNull().default("auto"),

    // The proposal this grant was approved against.
    proposalId: uuid("proposal_id"),

    // The requesting agent user id (nullable — a grant may be issued for a
    // workspace rather than a specific agent identity).
    grantedTo: text("granted_to"),
    workspaceId: uuid("workspace_id"),

    // Scope & enforcement window.
    scope: vaultGrantScopeEnum("scope").notNull().default("session"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    maxUses: integer("max_uses"), // null = unlimited; 1 for 'once'
    useCount: integer("use_count").notNull().default(0),

    // Revocation.
    revokedAt: timestamp("revoked_at", { withTimezone: true }),

    // Audit.
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    grantedToIdx: index("idx_vault_grants_granted_to").on(table.grantedTo),
    proposalIdIdx: index("idx_vault_grants_proposal_id").on(table.proposalId),
    // Hot path: find active grants for a grantable capability.
    grantableActiveIdx: index("idx_vault_grants_secret_active").on(
      table.grantableType,
      table.grantableId,
      table.revokedAt
    ),
  })
);

// ============================================================================
// Secret Audit Log
// ============================================================================

export const secretAuditLog = pgTable(
  "secret_audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    secretId: uuid("secret_id")
      .notNull()
      .references(() => secrets.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),

    // Action details
    action: text("action").notNull(), // created, read, updated, deleted, shared, revoked, copied
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    metadata: jsonb("metadata"), // Additional context

    // Timestamp
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    secretIdIdx: index("idx_secret_audit_log_secret_id").on(table.secretId),
    userIdIdx: index("idx_secret_audit_log_user_id").on(table.userId),
    createdAtIdx: index("idx_secret_audit_log_created_at").on(table.createdAt),
  })
);

// ============================================================================
// Master Key Metadata (for key derivation verification)
// ============================================================================

/**
 * Stores metadata for verifying master password without storing it.
 * Used to validate the master password before attempting decryption.
 */
export const secretVaultKeys = pgTable("secret_vault_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull().unique(),

  // Key derivation parameters
  salt: text("salt").notNull(), // Random salt for key derivation
  keyDerivationAlgorithm: text("key_derivation_algorithm")
    .notNull()
    .default("argon2id"),
  keyDerivationParams: jsonb("key_derivation_params").notNull(), // { memory, iterations, parallelism }

  // Verification (encrypted known value to verify correct password)
  verificationCipher: text("verification_cipher").notNull(),
  verificationIv: text("verification_iv").notNull(),
  verificationTag: text("verification_tag").notNull(),

  // Recovery
  recoveryKeyHash: text("recovery_key_hash"), // Bcrypt hash of recovery key
  recoveryKeyCreatedAt: timestamp("recovery_key_created_at", {
    withTimezone: true,
  }),

  // Audit
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  lastUnlockedAt: timestamp("last_unlocked_at", { withTimezone: true }),
});

// ============================================================================
// Types
// ============================================================================

export type Secret = typeof secrets.$inferSelect;
export type NewSecret = typeof secrets.$inferInsert;
export type SecretTag = typeof secretTags.$inferSelect;
export type NewSecretTag = typeof secretTags.$inferInsert;
export type SecretUsage = typeof secretUsages.$inferSelect;
export type NewSecretUsage = typeof secretUsages.$inferInsert;
export type SecretShare = typeof secretShares.$inferSelect;
export type NewSecretShare = typeof secretShares.$inferInsert;
export type SecretAuditLogEntry = typeof secretAuditLog.$inferSelect;
export type NewSecretAuditLogEntry = typeof secretAuditLog.$inferInsert;
export type SecretVaultKey = typeof secretVaultKeys.$inferSelect;
export type NewSecretVaultKey = typeof secretVaultKeys.$inferInsert;
export type VaultGrant = typeof vaultGrants.$inferSelect;
export type NewVaultGrant = typeof vaultGrants.$inferInsert;

// ============================================================================
// Relations
// ============================================================================

export const secretsRelations = relations(secrets, ({ one, many }) => ({
  user: one(users, {
    fields: [secrets.userId],
    references: [users.id],
  }),
  workspace: one(workspaces, {
    fields: [secrets.workspaceId],
    references: [workspaces.id],
  }),
  tags: many(secretTags),
  usages: many(secretUsages),
  shares: many(secretShares),
  auditLog: many(secretAuditLog),
  // NOTE: `vault_grants` is now polymorphic (grantable_type/grantable_id) — a
  // grant no longer FKs the secrets table, so there is no Drizzle relation back
  // to secrets. Grant→secret resolution happens explicitly in the resolver when
  // grantable_type='secret'.
}));

export const secretTagsRelations = relations(secretTags, ({ one }) => ({
  secret: one(secrets, {
    fields: [secretTags.secretId],
    references: [secrets.id],
  }),
}));

export const secretUsagesRelations = relations(secretUsages, ({ one }) => ({
  secret: one(secrets, {
    fields: [secretUsages.secretId],
    references: [secrets.id],
  }),
}));

export const secretSharesRelations = relations(secretShares, ({ one }) => ({
  secret: one(secrets, {
    fields: [secretShares.secretId],
    references: [secrets.id],
  }),
}));

export const secretAuditLogRelations = relations(secretAuditLog, ({ one }) => ({
  secret: one(secrets, {
    fields: [secretAuditLog.secretId],
    references: [secrets.id],
  }),
}));

export const secretVaultKeysRelations = relations(
  secretVaultKeys,
  ({ one }) => ({
    user: one(users, {
      fields: [secretVaultKeys.userId],
      references: [users.id],
    }),
  })
);

// ============================================================================
// Audit Actions
// ============================================================================

export const SECRET_AUDIT_ACTIONS = [
  "created",
  "read",
  "updated",
  "deleted",
  "shared",
  "revoked",
  "copied",
  "exported",
  "imported",
  "password_changed",
  "vault_unlocked",
  "vault_locked",
  "revealed",
] as const;

export type SecretAuditAction = (typeof SECRET_AUDIT_ACTIONS)[number];
