/**
 * Sync Schema — Pod-to-Pod Event Log Replication
 *
 * Three tables:
 * - sync_peers: registered sync targets (push, pull, or bidirectional)
 * - sync_state: cursor tracking per peer (push + pull cursors, error state)
 * - sync_conflicts: audit log for last-write-wins conflict resolutions
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

// ============================================================================
// sync_peers — registered sync targets
// ============================================================================

export const syncPeers = pgTable("sync_peers", {
  id: uuid("id").defaultRandom().primaryKey(),

  /** Full URL of the peer pod (e.g. "https://cloud.example.com") */
  peerPodUrl: text("peer_pod_url").notNull(),

  /** Sync direction from this pod's perspective: "push" | "pull" | "bidirectional" */
  direction: text("direction").notNull(), // "push" | "pull" | "bidirectional"

  /** Whether this peer is actively synced */
  enabled: boolean("enabled").notNull().default(true),

  /** Human-readable label: "Cloud Backup", "Home Server", etc. */
  label: text("label"),

  /** JWT or shared secret for authenticating with the peer */
  authToken: text("auth_token"),

  /** Workspace IDs to sync — null means sync all workspaces */
  workspaceIds: text("workspace_ids").array(),

  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type SyncPeer = typeof syncPeers.$inferSelect;
export type NewSyncPeer = typeof syncPeers.$inferInsert;

export const insertSyncPeerSchema = createInsertSchema(syncPeers);
export const selectSyncPeerSchema = createSelectSchema(syncPeers);

// ============================================================================
// sync_state — cursor tracking per peer
// ============================================================================

export const syncState = pgTable("sync_state", {
  id: uuid("id").defaultRandom().primaryKey(),

  /** Which peer this state tracks */
  syncPeerId: uuid("sync_peer_id")
    .notNull()
    .references(() => syncPeers.id, { onDelete: "cascade" }),

  /** Timestamp of the last event successfully synced (legacy / push-only cursor) */
  lastCursor: timestamp("last_cursor", { withTimezone: true }),

  /** Cursor for outbound push (bidirectional peers track push + pull separately) */
  lastPushCursor: timestamp("last_push_cursor", { withTimezone: true }),

  /** Cursor for inbound pull (bidirectional peers track push + pull separately) */
  lastPullCursor: timestamp("last_pull_cursor", { withTimezone: true }),

  /** When the last sync attempt finished */
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),

  /** Current sync state: "idle" | "syncing" | "error" */
  status: text("status").notNull().default("idle"),

  /** Consecutive error count — stops retrying after threshold */
  errorCount: integer("error_count").notNull().default(0),

  /** Last error message for diagnostics */
  lastError: text("last_error"),

  /** Total events processed for this peer (cumulative) */
  eventsProcessed: integer("events_processed").notNull().default(0),

  /** Per-table cursors for supplementary sync (non-event tables).
   *  Shape: { messages: "2026-03-28T...", automations: "2026-03-28T...", ... } */
  supplementaryCursors: jsonb("supplementary_cursors")
    .$type<Record<string, string>>()
    .default({})
    .notNull(),

  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type SyncState = typeof syncState.$inferSelect;
export type NewSyncState = typeof syncState.$inferInsert;

export const insertSyncStateSchema = createInsertSchema(syncState);
export const selectSyncStateSchema = createSelectSchema(syncState);

// ============================================================================
// sync_conflicts — audit log for last-write-wins conflict resolutions
// ============================================================================

export const syncConflicts = pgTable("sync_conflicts", {
  id: uuid("id").defaultRandom().primaryKey(),

  /** Which peer this conflict occurred with */
  syncPeerId: uuid("sync_peer_id").references(() => syncPeers.id, {
    onDelete: "set null",
  }),

  /** Type of the conflicting subject (e.g. "entity", "view", "document") */
  subjectType: text("subject_type").notNull(),

  /** ID of the conflicting subject */
  subjectId: text("subject_id").notNull(),

  /** Timestamp of the local row at conflict time */
  localTimestamp: timestamp("local_timestamp", { withTimezone: true }),

  /** Timestamp of the incoming remote event */
  remoteTimestamp: timestamp("remote_timestamp", { withTimezone: true }),

  /** How the conflict was resolved: "local_wins" | "remote_wins" */
  resolution: text("resolution").notNull(),

  /** The incoming event data that triggered the conflict */
  eventData: jsonb("event_data"),

  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type SyncConflict = typeof syncConflicts.$inferSelect;
export type NewSyncConflict = typeof syncConflicts.$inferInsert;

export const insertSyncConflictSchema = createInsertSchema(syncConflicts);
export const selectSyncConflictSchema = createSelectSchema(syncConflicts);
