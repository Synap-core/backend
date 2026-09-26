/**
 * Resource Sharing Schema — the per-record LINK + PUBLICATION table (0276).
 *
 * Guests are NOT rows here: a guest is `project_members.role = 'guest'`.
 * A row is either a LINK (`audience = 'link'`, anchored on a project, redeemed
 * into a guest membership) or a PUBLICATION (`audience = 'public'`).
 * DB-enforced by 0276: audience/state CHECKs, a live link needs an anchor, a
 * published row needs `published_at` + a `published_properties` object, one
 * live link per (resource, anchor), one live publication per resource, a
 * unique token-hash index, and REVOKE IS PERMANENT (a BEFORE UPDATE trigger
 * freezes a revoked row).
 */

import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  integer,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";
import { projects } from "./projects.js";
import { documentVersions } from "./documents.js";

export const resourceShares = pgTable("resource_shares", {
  id: uuid("id").defaultRandom().primaryKey(),

  // Resource being shared
  resourceType: text("resource_type").notNull(), // 'view', 'entity', 'workspace'
  resourceId: uuid("resource_id").notNull(),

  // The resource's workspace (NULL for a pod-wide resource).
  workspaceId: uuid("workspace_id").references(() => workspaces.id, {
    onDelete: "cascade",
  }),
  audience: text("audience").notNull().$type<"link" | "public">(),
  // The project a LINK redeems into (NULL for a public row).
  anchorProjectId: uuid("anchor_project_id").references(() => projects.id, {
    onDelete: "cascade",
  }),
  state: text("state")
    .notNull()
    .default("draft")
    .$type<"draft" | "published">(),

  // Publication (audience = 'public', state = 'published').
  publishedAt: timestamp("published_at", { mode: "date", withTimezone: true }),
  publishedBy: text("published_by"),
  /** The pinned revision: the ROW ID of a `document_versions` checkpoint of the
   *  entity's document (a row that stores content). By id, because
   *  (document_id, version) is not unique. NOT `documents.content_revision`.
   *  Optional (a documentless entity / a view has nothing to pin). FK ON DELETE
   *  SET NULL in SQL; the 0276 trigger refuses clearing it on a LIVE published
   *  row, so such a version cannot be deleted. */
  publishedDocumentVersionId: uuid("published_document_version_id").references(
    () => documentVersions.id,
    { onDelete: "set null" }
  ),
  /** SNAPSHOT of the allowlisted property values, copied at publish time:
   *  `{ "<property key>": value }`. The public projection reads ONLY this,
   *  never the live record, so a later edit cannot publish itself. */
  publishedProperties: jsonb("published_properties").$type<
    Record<string, unknown>
  >(),

  /** Display-only prefix of a link token; the token is stored hashed only. */
  tokenPrefix: text("token_prefix"),
  revokedBy: text("revoked_by"),

  // Sharing mode
  /** @deprecated legacy, never written after 0276 */
  visibility: text("visibility").notNull().default("private"),
  // 'private' | 'workspace' | 'invite_only' | 'public'

  // Public link
  /** @deprecated legacy PLAINTEXT token, never written after 0276 (0276 nulls it) */
  publicToken: text("public_token"),
  tokenHash: text("token_hash"),
  /** @deprecated legacy, never written after 0276 */
  passwordHash: text("password_hash"),
  /** @deprecated legacy, never written after 0276 */
  access: text("access").default("anyone_with_link"), // 'workspace_only' | 'anyone_with_link'
  revokedAt: timestamp("revoked_at", { mode: "date", withTimezone: true }),

  // Invited users
  /** @deprecated legacy, never written after 0276 */
  invitedUsers: text("invited_users").array().default([]),

  // Permissions for shared access
  permissions: jsonb("permissions").default({ read: true }),

  // Expiration
  expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }),

  // Metadata
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),

  // Tracking
  /** @deprecated legacy, never written after 0276 */
  viewCount: integer("view_count").default(0),
  lastAccessedAt: timestamp("last_accessed_at", {
    mode: "date",
    withTimezone: true,
  }),
});

// Generate Zod schemas (Single Source of Truth)
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export type ResourceShare = typeof resourceShares.$inferSelect;
export type NewResourceShare = typeof resourceShares.$inferInsert;

/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const insertResourceShareSchema = createInsertSchema(resourceShares);
/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const selectResourceShareSchema = createSelectSchema(resourceShares);
