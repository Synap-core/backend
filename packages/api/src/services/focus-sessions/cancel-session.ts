/**
 * CANCEL IS CANCEL — stop what a session (a run) still has in flight, and say
 * exactly what was stopped, what could not be, and what had already finished.
 *
 * The stop is NOT a second close path. It runs inside the ONE close door
 * (`completeFocusSession`, terminalStatus `cancelled`), so every door that
 * cancels a session — tRPC `update`/`cancel`, Hub REST PATCH / `complete` /
 * `cancel`, MCP `synap_complete_session`, triage discard, an approved
 * `focus_session/update` proposal — stops the same work. An agent's cancel that
 * the gate turns into a proposal stops NOTHING until a human approves it.
 *
 * ORDER, and why: the cancel commits FIRST, with the intent recorded
 * (`metadata.run.cancel.state = "stopping"`); the stop runs AFTER the commit,
 * holding no row lock across its calls; the outcome is written second
 * (`state = "done"`). A stop that errors never blocks or rolls back the cancel —
 * it is recorded in `stopFailed[]` with the reason.
 *
 * What a real stop exists for, and nothing more is claimed:
 *   - QUEUED pg-boss jobs whose payload names the session (`sessionId` /
 *     `focusSessionId`) or the session's channel (`channelId` — the IS kickoff
 *     of a playbook run), owner-floored on `data.userId` → cancelled.
 *   - RUNNING chat turns in the session's channel → durable `cancel_requested`
 *     plus the in-process abort when this replica holds the fetch.
 * What has no stop, recorded as `notStoppable` ("will finish"):
 *   - a job pg-boss already handed to a worker (`active`): pg-boss cancel only
 *     relabels the row, the handler keeps running — claiming it stopped is a lie.
 * `notLinked`: import-corpus jobs of this user whose payload names no session —
 *   they cannot be tied to this cancel either way, and are listed rather than
 *   guessed at.
 * `finished` names the proposals that already applied — still revertable
 * through `revertSession`, which is what "undo what finished" means.
 *
 * Each job scan reads at most `JOB_SCAN_LIMIT` rows, and fetches one more to
 * KNOW when it stopped short: an overflow is recorded (`stopFailed` for jobs
 * not stopped, a `notLinked` line for jobs not listed), never truncated silently.
 *
 * Recorded on `metadata.run.cancel` (nested under `run`, so the run manifest
 * written at start survives — `mergeSessionMetadata` is a shallow merge and
 * would replace it).
 */

import {
  db,
  and,
  eq,
  inArray,
  proposals,
  chatTurns,
  drizzleSql,
  focusSessions,
} from "@synap/database";
import type { SQL } from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { IMPORT_CORPUS_QUEUE } from "@synap/jobs/workers/import-corpus-worker.js";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "cancel-session" });

export interface CancelRecordItem {
  kind: "job" | "chat_turn" | "proposal";
  id: string;
  detail: string;
}

export interface SessionCancelOutcome {
  stopped: CancelRecordItem[];
  notStoppable: CancelRecordItem[];
  /** Work that names no session, so it cannot be tied to this cancel. */
  notLinked: CancelRecordItem[];
  /** A stop that errored — the cancel still stands. `id: "*"` = a whole scan. */
  stopFailed: CancelRecordItem[];
  finished: CancelRecordItem[];
}

export interface SessionCancelRecord extends SessionCancelOutcome {
  at: string;
  by: string;
  reason?: string;
  /** `stopping`: committed with the cancel, stop not yet run. `done`: outcome recorded. */
  state: "stopping" | "done";
}

export interface SessionJobRow {
  id: string;
  name: string;
  state: string;
}

export interface StopSessionWorkDeps {
  /** pg-boss `cancel(name, id)`. */
  cancelJob: (name: string, id: string) => Promise<void>;
  /** The durable turn cancel door; resolves to the turn when it was still running. */
  requestTurnCancel: (input: {
    turnId: string;
    userId: string;
  }) => Promise<{ id: string } | undefined>;
  /** In-process abort; true when this replica held the fetch. */
  abortTurn: (turnId: string) => boolean;
}

const QUEUED_STATES = ["created", "retry"];
export const JOB_SCAN_LIMIT = 200;

