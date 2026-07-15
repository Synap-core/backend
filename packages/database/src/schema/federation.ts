/**
 * Pod-local federation records.
 *
 * A Pod stays independent of any particular account service. It only records
 * a trusted issuer, that issuer's opaque subject, and the local user or
 * idempotent command to which they were bound. The issuer decides how it
 * authenticates people; the Pod remains authoritative for its own resources.
 */

import {
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { trustedIssuers } from "./trusted-issuers.js";
import { users } from "./users.js";
import { workspaces } from "./workspaces.js";
import { projects } from "./projects.js";

export type FederatedAccessScopeKind = "workspace" | "project";

/**
 * Capabilities that can be approved for a browser application connection.
 *
 * This is deliberately narrower than the Pod's trusted-issuer capability
 * registry. An application connection currently governs the federation
 * sign-in/link journey and the exact browser origin permitted to present an
 * explicit Pod session token. It grants no data privileges itself: every
 * resulting request remains bounded by the person's real Pod memberships.
 */
export const FEDERATED_APPLICATION_CONNECTION_SCOPES = [
  "auth:exchange-user",
  "identity:link-user",
] as const;

export type FederatedApplicationConnectionScope =
  (typeof FEDERATED_APPLICATION_CONNECTION_SCOPES)[number];

/**
 * An explicit one-to-one link between a trusted issuer subject and a local
 * Pod user. `issuerId + issuerSubject` is the security boundary; a bare JWT
 * `sub` is never globally meaningful.
 */
export const federatedIdentityLinks = pgTable(
  "federated_identity_links",
  {
    issuerId: uuid("issuer_id")
      .notNull()
      .references(() => trustedIssuers.id, { onDelete: "restrict" }),
    issuerSubject: text("issuer_subject").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    linkedByUserId: text("linked_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    linkedAt: timestamp("linked_at", {
      mode: "date",
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", {
      mode: "date",
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.issuerId, table.issuerSubject] }),
    issuerUserUnique: uniqueIndex(
      "federated_identity_links_issuer_user_unique"
    ).on(table.issuerId, table.userId),
    userIdx: index("federated_identity_links_user_idx").on(table.userId),
  })
);

/**
 * Idempotency receipts for issuer-authorized membership commands. A command is
 * unique only within its issuer, preventing distinct issuers from colliding on
 * opaque command IDs.
 */
export const federatedAccessReceipts = pgTable(
  "federated_access_receipts",
  {
    issuerId: uuid("issuer_id")
      .notNull()
      .references(() => trustedIssuers.id, { onDelete: "restrict" }),
    commandId: text("command_id").notNull(),
    issuerSubject: text("issuer_subject").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    scopeKind: text("scope_kind").notNull().$type<FederatedAccessScopeKind>(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "restrict",
    }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "restrict",
    }),
    role: text("role").notNull().$type<"admin" | "editor" | "viewer">(),
    appliedAt: timestamp("applied_at", {
      mode: "date",
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.issuerId, table.commandId] }),
    exactScopeCheck: check(
      "federated_access_receipts_exact_scope_check",
      sql`(
        (${table.scopeKind} = 'workspace' AND ${table.workspaceId} IS NOT NULL AND ${table.projectId} IS NULL)
        OR
        (${table.scopeKind} = 'project' AND ${table.workspaceId} IS NULL AND ${table.projectId} IS NOT NULL)
      )`
    ),
    roleCheck: check(
      "federated_access_receipts_role_check",
      sql`${table.role} IN ('admin', 'editor', 'viewer')`
    ),
    userScopeIdx: index("federated_access_receipts_user_scope_idx").on(
      table.userId,
      table.scopeKind
    ),
  })
);

/**
 * Durable, issuer-scoped assertion replay protection. Retry-safe federated
 * mutation routes consume this table directly after cryptographic verification,
 * so the one-time assertion contract holds across Pod processes and restarts.
 */
export const federatedAssertionReceipts = pgTable(
  "federated_assertion_receipts",
  {
    issuerId: uuid("issuer_id")
      .notNull()
      .references(() => trustedIssuers.id, { onDelete: "restrict" }),
    jti: text("jti").notNull(),
    expiresAt: timestamp("expires_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    consumedAt: timestamp("consumed_at", {
      mode: "date",
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.issuerId, table.jti] }),
    expiryAfterConsumptionCheck: check(
      "federated_assertion_receipts_expiry_check",
      sql`${table.expiresAt} > ${table.consumedAt}`
    ),
    expiryIdx: index("federated_assertion_receipts_expiry_idx").on(
      table.expiresAt
    ),
  })
);

/**
 * A short-lived, single-use receipt issued after a locally authenticated Pod
 * user links an issuer identity. The opaque receipt lets the issuer's server
 * fetch Pod-authoritative access without the Pod storing provider-specific
 * account data.
 */
