/**
 * Session Runners Schema (0342)
 *
 * WHO IS ATTACHED to a session right now: one row per (session, client
 * conversation) that held the session's change-feed wait
 * (`synap_wait_for_answer` / Hub `GET /focus-sessions/:id/answers/wait`)
 * while naming its own conversation (`X-Synap-Conversation:
 * <harness>:<id>`, e.g. a Claude Code session bound by synap-bridge).
 *
 * TELEMETRY, like `api_keys.last_used_at`: stamped server-side by the wait
 * itself (`services/focus-sessions/session-runners.ts`), at most once a
 * minute per row, never through governance — it records that a client was
 * listening, it changes nothing a person owns.
 *
 * Kept OFF the `focus_sessions` row on purpose: 0277's row trigger NOTIFYs
 * the session channel on every write there, which would wake the very wait
 * that stamped it — a loop.
 *
 * Since 0384 a row also carries what the runner SAYS it is doing (`state`:
 * busy / idle / needs_permission / ended), reported by any harness adapter on
 * any key-auth call (`X-Synap-Runner-State`).
 *
 * Read floor = the session's (`sessionRunnerReadableWhere`,
 * `access/registry.ts`). `user_id` is the session owner, copied as the
 * visibility floor like `session_evaluations.user_id`.
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";
import { focusSessions } from "./focus-sessions.js";

export const sessionRunners = pgTable(
  "session_runners",
  {
    sessionId: uuid("session_id")
      .notNull()
      .references(() => focusSessions.id, { onDelete: "cascade" }),
    /**
     * The calling client: `key:<apiKeyId>|conv:<conversation>` — the same
     * value sessions stamp as `metadata.clientKey`, so
     * `resolveAgentConversation({ clientKey, conversationCwd: cwd })` reads a
     * runner row exactly as it reads a session.
     */
    clientKey: text("client_key").notNull(),
    /** The session owner — the visibility floor, copied from the session. */
    userId: text("user_id").notNull(),
    /** The agent user acting through the key; NULL for a person's key. */
    agentUserId: text("agent_user_id"),
    /** The key half of `client_key` (no FK: keys are revocable, this is history). */
    apiKeyId: uuid("api_key_id"),
    /** The conversation's harness — the prefix of its id (`claude-code`). */
    harness: text("harness").notNull(),
    /** The harness's own conversation id (Claude Code: the session UUID). */
    conversationId: text("conversation_id").notNull(),
    /** Where the conversation runs, when its client said so. Display only. */
    cwd: text("cwd"),
    /**
     * The computer hosting the agent (`users.id` of the `machine` agent user —
     * MACHINE-IDENTITY-PLAN), when the agent has a host. NULL otherwise.
     */
    machineUserId: text("machine_user_id"),
    /**
     * The OS process holding the wait: `<host>:<pid>:<startedAtMs>`
     * (`X-Synap-Process`, 0373), '' for a client that names none. Part of the
     * key: two live copies of one conversation are two rows. Kept out of
     * `client_key`, which a session also stamps and a resume reads.
     */
    processKey: text("process_key").notNull().default(""),
    /** The computer that process runs on, as it named itself. Display only. */
    processHost: text("process_host"),
    /** When that process started. Display only. */
    processStartedAt: timestamp("process_started_at", {
      mode: "date",
      withTimezone: true,
    }),
    /**
     * What the runner last said it is doing (0384): `busy`, `idle`,
     * `needs_permission` or `ended` (`RUNNER_STATES`, `X-Synap-Runner-State`).
     * NULL for a client that names none.
     */
    state: text("state"),
    /** When the runner entered {@link state}. */
    stateSince: timestamp("state_since", { mode: "date", withTimezone: true }),
    /**
     * When the pod heard the newest state report — the order key: an older
     * report (a long wait's re-stamp) never overwrites a newer one.
     */
    stateReportedAt: timestamp("state_reported_at", {
      mode: "date",
      withTimezone: true,
    }),
    firstSeenAt: timestamp("first_seen_at", {
      mode: "date",
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.sessionId, table.clientKey, table.processKey],
    }),
    sessionSeenIdx: index("idx_session_runners_session_seen").on(
      table.sessionId,
      table.lastSeenAt
    ),
    /** A conversation's process rows, for a state report on a call that is not the wait (0384). */
    clientIdx: index("idx_session_runners_client").on(
      table.clientKey,
      table.processKey
    ),
  })
);

export type SessionRunnerRow = typeof sessionRunners.$inferSelect;
export type NewSessionRunnerRow = typeof sessionRunners.$inferInsert;
