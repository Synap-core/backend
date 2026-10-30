/**
 * Apps — a developer's application identity (App Connect v1, 2026-10-06).
 *
 * The object a developer registers is an APPLICATION; its `public_id`
 * (`app_<uuid>`) is the app's stable id AND the `client_id` its grant carries
 * (`grants.client_id`). The bearer is an API key (`api_keys`), unchanged — an
 * app never holds a secret of its own beyond the key minted for it.
 *
 * `approved_requests` is what the app ASKED for and a human APPROVED
 * (`[{ permission, workspaceId }]`); it is the exact list the key issue turns
 * into grants — ONE per workspace, never their cross product
 * (`grantsForApprovedRequests`, services/app-connect.ts; client_id = public_id).
 * It is written ONLY by the `app/connect` approval executor — never at register
 * time, so a proposal with no plaintext and a key minted only on demand means
 * no secret ever rests in a proposal.
 *
 * The app acts as its own agent user (`agent_user_id`, 0313) — see
 * `ensureAppAgent` (api services/app-connect.ts).
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
import { users } from "./users.js";

/**
 * One entry of `apps.approved_requests` — a permission bounded to a workspace,
 * or, with `workspaceId: null`, a POD-WIDE read ("everywhere in your pod",
 * founder decision e1b59d38 "B", 2026-10-30). Null is allowed ONLY for a
 * permission `isPodWideReadPermission` accepts: every reader refuses (drops)
 * any other null pair, so a write is always bounded to a workspace.
 */
export interface AppApprovedRequest {
  permission: string;
  workspaceId: string | null;
}

/**
 * The ONE rule for what an app may hold pod-wide (decision e1b59d38 "B"):
 * a READ of ONE named kind, `entity.<kind>.read`. Never a write or a gate
 * verb, never a whole kind (`entity.decision` = every verb), never every kind
 * (`entity.read`, `entity.*.read`), never `*`, never another subject. Checked
 * where an app declares it (the client metadata document), where the person
 * ticks it (consent, the `app/connect` executor), where it is stored and
 * read back (`readAppConnectRequests`) and where it becomes a grant
 * (`grantsForApprovedRequests`).
 */
export function isPodWideReadPermission(permission: string): boolean {
  return /^entity\.[a-z0-9][a-z0-9_-]*\.read$/.test(permission);
}

/**
 * A grant scope that is only a pod-wide read: no space, project or object
 * limit, and every permission `isPodWideReadPermission`. Such a scope reads
 * its kinds everywhere and does nothing else, so the doors that treat a scope
 * with no space as "not limited to spaces" (facet reach, capture routing, a
 * role write, a space-level check) must not count it as one.
 */
export function isPodWideReadScope(scope: {
  permissions: readonly string[];
  workspaceIds?: readonly string[] | null;
  projectIds?: readonly string[] | null;
  entityIds?: readonly string[] | null;
}): boolean {
  return (
    !scope.workspaceIds &&
    !scope.projectIds &&
    !scope.entityIds &&
    scope.permissions.length > 0 &&
    scope.permissions.every(isPodWideReadPermission)
  );
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
    /**
     * `specific` — an App Connect app its developer registered; `oauth` — a
     * pod app connection (0338b): the row a person's consent at the pod's
     * OAuth door made for one app (`oauth_client_id`). CHECK: `oauth` iff
     * `oauth_client_id` is set.
     */
    mode: text("mode")
      .$type<"specific" | "oauth">()
      .notNull()
      .default("specific"),
    /**
     * The pod app's Client ID Metadata Document URL (its OAuth `client_id`),
     * for `mode = 'oauth'` only. One row per (owner, oauth_client_id).
     */
    oauthClientId: text("oauth_client_id"),
    /** Set on approval: `[{ permission, workspaceId }]` (null = pod-wide read). */
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
    /**
     * "Remove for good" (0312): a REVOKED app its owner hid permanently. The
     * row and its events stay; every listing drops it.
     */
    removedAt: timestamp("removed_at", { withTimezone: true }),
    /**
     * The app's OWN agent principal (0313): its key is minted to this user and
     * linked to the owner, so the app's writes are governed like an agent's
     * (`ask-first` by default). Set when its key is first issued. Also the ONE
     * predicate that keeps it out of agent rosters (`notAnAppAgent`).
     */
    agentUserId: text("agent_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /**
     * "Sign in with Synap" (0339): where an authorization code for this app may
     * be delivered — an exact-match allowlist the OWNER sets
     * (`setAppRedirectUris`, api services/app-connect.ts). Empty = the app
     * signs no one in. Read by the pod's OAuth server for an `app_…` client_id.
     */
    redirectUris: text("redirect_uris").array().notNull().default([]),
  },
  (t) => ({
    // One app per (owner, name) — the register door is idempotent by owner+name.
    ownerNameUnique: uniqueIndex("apps_owner_name_unique").on(
      t.ownerUserId,
      t.name
    ),
    ownerIdx: index("apps_owner_idx").on(t.ownerUserId),
    // One pod app connection per (person, app) — the consent door upserts on it.
    ownerOAuthClientUnique: uniqueIndex("apps_owner_oauth_client_uidx")
      .on(t.ownerUserId, t.oauthClientId)
      .where(sql`${t.oauthClientId} IS NOT NULL`),
  })
);

export type AppRecord = typeof apps.$inferSelect;
export type AppInsert = typeof apps.$inferInsert;
