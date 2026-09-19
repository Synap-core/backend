/**
 * Session Evaluations Schema (0267)
 *
 * The GRADE of a session against its criteria (`focus_sessions.criteria`) —
 * one row per criterion per attempt, append-only. Kept off the session row on
 * purpose: a score is a separate record attached to its subject, so the history
 * of how a criterion came to pass (or was overridden by a human) stays readable.
 *
 * Current verdict per criterion = the latest row, except a `human` row wins over
 * any non-human row regardless of time (`latestEvaluationPerCriterion`,
 * @synap-core/types focus-sessions). Written ONLY through
 * `recordSessionEvaluation` (@synap/api services/focus-sessions/evaluations).
 */

import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { focusSessions } from "./focus-sessions.js";

export const sessionEvaluations = pgTable(
  "session_evaluations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => focusSessions.id, { onDelete: "cascade" }),
    /** The session owner — the visibility floor, copied from the session. */
    userId: text("user_id").notNull(),
    /** Copied from the session (text, like `focus_sessions.workspace_id`). */
    workspaceId: text("workspace_id"),
    criterionKey: text("criterion_key").notNull(),
    /** 1-based attempt number for this criterion within the session. */
    attempt: integer("attempt").notNull().default(1),
    verdict: text("verdict", {
      enum: ["pass", "fail", "unmeasured"],
    }).notNull(),
    evaluatorKind: text("evaluator_kind", {
      enum: ["evidence", "capability", "judge", "human"],
    }).notNull(),
    /** Agent id / capability verb / model id / user id. */
    evaluatorId: text("evaluator_id"),
    evidence: jsonb("evidence").notNull().default({}),
    rationale: text("rationale"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    sessionIdIdx: index("idx_session_evaluations_session_id").on(
      table.sessionId
    ),
    sessionCriterionIdx: index("idx_session_evaluations_session_criterion").on(
      table.sessionId,
      table.criterionKey,
      table.createdAt
    ),
  })
);

export type SessionEvaluation = typeof sessionEvaluations.$inferSelect;
export type NewSessionEvaluation = typeof sessionEvaluations.$inferInsert;
