/**
 * Sync Generation Schema — Split-Brain Prevention
 *
 * Tracks write epochs for dual-pod redundancy. During sync, pods exchange
 * their current generation counter. If both advance during a network partition,
 * split-brain is detected and the pod with fewer writes enters read-only mode.
 */

import { pgTable, text, bigint, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const syncGeneration = pgTable("sync_generation", {
  /** Singleton row key — always 'current' */
  id: text("id").primaryKey().default("current"),

  /** Monotonically increasing write epoch counter */
  generation: bigint("generation", { mode: "number" }).notNull().default(0),

  /** Pod role: 'primary' | 'replica' | 'standalone' | 'readonly' */
  role: text("role").notNull().default("primary"),

  /** When this pod was last promoted to primary */
  promotedAt: timestamp("promoted_at", { withTimezone: true }),

  /** Pod ID of the old primary (when this pod was promoted from replica) */
  promotedFrom: text("promoted_from"),

  /** Last known generation of the peer pod */
  lastPeerGeneration: bigint("last_peer_generation", {
    mode: "number",
  }).default(0),

  /** When we last heard from the peer pod */
  lastPeerContact: timestamp("last_peer_contact", { withTimezone: true }),

  /** Whether split-brain has been detected and not yet resolved */
  splitBrainDetected: boolean("split_brain_detected").notNull().default(false),

  /** When split-brain was detected */
  splitBrainDetectedAt: timestamp("split_brain_detected_at", {
    withTimezone: true,
  }),

  /** Local generation at time of split-brain detection */
  splitBrainLocalGen: bigint("split_brain_local_gen", { mode: "number" }),

  /** Remote generation at time of split-brain detection */
  splitBrainRemoteGen: bigint("split_brain_remote_gen", { mode: "number" }),

  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type SyncGenerationRow = typeof syncGeneration.$inferSelect;
export type NewSyncGenerationRow = typeof syncGeneration.$inferInsert;

export const insertSyncGenerationSchema = createInsertSchema(syncGeneration);
export const selectSyncGenerationSchema = createSelectSchema(syncGeneration);