async function defaultDeps(): Promise<StopSessionWorkDeps> {
  const { getBoss } = await import("@synap/jobs");
  const { requestChatTurnCancellation } =
    await import("../chat-turns/chat-turn-store.js");
  const { abortActiveChatTurn } =
    await import("../chat-turns/chat-turn-runtime.js");
  return {
    cancelJob: (name, id) => getBoss().cancel(name, id),
    requestTurnCancel: requestChatTurnCancellation,
    abortTurn: abortActiveChatTurn,
  };
}

/** postgres-js returns the rows; pglite / node-postgres wrap them in `rows`. */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Queued / retrying / running pg-boss jobs BOUND to a session — the ONE
 * predicate: the cancel door stops these, and the rerun door waits on them
 * (`assessRerunAvailability`). Bound = the owner's job naming the session
 * (`sessionId` / `focusSessionId`) or the session's channel. Throws on a failed
 * read; each caller decides what a failed read means.
 */
export async function listSessionBoundJobs(args: {
  database: typeof db;
  session: { id: string; userId: string; channelId: string | null };
  limit: number;
}): Promise<SessionJobRow[]> {
  const { session } = args;
  const channelMatch = session.channelId
    ? drizzleSql`OR data->>'channelId' = ${session.channelId}`
    : drizzleSql``;
  return rowsOf<SessionJobRow>(
    await args.database.execute(drizzleSql`
      SELECT id::text AS id, name, state::text AS state
      FROM pgboss.job
      WHERE state::text IN ('created', 'retry', 'active')
        AND data->>'userId' = ${session.userId}
        AND (
          data->>'sessionId' = ${session.id}
          OR data->>'focusSessionId' = ${session.id}
          ${channelMatch}
        )
      LIMIT ${args.limit}
    `)
  );
}

/** Chat turns still running in the session's channel. Throws on a failed read. */
export async function listRunningSessionTurns(args: {
  database: typeof db;
  session: { userId: string; channelId: string | null };
}): Promise<Array<{ id: string }>> {
  const { session } = args;
  if (!session.channelId) return [];
  return args.database
    .select({ id: chatTurns.id })
    .from(chatTurns)
    .where(
      and(
        eq(chatTurns.channelId, session.channelId),
        eq(chatTurns.userId, session.userId),
        eq(chatTurns.status, "running")
      )
    );
}

