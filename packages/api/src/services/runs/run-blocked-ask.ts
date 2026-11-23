/**
 * A run NOBODY CLAIMED is the person's to decide. The run reaper marks a
 * `queued` run its holder never took `blocked`, with the reason and who was
 * passed over (`playbook-run-reaper.ts`); this file asks the person through
 * the one run ask door (`raiseRunAsk`), the reason as the card's `why`.
 *
 * ONE CARD PER AUTOMATION: the blocked runs an automation started share the
 * card of the first one asked, and the answer applies to all of them. The
 * card chooses who runs it:
 *   - the same runner again, Synap AI's: taken back `queued` with a fresh
 *     window and dispatched again (`redispatchRun`) — unless a turn for its
 *     session still waits in pg-boss, which will claim it: then it only waits;
 *   - the same runner again, an agent's: taken back `queued`, fresh window;
 *   - another runner (Synap AI when the playbook allows it, or another awake
 *     agent bound for dispatch): taken back `queued` for it and dispatched;
 *   - stop: cancelled through the one cancel door (`cancelRun`).
 * A card asked before the choice existed answers yes / no: yes = the same
 * runner, no = stop.
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
  playbooks,
  runHolder,
  setRunStatus,
} from "@synap/database";
import type { SQL } from "drizzle-orm";
import type { PlaybookRun } from "@synap/database/schema";
import { a2aiTurnPendingIn } from "@synap/jobs";
import { registerReactor, type Reactor } from "@synap/events";
import type { ExpectedOutput, SlotAsk } from "@synap/playbooks";
import type { RunHolder } from "@synap-core/types/units";
import {
  askOptionForChip,
  askOptionKey,
  type Ask,
} from "@synap-core/types/ask";
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

/** Who runs a blocked run, as the person picked it. */
export type BlockedRunChoice =
  | { kind: "same" }
  | { kind: "stop" }
  | { kind: "synap_ai" }
  | { kind: "agent"; agentUserId: string };

const SAME = "same";
const STOP = "stop";
const SYNAP_AI = "synap_ai";
/** How many other agents the card offers. */
const OTHER_AGENTS_MAX = 4;

/** The picked option's value, read back into a choice. */
export function blockedRunChoiceOf(value: string): BlockedRunChoice {
  if (value === SAME) return { kind: "same" };
  if (value === STOP) return { kind: "stop" };
  if (value === SYNAP_AI) return { kind: "synap_ai" };
  return { kind: "agent", agentUserId: value };
}

/** Synap AI may run this playbook: it exists and does not run only on agents. */
async function synapAiMayRun(playbookId: string): Promise<boolean> {
  const [playbook] = await db
    .select({ executor: playbooks.executor })
    .from(playbooks)
    .where(eq(playbooks.id, playbookId))
    .limit(1);
  return !!playbook && playbook.executor !== "external-agent";
}

/**
 * The card: the same runner again (recommended), the other runners that can
 * take it now, or stop.
 */
async function askFor(
  run: { playbookId: string; holder: RunHolder | null },
  userId: string
): Promise<SlotAsk> {
  const synapAi = !run.holder || run.holder.kind === "synap_ai";
  const offerSynapAi = !synapAi && (await synapAiMayRun(run.playbookId));
  const { readAgentsForHandoff } =
    await import("../agent-dispatch/agents-for-handoff.js");
  const others = (await readAgentsForHandoff(userId)).agents
    .filter(
      (a) =>
        a.canTakeYourWork &&
        a.reach === "dispatch" &&
        a.wake.state === "awake" &&
        a.agentUserId !== run.holder?.id
    )
    .slice(0, OTHER_AGENTS_MAX);
  return {
    mode: "choose",
    options: [
      synapAi
        ? {
            label: "Try Synap AI again",
            value: SAME,
            recommended: true,
            description: "Synap AI starts the run again now",
          }
        : {
            label: "Keep waiting for its agent",
            value: SAME,
            recommended: true,
            description: "The agent gets another chance to pick it up",
          },
      ...(offerSynapAi
        ? [
            {
              label: "Run it on Synap AI",
              value: SYNAP_AI,
              description: "Synap AI starts the run now",
            },
          ]
        : []),
      ...others.map((a) => ({
        label: a.name?.trim() || "Agent",
        value: a.agentUserId,
        description: "This agent starts the run now",
      })),
      { label: "Stop the run", value: STOP, description: "The run is stopped" },
    ],
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
      playbookId: playbookRuns.playbookId,
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
  const ask = await askFor(
    { playbookId: run.playbookId, holder: run.holder ?? null },
    session.userId
  );
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
    question: `${reason} Who should run it?`.trim(),
    ask,
    idempotencyKey: `run-blocked:${run.id}`,
  });
}

