/**
 * A run NOBODY CLAIMED is the person's to decide. The run reaper marks a
 * `queued` run its holder never took `blocked`, with the reason and who was
 * passed over (`playbook-run-reaper.ts`); this file asks the person through
 * the one run ask door (`raiseRunAsk`), the reason as the card's `why`.
 *
 * ONE CARD PER AUTOMATION: the blocked runs an automation started share the
 * card of the first one asked, and the answer applies to all of them.
 *   - yes, Synap AI's: taken back `queued` with a fresh window and dispatched
 *     again (`redispatchRun`) — unless a turn for its session still waits in
 *     pg-boss, which will claim it: then it only waits again;
 *   - yes, an agent's: taken back `queued` with a fresh window;
 *   - no: cancelled through the one cancel door (`cancelRun`).
 * The take-back is a compare-and-set from `blocked`, so a second answer or a
 * redelivered event dispatches nothing. A run that moved meanwhile (claimed
 * after all) is left as it is.
 */
import { createLogger } from "@synap-core/core";
import {
  and,
  db,
  desc,
  drizzleSql,
  eq,
  focusSessions,
  playbookRuns,
  runHolder,
  setRunStatus,
} from "@synap/database";
import type { SQL } from "drizzle-orm";
import type { PlaybookRun } from "@synap/database/schema";
import { a2aiTurnPendingIn } from "@synap/jobs";
import { registerReactor, type Reactor } from "@synap/events";
import type { ExpectedOutput, SlotAsk } from "@synap/playbooks";
import type { RunHolder } from "@synap-core/types/units";
import { normalizeExpectedLabel } from "../focus-sessions/expected-label.js";
import { raiseRunAsk } from "./run-ask.js";
import { rowsOf } from "../../utils/execute-rows.js";

const logger = createLogger({ module: "run-blocked-ask" });

/** The slot the person is asked on when nobody started a run. */
export const RUN_BLOCKED_SLOT_LABEL = "Nobody started this run";

/** SQL text: the automation that opened the session aliased `fs`, or NULL. */
function automationOf(fs: string): SQL {
  const m = drizzleSql.raw(`${fs}.metadata`);
  return drizzleSql`coalesce(
    ${m} ->> 'automationId',
    (SELECT ar.automation_id::text FROM automation_runs ar
      WHERE ar.id::text = ${m} ->> 'automationRunId')
  )`;
}

/** The blocked runs that share `sessionId`'s card: its own, and its automation's. */
async function blockedRunsSharing(sessionId: string): Promise<PlaybookRun[]> {
  return db
    .select()
    .from(playbookRuns)
    .where(
      and(
        eq(playbookRuns.status, "blocked"),
        drizzleSql`${playbookRuns.sessionId} IN (
          SELECT peer.id FROM focus_sessions peer, focus_sessions me
          WHERE me.id = ${sessionId}::uuid
            AND (peer.id = me.id OR ${automationOf("peer")} = ${automationOf("me")})
        )`
      )
    )
    .orderBy(desc(playbookRuns.startedAt));
}

function askFor(holder: RunHolder | null): SlotAsk {
  return holder?.kind === "synap_ai" || !holder
    ? {
        mode: "confirm",
        prompt: "Try Synap AI again?",
        yes: { description: "Synap AI starts the run again now" },
        no: { description: "The run is stopped" },
      }
    : {
        mode: "confirm",
        prompt: "Keep waiting for its agent?",
        yes: { description: "The agent gets another chance to pick it up" },
        no: { description: "The run is stopped" },
      };
}

/**
 * Ask the person about a run that just moved to `blocked` — unless another
 * session of the same automation already holds the open card.
 */
export async function askAboutBlockedRun(
  runId: string,
  reason: string
): Promise<boolean> {
  const [run] = await db
    .select({
      id: playbookRuns.id,
      status: playbookRuns.status,
      holder: playbookRuns.holder,
      sessionId: playbookRuns.sessionId,
    })
    .from(playbookRuns)
    .where(eq(playbookRuns.id, runId))
    .limit(1);
  if (!run || run.status !== "blocked" || !run.sessionId) return false;
  const session = await db.query.focusSessions.findFirst({
    columns: { id: true, userId: true, channelId: true },
    where: eq(focusSessions.id, run.sessionId),
  });
  if (!session) return false;
  const [carded] = await db
    .select({ id: focusSessions.id })
    .from(focusSessions)
    .where(
      drizzleSql`${focusSessions.id} <> ${session.id}::uuid
        AND ${automationOf("focus_sessions")} IS NOT NULL
        AND ${automationOf("focus_sessions")} = (
          SELECT ${automationOf("me")} FROM focus_sessions me WHERE me.id = ${session.id}::uuid
        )
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(${focusSessions.expectedOutputs}) slot
          WHERE slot ->> 'label' = ${RUN_BLOCKED_SLOT_LABEL}
            AND slot ->> 'owner' = 'human'
            AND slot ->> 'status' IS DISTINCT FROM 'done'
        )`
    )
    .limit(1);
  if (carded) return false;
  const ask = askFor(run.holder ?? null);
  return raiseRunAsk({
    runId: run.id,
    session,
    askingAgentUserId: null,
    slot: {
      kind: "decision",
      label: RUN_BLOCKED_SLOT_LABEL,
      status: "pending",
      unblocks: "The run starts, or stops",
    } satisfies ExpectedOutput,
    blockedReason: "decision",
    why: reason,
    question: `${reason} ${ask.mode === "confirm" ? ask.prompt : ""}`.trim(),
    ask,
    idempotencyKey: `run-blocked:${run.id}`,
  });
}

