/**
 * Agent Conversations Schema (0354)
 *
 * THE ONE REGISTRY OF LIVE AGENT TERMINALS: one row per (person, computer,
 * harness, conversation) — a Claude Code terminal on the Mac, a CLI
 * conversation on the devbox — whether or not it is bound to a session.
 *
 * TELEMETRY, like `api_keys.last_used_at` and `session_runners` (0342):
 * written by the heartbeat door (Hub `POST /conversations/heartbeat`,
 * `services/agent-conversations/`), an idempotent upsert, never through
 * governance — it records that a terminal is open and changes nothing a
 * person owns.
 *
 * Its link to sessions is `session_runners`, joined on
 * (harness, conversation_id) — no session column here, never a second link.
 *
 * NEVER stored: prompt text, pid, tty, resume paths, tokens, full folder
 * paths, account labels. The heartbeat codec refuses unknown fields and
 * reduces `folder` to a basename before any write.
 *
 * Read floor = the owner (`user_id`, `access/registry.ts`).
 */

import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/** The states a terminal reports. Mirrored by the 0354 CHECK constraint. */
export const AGENT_CONVERSATION_STATES = [
  "working",
  "idle",
  "waiting",
] as const;
export type AgentConversationState = (typeof AGENT_CONVERSATION_STATES)[number];

export const agentConversations = pgTable(
  "agent_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The person the reporting key acts for — the visibility floor. */
    userId: text("user_id").notNull(),
    /** The agent acting through the key; NULL for a person's key. */
    agentUserId: text("agent_user_id"),
    /** The reporting key (no FK: keys are revocable, this is history). */
    apiKeyId: uuid("api_key_id"),
    /**
     * The computer's principal (`users.id` of the `machine` agent user —
     * MACHINE-IDENTITY-PLAN), derived server-side from the key's agent.
     */
    machineUserId: text("machine_user_id"),
    /** The computer's normalised short host name, as its reporter sent it. */
    computer: text("computer").notNull(),
    /** The conversation's harness (`claude-code`). */
    harness: text("harness").notNull(),
    /** The harness's own conversation id (Claude Code: the session UUID). */
    conversationId: text("conversation_id").notNull(),
    /** The basename of the folder it runs in — never a path. */
    folder: text("folder"),
    state: text("state").$type<AgentConversationState>().notNull(),
    /** When `state` last changed (server clock). */
    stateSince: timestamp("state_since", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    subagentCount: integer("subagent_count").notNull().default(0),
    firstSeenAt: timestamp("first_seen_at", {
      mode: "date",
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Set by a heartbeat with `ended: true`; cleared if it is resumed. */
    endedAt: timestamp("ended_at", { mode: "date", withTimezone: true }),
  },
  (table) => ({
    identity: uniqueIndex("uq_agent_conversations_identity").on(
      table.userId,
      table.computer,
      table.harness,
      table.conversationId
    ),
    userSeenIdx: index("idx_agent_conversations_user_seen").on(
      table.userId,
      table.lastSeenAt
    ),
  })
);

export type AgentConversationRow = typeof agentConversations.$inferSelect;
export type NewAgentConversationRow = typeof agentConversations.$inferInsert;