export const issuerIdentityLinkReceipts = pgTable(
  "issuer_identity_link_receipts",
  {
    receiptId: uuid("receipt_id").primaryKey().defaultRandom(),
    issuerId: uuid("issuer_id")
      .notNull()
      .references(() => trustedIssuers.id, { onDelete: "restrict" }),
    issuerSubject: text("issuer_subject").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    intentId: text("intent_id").notNull(),
    nonceHash: text("nonce_hash").notNull(),
    expiresAt: timestamp("expires_at", {
      mode: "date",
      withTimezone: true,
    }).notNull(),
    consumedAt: timestamp("consumed_at", {
      mode: "date",
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", {
      mode: "date",
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    issuerIntentNonceUnique: uniqueIndex(
      "issuer_identity_link_receipts_issuer_intent_nonce_unique"
    ).on(table.issuerId, table.intentId, table.nonceHash),
    expiryIdx: index("issuer_identity_link_receipts_expiry_idx").on(
      table.expiresAt
    ),
  })
);

/**
 * A Pod-owner approved pairing of a browser application client and a trusted
 * issuer. This is separate from `trusted_issuers`: an issuer answers “who may
 * sign assertions?”, while this row answers “which exact app journey may use
 * that issuer on this Pod?”.
 *
 * `allowedOrigins` and `allowedCallbackUrls` are exact owner-approved browser
 * registration data. The API CORS policy consults approved origins only to
 * admit transport from that named app; they never create data permissions.
 * The user's local Pod session and membership remain authoritative.
 */
export const federatedApplicationConnections = pgTable(
  "federated_application_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    issuerId: uuid("issuer_id")
      .notNull()
      .references(() => trustedIssuers.id, { onDelete: "restrict" }),
    clientId: text("client_id").notNull(),
    displayName: text("display_name").notNull(),
    publisherUrl: text("publisher_url"),
    allowedOrigins: text("allowed_origins")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    allowedCallbackUrls: text("allowed_callback_urls")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    allowedScopes: text("allowed_scopes")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`)
      .$type<FederatedApplicationConnectionScope[]>(),
    status: text("status")
      .notNull()
      .default("pending")
      .$type<"pending" | "approved" | "rejected" | "revoked">(),
    reviewedBy: text("reviewed_by").references(() => users.id, {
      onDelete: "set null",
    }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    rejectionReason: text("rejection_reason"),
    initialRequestData: jsonb("initial_request_data"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    issuerClientUnique: uniqueIndex(
      "federated_application_connections_issuer_client_unique"
    ).on(table.issuerId, table.clientId),
    issuerStatusIdx: index(
      "federated_application_connections_issuer_status_idx"
    ).on(table.issuerId, table.status),
    exactOriginsCheck: check(
      "federated_application_connections_exact_origins_check",
      sql`cardinality(${table.allowedOrigins}) > 0`
    ),
    exactCallbacksCheck: check(
      "federated_application_connections_exact_callbacks_check",
      sql`cardinality(${table.allowedCallbackUrls}) > 0`
    ),
  })
);

/**
 * Short-lived review request for an application connection. Opaque browser
 * continuation and callback codes are stored only as hashes. Approval creates
 * the durable connection above; redirect URLs never contain Pod sessions,
 * issuer assertions, or bearer credentials.
 */
export const federatedApplicationConnectionRequests = pgTable(
  "federated_application_connection_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    issuerUrl: text("issuer_url").notNull(),
    clientId: text("client_id").notNull(),
    displayName: text("display_name").notNull(),
    publisherUrl: text("publisher_url"),
    requestedOrigin: text("requested_origin").notNull(),
    requestedCallbackUrl: text("requested_callback_url").notNull(),
    requestedScopes: text("requested_scopes")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`)
      .$type<FederatedApplicationConnectionScope[]>(),
    /** SHA-256 of the opaque secret returned only to the requesting app. */
    continuationHash: text("continuation_hash").notNull().unique(),
    /** SHA-256 of the one-time completion code sent to the stored callback. */
    callbackCodeHash: text("callback_code_hash").unique(),
    requestedByUserId: text("requested_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    status: text("status")
      .notNull()
      .default("pending")
      .$type<"pending" | "approved" | "rejected" | "expired">(),
    approvedConnectionId: uuid("approved_connection_id").references(
      () => federatedApplicationConnections.id,
      { onDelete: "set null" }
    ),
    reviewedBy: text("reviewed_by").references(() => users.id, {
      onDelete: "set null",
    }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    decisionReason: text("decision_reason"),
    callbackIssuedAt: timestamp("callback_issued_at", { withTimezone: true }),
    callbackConsumedAt: timestamp("callback_consumed_at", {
      withTimezone: true,
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    requestMetadata: jsonb("request_metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    statusExpiryIdx: index(
      "federated_application_connection_requests_status_expiry_idx"
    ).on(table.status, table.expiresAt),
    issuerClientIdx: index(
      "federated_application_connection_requests_issuer_client_idx"
    ).on(table.issuerUrl, table.clientId),
    nonemptyScopesCheck: check(
      "federated_application_connection_requests_nonempty_scopes_check",
      sql`cardinality(${table.requestedScopes}) > 0`
    ),
  })
);

export type FederatedIdentityLink = typeof federatedIdentityLinks.$inferSelect;
export type FederatedAccessReceipt =
  typeof federatedAccessReceipts.$inferSelect;
export type FederatedAssertionReceipt =
  typeof federatedAssertionReceipts.$inferSelect;
export type IssuerIdentityLinkReceipt =
  typeof issuerIdentityLinkReceipts.$inferSelect;
export type FederatedApplicationConnection =
  typeof federatedApplicationConnections.$inferSelect;
export type FederatedApplicationConnectionRequest =
  typeof federatedApplicationConnectionRequests.$inferSelect;