type BlockedAnswer = "restarted" | "waiting" | "cancelled" | "nothing";

async function applyToRun(
  run: PlaybookRun,
  answeredBy: string,
  confirmed: boolean
): Promise<BlockedAnswer> {
  if (!confirmed) {
    const { cancelRun } = await import("../agent-dispatch/cancel-run.js");
    const out = await cancelRun({ runId: run.id, userId: answeredBy });
    return out.status === "cancelled" ? "cancelled" : "nothing";
  }
  const holder = run.holder ?? runHolder("synap_ai", null);
  const synapAi = holder.kind === "synap_ai";
  const {
    rows: [taken],
  } = await setRunStatus(db, {
    runId: run.id,
    from: "blocked",
    to: "queued",
    actor: { kind: "human", userId: answeredBy },
    reason: synapAi
      ? "The person asked Synap AI to try again."
      : "The person chose to keep waiting for its agent.",
    set: { holder: runHolder(holder.kind, holder.id) },
  });
  if (!taken) return "nothing";
  if (!synapAi || !taken.sessionId) return "waiting";
  // A turn still queued for the session claims the run when it starts: a
  // second dispatch would be a second turn on the same run.
  const pending = rowsOf<{ pending: boolean }>(
    await db.execute(
      drizzleSql`SELECT ${a2aiTurnPendingIn(drizzleSql`${taken.sessionId}`)} AS pending`
    )
  )[0]?.pending;
  if (pending) return "waiting";
  const { redispatchRun } =
    await import("../agent-dispatch/redispatch-on-choice.js");
  await redispatchRun(taken, "is-agent");
  return "restarted";
}

/** The person's answer on {@link RUN_BLOCKED_SLOT_LABEL}, applied to every run sharing the card. */
export async function applyBlockedRunAnswer(p: {
  sessionId: string;
  answeredBy: string;
  confirmed: boolean;
}): Promise<BlockedAnswer[]> {
  const out: BlockedAnswer[] = [];
  for (const run of await blockedRunsSharing(p.sessionId)) {
    out.push(await applyToRun(run, p.answeredBy, p.confirmed));
  }
  return out;
}

/** A run moved to `blocked`: ask its person. */
export const runBlockedAskReactor: Reactor = {
  id: "run-blocked-ask",
  match: (payload) =>
    payload.subjectType === "playbook_run" &&
    payload.action === "transition" &&
    payload.data?.to === "blocked",
  async handler(payload) {
    try {
      await askAboutBlockedRun(
        payload.subjectId,
        typeof payload.data?.reason === "string" ? payload.data.reason : ""
      );
    } catch (err) {
      logger.error(
        { err, runId: payload.subjectId },
        "asking the person about a blocked run FAILED"
      );
    }
  },
};

/** The person answered "Nobody started this run". */
export const runBlockedAnswerReactor: Reactor = {
  id: "run-blocked-answer",
  match: (payload) =>
    payload.subjectType === "focus_session" &&
    payload.action === "slot_answered" &&
    normalizeExpectedLabel(
      payload.data?.expectedLabel as string | undefined
    ) === normalizeExpectedLabel(RUN_BLOCKED_SLOT_LABEL),
  async handler(payload) {
    const value = payload.data?.value as {
      type?: string;
      confirmed?: boolean;
    } | null;
    const answeredBy =
      (payload.data?.answeredBy as string | undefined) ?? payload.userId;
    if (value?.type !== "confirm" || !answeredBy) return;
    try {
      const out = await applyBlockedRunAnswer({
        sessionId: payload.subjectId,
        answeredBy,
        confirmed: value.confirmed === true,
      });
      logger.info(
        { sessionId: payload.subjectId, out },
        "blocked run answered"
      );
    } catch (err) {
      logger.error(
        { err, sessionId: payload.subjectId },
        "applying the answer on a blocked run FAILED — the answer is recorded"
      );
    }
  },
};

let registered = false;

/** Register both reactors. Called once at API boot. */
export function registerRunBlockedReactors(): void {
  if (registered) return;
  registered = true;
  registerReactor(runBlockedAskReactor);
  registerReactor(runBlockedAnswerReactor);
}
