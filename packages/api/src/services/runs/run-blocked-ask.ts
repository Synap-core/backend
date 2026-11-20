/**
 * A run NOBODY CLAIMED is the person's to decide (founder, 20 Nov 2026).
 *
 * The run reaper marks a `queued` run its holder never took `blocked`, with
 * the reason and who was passed over (`playbook-run-reaper.ts`). This file
 * reacts to that move: the pod asks the person through the one run ask door
 * (`raiseRunAsk`), so the run shows in Needs you with the reason as the
 * card's `why`. Their answer:
 *   - yes, a Synap AI run: taken back `queued` with a fresh claim window and
 *     dispatched to Synap AI again (`redispatchRun`);
 *   - yes, an agent's run: taken back `queued` with a fresh window, for the
 *     same agent to pick up;
 *   - no: the run is cancelled through the one cancel door (`cancelRun`).
 * A refusal or a run that moved meanwhile (its holder claimed it after all)
 * changes nothing.
 */
import { createLogger } from "@synap-core/core";
import {
  and,
  db,
  desc,
  eq,
  focusSessions,
  playbookRuns,
  runHolder,
  setRunStatus,
} from "@synap/database";
import { registerReactor, type Reactor } from "@synap/events";
import type { ExpectedOutput, SlotAsk } from "@synap/playbooks";
import type { RunHolder } from "@synap-core/types/units";
import { normalizeExpectedLabel } from "../focus-sessions/expected-label.js";
import { raiseRunAsk } from "./run-ask.js";

const logger = createLogger({ module: "run-blocked-ask" });

/** The slot the person is asked on when nobody started a run. */
export const RUN_BLOCKED_SLOT_LABEL = "Nobody started this run";

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

/** Ask the person about a run that just moved to `blocked`. */
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

/** The person's answer on {@link RUN_BLOCKED_SLOT_LABEL}, applied. */
export async function applyBlockedRunAnswer(p: {
  sessionId: string;
  answeredBy: string;
  confirmed: boolean;
}): Promise<"restarted" | "waiting" | "cancelled" | "nothing"> {
  const [run] = await db
    .select()
    .from(playbookRuns)
    .where(
      and(
        eq(playbookRuns.sessionId, p.sessionId),
        eq(playbookRuns.status, "blocked")
      )
    )
    .orderBy(desc(playbookRuns.startedAt))
    .limit(1);
  if (!run) return "nothing";
  if (!p.confirmed) {
    const { cancelRun } = await import("../agent-dispatch/cancel-run.js");
    const out = await cancelRun({ runId: run.id, userId: p.answeredBy });
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
    actor: { kind: "human", userId: p.answeredBy },
    reason: synapAi
      ? "The person asked Synap AI to try again."
      : "The person chose to keep waiting for its agent.",
    set: { holder: runHolder(holder.kind, holder.id) },
  });
  if (!taken) return "nothing";
  if (!synapAi) return "waiting";
  const { redispatchRun } =
    await import("../agent-dispatch/redispatch-on-choice.js");
  await redispatchRun(taken, "is-agent");
  return "restarted";
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
