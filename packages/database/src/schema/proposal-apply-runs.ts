/**
 * Proposal Apply Runs Schema (0352)
 *
 * ONE ATTEMPT at applying a LARGE approved proposal in the background. The
 * approve door runs every gate in the request (human approver, key grant,
 * app sign-in, review authority, reviewed revision), then — for a composite
 * proposal at or above the background threshold — records a run here and
 * hands it to the `proposal-approve` pg-boss queue. The job applies the
 * proposal through the same approval door and writes its progress back to
 * this row as it goes, so a closed tab, a reload or a proxy timeout never
 * loses it.
 *
 * Read floor = the proposal's (`assertProposalVisibleTo`): the row is read
 * only through its proposal (`proposals.approvalProgress`), never by its id.
 *
 * At most one `queued` / `running` row per proposal
 * (`uq_proposal_apply_runs_active`): a second approve joins the running one.
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
import { proposals } from "./proposals.js";

/** Where a run stands. `stalled` is a READ verdict, never stored. */
export const PROPOSAL_APPLY_RUN_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
] as const;
export type ProposalApplyRunStatus =
  (typeof PROPOSAL_APPLY_RUN_STATUSES)[number];

/** Which pass the materializer is in. */
export const PROPOSAL_APPLY_RUN_PHASES = [
  "entities",
  "relations",
  "finishing",
] as const;
export type ProposalApplyRunPhase = (typeof PROPOSAL_APPLY_RUN_PHASES)[number];

export const proposalApplyRuns = pgTable(
  "proposal_apply_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    proposalId: uuid("proposal_id")
      .notNull()
      .references(() => proposals.id, { onDelete: "cascade" }),
    /** The approver — the authorizer of every row the run creates. */
    userId: text("user_id").notNull(),
    status: text("status", { enum: PROPOSAL_APPLY_RUN_STATUSES })
      .notNull()
      .default("queued"),
    phase: text("phase", { enum: PROPOSAL_APPLY_RUN_PHASES }),
    /** Operations in the proposal; `done` of them have settled. */
    total: integer("total").notNull().default(0),
    done: integer("done").notNull().default(0),
    /** Rows this run created (records + their connections). */
    created: integer("created").notNull().default(0),
    /** Operations resolved onto rows that already existed. */
    linked: integer("linked").notNull().default(0),
    /** Operations that did not land. */
    failed: integer("failed").notNull().default(0),
    /** The approve input the job replays (dispositions, decisions, comment). */
    input: jsonb("input").notNull().default({}),
    /** The app sign-in the approval was made in, for the "approved in" stamp. */
    viaApp: jsonb("via_app"),
    /** The request's workspace header, rebuilt into the job's context. */
    requestWorkspaceId: text("request_workspace_id"),
    /** `revisionHistory.length` the approver reviewed — the job refuses a revised proposal. */
    revision: integer("revision").notNull().default(0),
    jobId: text("job_id"),
    /** A safe, redacted sentence — never raw thrown text. */
    error: text("error"),
    errorClass: text("error_class"),
    /** What the finished approval returned (primaryId, counts). */
    result: jsonb("result"),
    /** Moves with every progress write; a running row whose heartbeat stops is read as stalled. */
    heartbeatAt: timestamp("heartbeat_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", { mode: "date", withTimezone: true }),
    finishedAt: timestamp("finished_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    proposalCreatedIdx: index("idx_proposal_apply_runs_proposal_created").on(
      table.proposalId,
      table.createdAt
    ),
  })
);

export type ProposalApplyRunRow = typeof proposalApplyRuns.$inferSelect;
export type NewProposalApplyRunRow = typeof proposalApplyRuns.$inferInsert;
