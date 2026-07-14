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

export type FederatedIdentityLink = typeof federatedIdentityLinks.$inferSelect;
export type FederatedAccessReceipt =
  typeof federatedAccessReceipts.$inferSelect;
export type FederatedAssertionReceipt =
  typeof federatedAssertionReceipts.$inferSelect;
export type IssuerIdentityLinkReceipt =
  typeof issuerIdentityLinkReceipts.$inferSelect;