type BlockedAnswer =
  | "restarted"
  | "waiting"
  | "cancelled"
  | "refused"
  | "nothing";

/**
 * The choice a picked chip stands for, only when the session's card OFFERED
 * it (`askOptionForChip`): an answer naming anything else is refused.
 */
export async function offeredBlockedRunChoice(
  sessionId: string,
  chipValue: string
): Promise<BlockedRunChoice | null> {
  const session = await db.query.focusSessions.findFirst({
    columns: { expectedOutputs: true },
    where: eq(focusSessions.id, sessionId),
  });
  const slot = ((session?.expectedOutputs ?? []) as ExpectedOutput[]).find(
    (o) =>
      normalizeExpectedLabel(o?.label) ===
      normalizeExpectedLabel(RUN_BLOCKED_SLOT_LABEL)
  );
  const offered = askOptionForChip(slot?.ask as Ask | undefined, {
    value: chipValue,
  });
  return offered ? blockedRunChoiceOf(askOptionKey(offered)) : null;
}

async function applyToRun(
  run: PlaybookRun,
  answeredBy: string,
  choice: BlockedRunChoice
): Promise<BlockedAnswer> {
  if (choice.kind === "stop") {
    const { cancelRun } = await import("../agent-dispatch/cancel-run.js");
    const out = await cancelRun({ runId: run.id, userId: answeredBy });
    return out.status === "cancelled" ? "cancelled" : "nothing";
  }
  if (choice.kind === "synap_ai" && !(await synapAiMayRun(run.playbookId))) {
    return "refused";
  }
  if (choice.kind === "agent") {
    const {
      rows: [taken],
    } = await setRunStatus(db, {
      runId: run.id,
      from: "blocked",
      to: "queued",
      actor: { kind: "human", userId: answeredBy },
      reason: "The person handed the run to another agent.",
      set: {
        holder: runHolder("agent", choice.agentUserId),
        executor: "external-agent",
        input: {
          ...((run.input as Record<string, unknown> | null) ?? {}),
          agentUserId: choice.agentUserId,
        },
      },
    });
    if (!taken) return "nothing";
    const { redispatchRun } =
      await import("../agent-dispatch/redispatch-on-choice.js");
    await redispatchRun(taken, "external-agent");
    return "restarted";
  }
  const holder =
    choice.kind === "synap_ai"
      ? runHolder("synap_ai", null)
      : (run.holder ?? runHolder("synap_ai", null));
  const synapAi = holder.kind === "synap_ai";
  const {
    rows: [taken],
  } = await setRunStatus(db, {
    runId: run.id,
    from: "blocked",
    to: "queued",
    actor: { kind: "human", userId: answeredBy },
    reason:
      choice.kind === "synap_ai"
        ? "The person handed the run to Synap AI."
        : synapAi
          ? "The person asked Synap AI to try again."
          : "The person chose to keep waiting for its agent.",
    set: {
      holder: runHolder(holder.kind, holder.id),
      ...(choice.kind === "synap_ai" ? { executor: "is-agent" as const } : {}),
    },
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
  choice: BlockedRunChoice;
}): Promise<BlockedAnswer[]> {
  const out: BlockedAnswer[] = [];
  for (const run of await blockedRunsSharing(p.sessionId)) {
    out.push(await applyToRun(run, p.answeredBy, p.choice));
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
      chip?: { label?: string; value?: string };
    } | null;
    const answeredBy =
      (payload.data?.answeredBy as string | undefined) ?? payload.userId;
    const picked = value?.type === "chip" ? value.chip?.value : undefined;
    const choice: BlockedRunChoice | null = picked
      ? await offeredBlockedRunChoice(payload.subjectId, picked)
      : value?.type === "confirm"
        ? { kind: value.confirmed === true ? "same" : "stop" }
        : null;
    if (!choice || !answeredBy) {
      if (picked) {
        logger.warn(
          { sessionId: payload.subjectId, picked },
          "a blocked run's answer named a runner its card did not offer: refused"
        );
      }
      return;
    }
    try {
      const out = await applyBlockedRunAnswer({
        sessionId: payload.subjectId,
        answeredBy,
        choice,
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
