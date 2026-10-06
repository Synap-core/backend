/**
 * Apps — a developer's application identity (App Connect v1, 2026-10-06).
 *
 * The object a developer registers is an APPLICATION; its `public_id`
 * (`app_<uuid>`) is the app's stable id AND the `client_id` its grant carries
 * (`grants.client_id`). The bearer is an API key (`api_keys`), unchanged — an
 * app never holds a secret of its own beyond the key minted for it.
 *
 * `approved_requests` is what the app ASKED for and a human APPROVED
 * (`[{ permission, workspaceId }]`); it is the exact list the `/apps/:id/key`
 * mint turns into a grant (`attaches the grant with client_id = public_id`).
 * It is written ONLY by the `app/connect` approval executor — never at register
 * time, so a proposal with no plaintext and a key minted only on demand means
 * no secret ever rests in a proposal.
 *
 * ONE write door: `AppRepository` (repositories/app-repository.ts).
 */

import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/** One entry of `apps.approved_requests` — a permission bounded to a workspace. */
export interface AppApprovedRequest {
  permission: string;
  workspaceId: string;
}

export const apps = pgTable(
  "apps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The human who owns the app. */
    ownerUserId: text("owner_user_id").notNull(),
    /** `app_<uuid>` — the app's stable id AND its `client_id`. */
    publicId: text("public_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    logoUrl: text("logo_url"),
    /** v1 supports ONLY `specific` (no global mode, no runtime OAuth). */
    mode: text("mode").notNull().default("specific"),
    /** Set on approval: `[{ permission, workspaceId }]`. */
    approvedRequests: jsonb("approved_requests").$type<
      AppApprovedRequest[] | null
    >(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => ({
    // One app per (owner, name) — the register door is idempotent by owner+name.
    ownerNameUnique: uniqueIndex("apps_owner_name_unique").on(
      t.ownerUserId,
      t.name
    ),
    ownerIdx: index("apps_owner_idx").on(t.ownerUserId),
  })
);

export type AppRecord = typeof apps.$inferSelect;
export type AppInsert = typeof apps.$inferInsert;
