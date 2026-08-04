/**
 * API Keys Schema - Drizzle ORM
 *
 * Hub Protocol V1.0 - Phase 2
 *
 * API keys for Hub authentication with bcrypt hashing and complete audit trail.
 * Based on industry best practices from GitHub, Stripe, and AWS.
 */

import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  bigint,
  unique,
  check,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * API Keys Table
 *
 * Stores API keys with bcrypt hashing for security.
 * Supports key rotation, expiration, and complete audit trail.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    // Primary Key
    id: uuid("id").primaryKey().defaultRandom(),

    // Ownership
    userId: text("user_id").notNull(),

    // Key Identification
    keyName: text("key_name").notNull(), // User-friendly name
    keyPrefix: text("key_prefix").notNull(), // 'synap_hub_live_', 'synap_hub_test_', 'synap_user_'
    keyHash: text("key_hash").notNull(), // Bcrypt hash (cost factor 12)

    // O(1) lookup hash — sha256(fullKey), hex. API keys are 256-bit RANDOM
    // tokens (not passwords), so a plain sha256 is the industry-standard
    // verifier (GitHub/Stripe). Lets verification do an indexed equality lookup
    // instead of bcrypt-comparing every prefix-matching candidate.
    // NULLABLE: legacy bcrypt-only keys are backfilled lazily on first
    // successful bcrypt verify (see api-keys service). See migration
    // 0157_api_key_lookup_hash.sql.
    keyLookupHash: text("key_lookup_hash"),

    // Key Type & Description
    keyType: text("key_type")
      .notNull()
      .default("hub_inbound")
      .$type<
        "hub_inbound" | "user_pat" | "system" | "service" | "is_internal"
      >(), // Categorical purpose label
    // 'service' is a first-class, product-neutral machine credential. Minted by
    // POST /api/hub/setup/service (NOT /setup/agent), it is owned directly by a
    // human user (the pod owner, or a caller-named human) — NOT a synthetic
    // agent-typed user — with `linkedUserId` NULL so no agent identity remap
    // fires: a service key authenticates AS its owner with its own explicit,
    // caller-declared scopes (defaulting to minimal `hub-protocol.read`), bound
    // to one `workspace_id`. Unlike agent keys, minting a second service key for
    // the same owner does NOT revoke the first — multiple integrators coexist.
    //
    // 'is_internal' is the TRUSTED Intelligence-Service pod-read key. It is the
    // ONLY keyType that may activate the X-Delegated-Operator-Id auth gate (see
    // hub-protocol-rest.ts), letting the IS orchestrator read on behalf of the
    // operator whose turn it is processing. It is minted EXCLUSIVELY by the
    // CP-signed-JWT-gated POST /api/provision/register-intelligence handler
    // (apps/api/src/routers/provision.ts). No public key-mint path can set it —
    // every public path hardcodes a non-is_internal literal and none reads
    // keyType from caller input.
    description: text("description"), // Human-readable explanation of what this key does

    // Metadata
    hubId: text("hub_id"), // NULL for user keys, set for Hub keys
    scope: text("scope")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`), // Granular permissions
    expiresAt: timestamp("expires_at", { withTimezone: true }), // NULL = no expiration

    // State
    isActive: boolean("is_active").notNull().default(true),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    usageCount: bigint("usage_count", { mode: "number" }).notNull().default(0),

    // Rotation
    rotatedFromId: uuid("rotated_from_id"), // Will add reference after table definition
    rotationScheduledAt: timestamp("rotation_scheduled_at", {
      withTimezone: true,
    }),

    // Sub-token (per-external-user) — when set, this key is a child of
    // `parent_key_id`. Revoking the parent cascades. NULL for parent keys
    // and stand-alone keys. See migration 0018_per_user_sub_tokens.sql.
    parentKeyId: uuid("parent_key_id"),

    // Workspace scope (NULL = pod-wide / user-scoped legacy key).
    // Set when the key is minted via apiKeys.createForWorkspace so the
    // workspace-admin UI can list / revoke keys belonging to that
    // workspace without leaking keys from other workspaces a user is
    // also a member of. See migration 0020_api_keys_workspace_scope.sql.
    workspaceId: uuid("workspace_id"),

    // Identity link — human user this agent key acts on behalf of.
    // Set by POST /setup/agent (auto-resolved to pod owner when omitted).
    // The memory router dual-writes facts to both userId and linkedUserId
    // so the pod owner's timeline reflects the agent's observations.
    // NULL = no identity link (standalone service keys, sub-tokens, etc.)
    // See migration 0021_api_keys_linked_user_id.sql.
    linkedUserId: text("linked_user_id"),

    // Instance label — a per-runtime marker for concurrent agent instances that
    // share ONE agent identity (e.g. claude-code on two machines, or CLI + MCP).
    // NULL = the legacy single-key model (minting revokes all siblings). When set,
    // /setup/agent skips the blanket sibling-revoke and scopes idempotency/rotation
    // to THIS instance, so multiple instances hold live keys concurrently. Purely a
    // key label — agent-user identity is singleton per (createdByUserId, agentType).
    // See migration 0204_api_keys_instance_id.sql.
    instanceId: text("instance_id"),

    // Audit Trail
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdBy: text("created_by"), // User ID who created
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: text("revoked_by"), // User ID who revoked
    revokedReason: text("revoked_reason"),
  },
  (table) => ({
    // Constraints
    userIdCheck: check(
      "api_keys_user_id_check",
      sql`${table.userId} IS NOT NULL AND LENGTH(TRIM(${table.userId})) > 0`
    ),
    keyNameCheck: check(
      "api_keys_key_name_check",
      sql`LENGTH(TRIM(${table.keyName})) > 0`
    ),
    keyPrefixCheck: check(
      "api_keys_key_prefix_check",
      sql`${table.keyType} = 'hub_inbound' OR ${table.keyPrefix} IN ('synap_hub_live_', 'synap_hub_test_', 'synap_user_')`
    ),
    keyHashUnique: unique("api_keys_key_hash_unique").on(table.keyHash),
    // Non-unique: nullable column with many NULLs for un-migrated keys.
    keyLookupHashIdx: index("api_keys_key_lookup_hash_idx").on(
      table.keyLookupHash
    ),
  })
);

/**
 * TypeScript type for API Key record
 */
export type ApiKeyRecord = typeof apiKeys.$inferSelect;

/**
 * TypeScript type for API Key insert
 */
export type ApiKeyInsert = typeof apiKeys.$inferInsert;

/**
 * Valid key prefixes
 */
export const KEY_PREFIXES = {
  HUB_LIVE: "synap_hub_live_",
  HUB_TEST: "synap_hub_test_",
  USER: "synap_user_",
} as const;

/**
 * Valid scopes for API keys
 */
export const API_KEY_SCOPES = [
  "preferences",
  "calendar",
  "notes",
  "tasks",
  "projects",
  "conversations",
  "entities",
  "relations",
  "knowledge_facts",
  // n8n integration scopes
  "write:entities", // Create/update/delete entities via n8n
  "read:entities", // Search and read entities via n8n
  "ai:analyze", // AI content analysis
  "webhook:manage", // Manage webhook subscriptions (Phase 2)
  // Hub Protocol scopes (for Intelligence Hub)
  "hub-protocol.read", // Read context from Data Pod
  "hub-protocol.write", // Write results back to Data Pod
  "hub-protocol.admin", // Elevated Hub Protocol access (full entity/workspace control)
  // Data scopes (generic read/write used by integration presets)
  "data.read", // Read entities, documents, relations
  "data.write", // Write entities, documents, relations
  // MCP scopes (for external AI tools)
  "mcp.read", // Read resources via MCP
  "mcp.write", // Execute tools via MCP
  "mcp.connect", // Establish an MCP session
  // Agent provisioning scope
  "setup.agent", // Call POST /setup/agent to provision agents on this pod.
  // Grant this to automation services (n8n, scripts, third-party
  // providers) that need to create agent users without going
  // through Synap CP or exposing the PROVISIONING_TOKEN.
  // External API scopes (for external callers: Claude Code, custom agents, scripts)
  "skills.invoke", // List and invoke skills via /api/external/skills
  "chat.stream", // Stream AI chat completions via /api/external/chat (Option D)
  // Realtime observer scope (Phase 3A — Eve OS channels viz)
  // Read-only Socket.IO subscription scope. A key with this scope can connect
  // to /presence with `apiKey` instead of `userId` and join workspace:${id}
  // rooms to receive event broadcasts (chat:stream, openclaw:message:received,
  // agent:task:status, etc). Does NOT grant the right to emit events back —
  // the bridge HTTP endpoint stays guarded by BRIDGE_SECRET as before. See
  // synap-team-docs/content/team/platform/eve-os-vision.mdx §9 Phase 3A.
  "realtime:observe",
] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/**
 * Helper to check if a scope is valid
 */
export function isValidScope(scope: string): scope is ApiKeyScope {
  return API_KEY_SCOPES.includes(scope as ApiKeyScope);
}

// Relations
import { relations } from "drizzle-orm";
import { users } from "./users.js";

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  user: one(users, {
    fields: [apiKeys.userId],
    references: [users.id],
  }),
}));
