/**
 * Trusted Issuers — pod-level registry of external services allowed to act on this pod.
 *
 * Replaces environment-based implicit trust with a proper allowlist + approval workflow.
 * Any external service that signs JWTs and
 * presents them to pod provisioning endpoints must appear here with status "approved".
 *
 * Lifecycle: pending → approved (or rejected) → revoked
 * A deployment may seed its own issuer, but no vendor issuer is implied by this schema.
 */
import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Pod-side capabilities granted to an external JWT issuer.
 *
 * Authentication and access mutation are deliberately separate: trusting an
 * issuer to vouch for an already-linked user must never implicitly authorize
 * that issuer to create Pod memberships.
 */
export const TRUSTED_ISSUER_CAPABILITIES = {
  USER_EXCHANGE: "auth:exchange-user",
  IDENTITY_LINK: "identity:link-user",
  MEMBERSHIP_GRANT: "membership:grant",
  /** Create source configuration for a linked, locally authorized user. */
  SOURCE_CONFIG_WRITE: "source-config:write",
  /** @deprecated Use MEMBERSHIP_GRANT for new issuer integrations. */
  MEMBER_ACTIVATION: "membership:activate",
} as const;

export type TrustedIssuerCapability =
  (typeof TRUSTED_ISSUER_CAPABILITIES)[keyof typeof TRUSTED_ISSUER_CAPABILITIES];

export const trustedIssuers = pgTable("trusted_issuers", {
  id: uuid("id").primaryKey().defaultRandom(),
  issuerUrl: text("issuer_url").notNull().unique(),
  displayName: text("display_name").notNull(),
  description: text("description"),
  allowedScopes: text("allowed_scopes")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  status: text("status")
    .notNull()
    .default("pending")
    .$type<"pending" | "approved" | "rejected" | "revoked">(),
  reviewedBy: text("reviewed_by"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  rejectionReason: text("rejection_reason"),
  isBuiltIn: boolean("is_built_in").notNull().default(false),
  initialRequestData: jsonb("initial_request_data"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type TrustedIssuer = typeof trustedIssuers.$inferSelect;
export type TrustedIssuerInsert = typeof trustedIssuers.$inferInsert;
