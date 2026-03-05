/**
 * Compacted States Schema
 *
 * A compacted state is a structured snapshot of everything the AI needs to
 * know at the start of a new session. It is produced by the compaction engine
 * at the end of a session (or asynchronously when a new session starts).
 *
 * Five memory blocks, each with its own token budget:
 *   - identityBlock      (400 tokens): Who the AI is, its persona/style
 *   - userModelBlock     (600 tokens): What the AI knows about the user
 *   - continuityBlock    (800 tokens): Recent narrative history with recency gradient
 *   - activeGoalsBlock   (400 tokens): Current goals, tasks, open requests
 *   - entityContextBlock (800 tokens): Key entities recently interacted with
 *
 * Total: ~3,000 tokens (~2% of a 200K context window)
 *
 * The bootstrap assembler reads the latest compacted state for a channel
 * and assembles a system prompt deterministically — no LLM call required.
 * This replaces the online compressContext() call that ran on every request.
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { channels } from "./channels.js";
import { sessions } from "./sessions.js";

export interface CompactedStateMetadata {
  compactionDurationMs?: number;
  qualityScore?: number; // self-check accuracy (0.0–1.0)
  messagesCompacted?: number;
  midSessionCompaction?: boolean;
  previousStateId?: string;
}

export const compactedStates = pgTable(
  "compacted_states",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // Which channel this state belongs to
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),

    // Which session produced this state (null for initial bootstrap)
    sessionId: uuid("session_id").references(() => sessions.id, {
      onDelete: "set null",
    }),

    // Version — incrementing per channel; highest version = current state
    version: integer("version").notNull().default(1),

    // ── The five memory blocks ─────────────────────────────────────────────────

    // Who the AI is: persona, communication style, user-defined preferences
    identityBlock: text("identity_block").notNull().default(""),

    // What the AI knows about the user: preferences, projects, expertise, style
    userModelBlock: text("user_model_block").notNull().default(""),

    // Narrative history with recency gradient (recent = more detail, old = key facts)
    continuityBlock: text("continuity_block").notNull().default(""),

    // Current goals, tasks, open requests, pending follow-ups
    activeGoalsBlock: text("active_goals_block").notNull().default(""),

    // Key entities recently interacted with and their current context
    entityContextBlock: text("entity_context_block").notNull().default(""),

    // ── Compression metrics ───────────────────────────────────────────────────

    // Token count of the raw messages that were compacted
    rawTokenCount: integer("raw_token_count"),

    // Total token count of all 5 blocks combined
    compressedTokenCount: integer("compressed_token_count"),

    // ── Metadata ──────────────────────────────────────────────────────────────

    // Model used for compaction (e.g. "claude-sonnet-4-5")
    compactionModel: text("compaction_model"),

    // Operational metadata
    metadata: jsonb("metadata").$type<CompactedStateMetadata>(),

    // Timestamp
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    channelVersionIdx: index("compacted_states_channel_version_idx").on(
      table.channelId,
      table.version
    ),
    // Ensure version uniqueness per channel
    uniqueChannelVersion: unique("compacted_states_channel_version_unique").on(
      table.channelId,
      table.version
    ),
  })
);

export type CompactedState = typeof compactedStates.$inferSelect;
export type NewCompactedState = typeof compactedStates.$inferInsert;

export const insertCompactedStateSchema = createInsertSchema(compactedStates);
export const selectCompactedStateSchema = createSelectSchema(compactedStates);
