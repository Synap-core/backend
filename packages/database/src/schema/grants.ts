/**
 * Grants — what ONE credential may touch (W1, 2026-10-06).
 *
 * The API key stays the bearer (auth, hashing, revocation live on `api_keys`);
 * the grant bounds what that bearer may do. Effective access is always
 * grant ∩ the human floor (memberships, project roles, shares) — a grant never
 * widens anything, and it permits rather than auto-approves.
 *
 *   permissions   — patterns in the governance event-key grammar with a kind
 *                   qualifier: `entity.knowledge.read`, `entity.*.read`, `*`
 *                   (`@synap/governance-policy/grants`).
 *   workspace_ids / project_ids / entity_ids — NULL = no narrowing on that axis.
 *   expires_at    — NULL = never (an explicit choice; the default is 90 days).
 *
 * ONE write door: `GrantRepository` (repositories/grant-repository.ts).
 * A key with no active grant keeps the legacy behaviour (scopes + human floor).
 * Design: CONNECT-RESEARCH/13-w1-grants-design-2026-10-06.md.
 */

import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { apiKeys } from "./api-keys.js";

export const grants = pgTable(
  "grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    apiKeyId: uuid("api_key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    /** `api_keys.user_id` — the agent or human holding the key. */
    principalUserId: text("principal_user_id").notNull(),
    /** The human whose floor bounds this grant. */
    onBehalfOf: text("on_behalf_of").notNull(),
    permissions: text("permissions")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    workspaceIds: uuid("workspace_ids").array(),
    projectIds: uuid("project_ids").array(),
    entityIds: uuid("entity_ids").array(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** What the person named it ("Portfolio site"). */
    label: text("label"),
    /** OAuth client / app identity (W2). */
    clientId: text("client_id"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: text("revoked_by"),
  },
  (t) => ({
    apiKeyIdx: index("grants_api_key_idx").on(t.apiKeyId),
    onBehalfIdx: index("grants_on_behalf_of_idx").on(t.onBehalfOf),
  })
);

export type GrantRecord = typeof grants.$inferSelect;
export type GrantInsert = typeof grants.$inferInsert;
