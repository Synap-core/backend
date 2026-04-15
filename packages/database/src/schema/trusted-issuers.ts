/**
 * Trusted Issuers — pod-level registry of external services allowed to act on this pod.
 *
 * Replaces the CONTROL_PLANE_URL env var with a proper allowlist + approval workflow.
 * Any external service (control plane, automation provider, etc.) that signs JWTs and
 * presents them to pod provisioning endpoints must appear here with status "approved".
 *
 * Lifecycle: pending → approved (or rejected) → revoked
 * Built-in issuers (Synap Cloud) are seeded on startup with status "approved".
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