/** Never throws: every failure lands in `stopFailed`. */
export async function stopSessionWork(args: {
  session: { id: string; userId: string; channelId: string | null };
  database?: typeof db;
  deps?: StopSessionWorkDeps;
}): Promise<SessionCancelOutcome> {
  const { session } = args;
  const database = args.database ?? db;
  const out: SessionCancelOutcome = {
    stopped: [],
    notStoppable: [],
    notLinked: [],
    stopFailed: [],
    finished: [],
  };
  const failed = (
    kind: CancelRecordItem["kind"],
    id: string,
    detail: string
  ) => {
    logger.warn(
      { sessionId: session.id, kind, id, detail },
      "cancel: a stop failed"
    );
    out.stopFailed.push({ kind, id, detail });
  };

  let deps: StopSessionWorkDeps | null = args.deps ?? null;
  if (!deps) {
    try {
      deps = await defaultDeps();
    } catch (err) {
      failed("job", "*", `the job queue could not be reached: ${message(err)}`);
    }
  }

  // ── pg-boss jobs bound to this session ─────────────────────────────────────
  try {
    const jobs = await listSessionBoundJobs({
      database,
      session,
      limit: JOB_SCAN_LIMIT + 1,
    });
    if (jobs.length > JOB_SCAN_LIMIT) {
      failed(
        "job",
        "*",
        `more than ${JOB_SCAN_LIMIT} jobs name this session — the rest were not stopped`
      );
    }
    for (const job of jobs.slice(0, JOB_SCAN_LIMIT)) {
      if (!QUEUED_STATES.includes(job.state)) {
        out.notStoppable.push({
          kind: "job",
          id: job.id,
          detail: `${job.name} is already running — it will finish`,
        });
        continue;
      }
      if (!deps) {
        failed(
          "job",
          job.id,
          `${job.name} could not be cancelled: the job queue is unreachable`
        );
        continue;
      }
      try {
        await deps.cancelJob(job.name, job.id);
        out.stopped.push({
          kind: "job",
          id: job.id,
          detail: `${job.name} was queued — cancelled before it started`,
        });
      } catch (err) {
        failed(
          "job",
          job.id,
          `${job.name} could not be cancelled: ${message(err)}`
        );
      }
    }

    // Import-corpus jobs carry no session today — named, never guessed.
    const unlinked = rowsOf<SessionJobRow>(
      await database.execute(drizzleSql`
        SELECT id::text AS id, name, state::text AS state
        FROM pgboss.job
        WHERE name = ${IMPORT_CORPUS_QUEUE}
          AND state::text IN ('created', 'retry', 'active')
          AND data->>'userId' = ${session.userId}
          AND data->>'sessionId' IS NULL
        LIMIT ${JOB_SCAN_LIMIT + 1}
      `)
    );
    for (const job of unlinked.slice(0, JOB_SCAN_LIMIT)) {
      out.notLinked.push({
        kind: "job",
        id: job.id,
        detail: `${job.name} (${job.state}) names no session — it is not linked to this cancel and will run`,
      });
    }
    if (unlinked.length > JOB_SCAN_LIMIT) {
      out.notLinked.push({
        kind: "job",
        id: "*",
        detail: `more than ${JOB_SCAN_LIMIT} import jobs name no session — only the first ${JOB_SCAN_LIMIT} are listed`,
      });
    }
  } catch (err) {
    failed("job", "*", `queued jobs could not be listed: ${message(err)}`);
  }

  // ── running chat turns in the session's channel ────────────────────────────
  if (session.channelId) {
    try {
      const turns = await listRunningSessionTurns({ database, session });
      for (const turn of turns) {
        if (!deps) {
          failed(
            "chat_turn",
            turn.id,
            "the reply could not be stopped: the stop door is unreachable"
          );
          continue;
        }
        try {
          const requested = await deps.requestTurnCancel({
            turnId: turn.id,
            userId: session.userId,
          });
          if (!requested) continue; // finished between the read and the cancel
          const aborted = deps.abortTurn(turn.id);
          out.stopped.push({
            kind: "chat_turn",
            id: turn.id,
            detail: aborted
              ? "the agent's reply was stopped"
              : "the agent's reply was asked to stop (another server holds it)",
          });
        } catch (err) {
          failed(
            "chat_turn",
            turn.id,
            `the reply could not be stopped: ${message(err)}`
          );
        }
      }
    } catch (err) {
      failed(
        "chat_turn",
        "*",
        `running replies could not be listed: ${message(err)}`
      );
    }
  }

  // ── what had already landed ────────────────────────────────────────────────
  try {
    const applied = await database
      .select({ id: proposals.id, status: proposals.status })
      .from(proposals)
      .where(
        and(
          eq(proposals.sessionId, session.id),
          inArray(proposals.status, [
            ProposalStatus.APPROVED,
            ProposalStatus.AUTO_APPROVED,
          ])
        )
      );
    out.finished = applied.map((p) => ({
      kind: "proposal" as const,
      id: p.id,
      detail: `already applied (${p.status}) — revert the session to undo it`,
    }));
  } catch (err) {
    failed(
      "proposal",
      "*",
      `applied proposals could not be listed: ${message(err)}`
    );
  }

  return out;
}

/**
 * `metadata.run.cancel = record`, keeping every other key of `metadata.run`
 * (the manifest) and of `metadata`.
 */
export function cancelRecordMetadataSql(record: SessionCancelRecord): SQL {
  return drizzleSql`jsonb_set(
    coalesce(${focusSessions.metadata}, '{}'::jsonb),
    '{run}',
    coalesce(${focusSessions.metadata}->'run', '{}'::jsonb)
      || jsonb_build_object('cancel', ${JSON.stringify(record)}::jsonb),
    true
  )`;
}

/**
 * Cancel a session — the verb-shaped door over the ONE close door. Governance,
 * the stop and the record all live in `completeFocusSession`.
 */
export async function cancelSession(args: {
  sessionId: string;
  userId: string;
  agentUserId?: string;
  reason?: string;
}) {
  const { completeFocusSession } = await import("./complete-session.js");
  return completeFocusSession({
    sessionId: args.sessionId,
    userId: args.userId,
    agentUserId: args.agentUserId,
    terminalStatus: "cancelled",
    ...(args.reason ? { cancelReason: args.reason } : {}),
  });
}
