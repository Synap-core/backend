/**
 * A STEP THAT IS A PLAYBOOK (runner engine slice 4, spec 7111934d §3.2).
 *
 * A stage that `uses` a playbook is worked by a CHILD RUN of that playbook,
 * pinned at the version the step names. {@link startStageChild} starts it when
 * the stage runner enters the step (`stage-runner.ts`):
 *   - `runPlaybook` with `pinnedVersion`, the `with`-mapped params, the
 *     parent's subject, `parentSessionId` + `suspendedIntent` (the existing
 *     spawn and `blocked_by` edges) and the step's resolved runner (an agent
 *     → `handToAgentId`, Synap AI → `runOn`);
 *   - the child is the PERSON's run, never an agent draft: started with the
 *     owner and no `agentUserId`, because the parent run was already accepted
 *     (an agent naming another agent went through the hand-off gate before);
 *   - its session is stamped `metadata.stageOf` (the parent step);
 *   - the parent's step row waits (`waiting_child`, `child_session_id`) and
 *     the parent PAUSES on the child (`hold.until.moves focus_session:<child>
 *     to closed`, resumed by the existing hold-resume worker).
 *
 * {@link settleStageChild} runs when the child CLOSES (the reactor on
 * `focus_session.closed`, {@link registerStageChildReactor}):
 *   - delivered (`closed`): the parent step's slots get the child's outputs by
 *     label (or `uses.outputs`) through the one slot door
 *     (`satisfyStageSlotsFromChild`), the step row is done; then, when the
 *     NEXT step declares no gate and every required slot of this step is met,
 *     the parent is resumed and advanced into it through the advance door (a
 *     deterministic chain needs no agent turn between steps); otherwise the
 *     parent's agent is told what is missing;
 *   - cancelled or failed: nothing advances. The step's `onFail.toStage`, when
 *     declared, is taken (the dropped child stops blocking: the pod made the
 *     re-plan the author declared); else the hold stays (a dropped blocker
 *     holds until a re-plan, decision 2026-10-22) and the agent is told.
 * Idempotent: only the step row still `waiting_child` is settled (compare and
 * set), so a replayed close does nothing. Never throws.
 */

import {
  and,
  db,
  desc,
  eq,
  focusSessions,
  liveRunStatusWhere,
  playbookRuns,
  setSessionStatus,
  entities,
} from "@synap/database";
import { sessionStageRuns } from "@synap/database/schema";
import type { RunOn } from "@synap-core/types/agents";
import {
  resolveStageGate,
  resolveStageRef,
  type ExpectedOutput,
  type PlaybookStageUses,
} from "@synap/playbooks";
import {
  registerReactor,
  type Reactor,
  type SideEffectPayload,
} from "@synap/events";
import { createLogger } from "@synap-core/core";
import {
  FOCUS_SESSION_CLOSE_ACTION,
  FOCUS_SESSION_SUBJECT_TYPE,
} from "../focus-sessions/close-event.js";
import { readStageOf, type StageOf } from "./stage-of.js";

const logger = createLogger({ module: "playbooks/stage-child" });

/** A stage as a frozen definition carries it (stored jsonb: data). */
interface ChildStage {
  key: string;
  name?: string;
  uses?: PlaybookStageUses;
  expectedOutputs?: unknown;
  onFail?: { toStage?: unknown };
  gate?: unknown;
}

function stagesOf(snapshot: unknown): ChildStage[] {
  const stages = (snapshot as { stages?: unknown } | null)?.stages;
  return Array.isArray(stages)
    ? stages.filter(
        (s): s is ChildStage =>
          !!s &&
          typeof s === "object" &&
          typeof (s as ChildStage).key === "string"
      )
    : [];
}

const nameOf = (s: ChildStage) => s.name?.trim() || s.key;

/** A value at a dotted identifier path (the grammar `uses.with` is checked against). */
function atPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const seg of path.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/**
 * The child's params from `uses.with` (child param ← a parent param, or a
 * path on the parent's subject: `subject.<field>` reads the subject's id,
 * title or a property). Pure. A path that resolves to nothing is left out, so
 * the child's own `required` rule decides (the child is started with `owe`).
 */
export function mapStageChildParams(
  withMap: Record<string, string> | undefined,
  parentParams: Record<string, unknown>,
  subject: Record<string, unknown> | null
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [childParam, path] of Object.entries(withMap ?? {})) {
    const value = path.startsWith("subject.")
      ? subject
        ? atPath(subject, path.slice("subject.".length))
        : undefined
      : atPath(parentParams, path);
    if (value !== undefined) out[childParam] = value;
  }
  return out;
}

/** The parent slots a `uses` step expects back, each with its child label. Pure. */
export function stageChildWanted(
  stage: Pick<ChildStage, "expectedOutputs" | "uses">
): Array<{ parentLabel: string; childLabel: string; required: boolean }> {
  const declared = Array.isArray(stage.expectedOutputs)
    ? (stage.expectedOutputs as ExpectedOutput[])
    : [];
  const mapping = stage.uses?.outputs ?? {};
  return declared
    .filter((o) => typeof o?.label === "string" && o.label.trim())
    .map((o) => ({
      parentLabel: o.label,
      childLabel: mapping[o.label] ?? o.label,
      required: o.required !== false,
    }));
}

/** A pod notice in the session's room (role system): nobody typed it. */
async function roomLine(
  session: { id: string; userId: string; channelId: string | null },
  content: string,
  key: string
): Promise<void> {
  if (!session.channelId) return;
  try {
    const { postChannelMessage } = await import("../messaging/post-message.js");
    await postChannelMessage({
      channelId: session.channelId,
      content,
      userId: session.userId,
      role: "system",
      idempotencyKey: key,
    });
  } catch (err) {
    logger.warn(
      { err, sessionId: session.id },
      "stage child: room line failed"
    );
  }
}

export type StartStageChildResult =
  | { status: "started"; childSessionId: string }
  | { status: "failed"; error: string };

/**
 * Start the child run that works step `stage` of the parent session, then put
 * the step and the parent in their waiting states. `handTo` is the step's
 * resolved runner: an agent id, `"synap_ai"`, or null (nothing named: the
 * child resolves its runner as any fresh run does). Never throws: a refused
 * start leaves the step row `failed` and says why in the room.
 */
export async function startStageChild(p: {
  session: {
    id: string;
    userId: string;
    channelId: string | null;
    workspaceId: string | null;
    status: string;
  };
  stage: ChildStage;
  stageRunId: string;
  handTo: string | null;
  persona?: string | null;
}): Promise<StartStageChildResult> {
  const { session, stage } = p;
  const uses = stage.uses!;
  const stageName = nameOf(stage);
  const fail = async (error: string): Promise<StartStageChildResult> => {
    await db
      .update(sessionStageRuns)
      .set({ status: "failed", endedAt: new Date() })
      .where(eq(sessionStageRuns.id, p.stageRunId));
    await roomLine(
      session,
      `Step ${stageName} could not start its playbook: ${error}`,
      `stage-child:${p.stageRunId}:failed`
    );
    return { status: "failed", error };
  };
  try {
    if (!session.workspaceId) return await fail("the run has no space.");
    const row = await db.query.focusSessions.findFirst({
      columns: { metadata: true, subjectEntityId: true },
      where: eq(focusSessions.id, session.id),
    });
    const { RUN_PARAMS_METADATA_KEY } = await import("./playbook-lifecycle.js");
    const parentParams =
      ((row?.metadata as Record<string, unknown> | null)?.[
        RUN_PARAMS_METADATA_KEY
      ] as Record<string, unknown> | undefined) ?? {};
    let subject: Record<string, unknown> | null = null;
    if (row?.subjectEntityId) {
      const [e] = await db
        .select({
          id: entities.id,
          title: entities.title,
          properties: entities.properties,
        })
        .from(entities)
        .where(eq(entities.id, row.subjectEntityId))
        .limit(1);
      if (e) {
        subject = {
          ...((e.properties as Record<string, unknown> | null) ?? {}),
          id: e.id,
          title: e.title,
        };
      }
    }
    const stageOf: StageOf = {
      sessionId: session.id,
      stageKey: stage.key,
      stageRunId: p.stageRunId,
    };
    const { runPlaybook } = await import("./run-playbook.js");
    const started = await runPlaybook({
      playbookId: uses.playbookId,
      ...(typeof uses.version === "number"
        ? { pinnedVersion: uses.version }
        : {}),
      workspaceId: session.workspaceId,
      // The person's run (never an agent draft): the parent was accepted.
      userId: session.userId,
      params: mapStageChildParams(uses.with, parentParams, subject),
      onMissingRequired: "owe",
      ...(row?.subjectEntityId ? { subjectId: row.subjectEntityId } : {}),
      parentSessionId: session.id,
      suspendedIntent: `Step ${stageName}`,
      stageOf,
      ...(p.handTo === "synap_ai"
        ? { runOn: "synap_ai" as const }
        : p.handTo
          ? { handToAgentId: p.handTo }
          : {}),
      ...(p.persona ? { agentType: p.persona } : {}),
    });
    const child = started.session;
    if (!child) {
      return await fail(
        `nothing was started (${"skipped" in started ? String(started.skipped) : "no session"}).`
      );
    }
    await db
      .update(sessionStageRuns)
      .set({ status: "waiting_child", childSessionId: child.id })
      .where(eq(sessionStageRuns.id, p.stageRunId));
    await roomLine(
      session,
      `Step ${stageName} is its own run: "${child.title ?? child.goal}". This run goes on when it is done.`,
      `stage-child:${p.stageRunId}:started`
    );
    if (session.status === "active" || session.status === "forming") {
      await setSessionStatus(db, {
        sessionId: session.id,
        from: ["active", "forming"],
        to: "paused",
        actor: { kind: "system", userId: session.userId },
        reason: `Step ${stageName} waits for its own run.`,
        hold: {
          on: "agent",
          ref: `focus_session:${child.id}`,
          reason: `Step ${stageName} is worked by its own run.`,
          until: { moves: `focus_session:${child.id}`, to: "closed" },
        },
      }).catch((err: unknown) => {
        // The step row still says it waits; the session stays as it was.
        logger.warn(
          { err, sessionId: session.id },
          "stage child: the pause on the child run was refused"
        );
      });
    }
    return { status: "started", childSessionId: child.id };
  } catch (err) {
    logger.warn(
      { err, sessionId: session.id, stageKey: stage.key },
      "stage child: starting the child run failed"
    );
    return await fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Tell the parent run's agent about its step: a room line always; an agent
 * bound for dispatch through its binding (the one send door); a Synap AI run
 * gets one turn. A pull agent finds it in the room and its orient.
 */
async function tellRunAgent(
  parent: { id: string; userId: string; channelId: string | null },
  runAgent: string | null,
  content: string,
  key: string
): Promise<void> {
  await roomLine(parent, content, key);
  try {
    if (runAgent) {
      const { resolveAgentReach } =
        await import("../agent-dispatch/agent-binding.js");
      if ((await resolveAgentReach(runAgent)) !== "dispatch") return;
      const { wakeExternalAgent } =
        await import("../agent-dispatch/wake-external-agent.js");
      await wakeExternalAgent({
        sessionId: parent.id,
        agentUserId: runAgent,
        kind: "message",
        text: content,
        idempotencyKey: key,
      });
      return;
    }
    if (!parent.channelId) return;
    const { triggerAutoRespond } =
      await import("../../utils/trigger-auto-respond.js");
    await triggerAutoRespond({
      channelId: parent.channelId,
      content,
      sourceUserId: parent.userId,
      focusSessionId: parent.id,
      agentType: "meta",
    });
  } catch (err) {
    logger.warn(
      { err, sessionId: parent.id },
      "stage child: telling the run's agent failed (the room says it)"
    );
  }
}

/** Resume a paused parent (system move, compare and set from `paused`). */
async function resumeParent(parentId: string, userId: string, why: string) {
  await setSessionStatus(db, {
    sessionId: parentId,
    from: ["paused"],
    to: "active",
    actor: { kind: "system", userId },
    reason: why,
  }).catch((err: unknown) => {
    logger.warn({ err, parentId }, "stage child: resuming the parent failed");
  });
}

export type SettleStageChildResult =
  | { status: "not_a_step" | "settled_already" }
  | {
      status: "advanced" | "told" | "on_fail" | "dropped";
      satisfied: string[];
      toStage?: string;
    };

/**
 * A child run that works a step closed: settle the step (see the header).
 * Never throws.
 */
export async function settleStageChild(
  childSessionId: string
): Promise<SettleStageChildResult> {
  try {
    return await settleStageChildUnsafe(childSessionId);
  } catch (err) {
    logger.error(
      { err, childSessionId },
      "stage child: settling the parent step failed"
    );
    return { status: "not_a_step" };
  }
}

async function settleStageChildUnsafe(
  childSessionId: string
): Promise<SettleStageChildResult> {
  const child = await db.query.focusSessions.findFirst({
    columns: {
      id: true,
      userId: true,
      status: true,
      metadata: true,
      title: true,
      goal: true,
    },
    where: eq(focusSessions.id, childSessionId),
  });
  const stageOf = child ? readStageOf(child.metadata) : null;
  if (!child || !stageOf) return { status: "not_a_step" };
  const ended = child.status as string;
  if (ended !== "closed" && ended !== "cancelled" && ended !== "failed") {
    return { status: "not_a_step" };
  }
  const parent = await db.query.focusSessions.findFirst({
    columns: {
      id: true,
      userId: true,
      channelId: true,
      currentStage: true,
      workspaceId: true,
      projectId: true,
      playbookId: true,
      subjectEntityId: true,
      expectedOutputs: true,
    },
    where: and(
      eq(focusSessions.id, stageOf.sessionId),
      // The owner floor: a child stamped for someone else's session is not one.
      eq(focusSessions.userId, child.userId)
    ),
  });
  if (!parent) return { status: "not_a_step" };

  // Compare and set: only the entry still waiting on THIS child is settled.
  const delivered = ended === "closed";
  const [claimed] = await db
    .update(sessionStageRuns)
    .set({
      status: delivered ? "done" : ended === "failed" ? "failed" : "cancelled",
      endedAt: new Date(),
    })
    .where(
      and(
        eq(sessionStageRuns.id, stageOf.stageRunId),
        eq(sessionStageRuns.sessionId, parent.id),
        eq(sessionStageRuns.childSessionId, child.id),
        eq(sessionStageRuns.status, "waiting_child")
      )
    )
    .returning({ id: sessionStageRuns.id });
  if (!claimed) return { status: "settled_already" };

  const [run] = await db
    .select({
      definitionSnapshot: playbookRuns.definitionSnapshot,
      runOn: playbookRuns.runOn,
    })
    .from(playbookRuns)
    .where(
      and(
        eq(playbookRuns.sessionId, parent.id),
        liveRunStatusWhere(playbookRuns.status)
      )
    )
    .orderBy(desc(playbookRuns.startedAt))
    .limit(1);
  const stages = stagesOf(run?.definitionSnapshot);
  const index = stages.findIndex((s) => s.key === stageOf.stageKey);
  const stage = stages[index];
  const runAgent = (run?.runOn as RunOn | null)?.agentUserId ?? null;
  const stageName = stage ? nameOf(stage) : stageOf.stageKey;
  const childName = child.title ?? child.goal ?? "its run";
  const key = `stage-child:${stageOf.stageRunId}:settled`;

  if (!delivered) {
    const toStage = stage
      ? resolveStageRef(
          stages,
          typeof stage.onFail?.toStage === "string"
            ? stage.onFail.toStage
            : null
        )
      : null;
    if (toStage && parent.currentStage === stageOf.stageKey) {
      // The author declared where a failed step goes: the dropped child stops
      // blocking the run, which resumes there.
      const { removeSessionBlocker } =
        await import("../focus-sessions/session-blocked-by.js");
      await removeSessionBlocker({
        sessionId: parent.id,
        blockerSessionId: child.id,
        userId: parent.userId,
      }).catch((err: unknown) =>
        logger.warn({ err }, "stage child: dropping the blocker failed")
      );
      await resumeParent(
        parent.id,
        parent.userId,
        `Step ${stageName}'s run was ${ended}: back to its declared step.`
      );
      const { advanceSessionStage } =
        await import("../focus-sessions/advance-stage.js");
      await advanceSessionStage({
        session: parent,
        toStage,
        userId: parent.userId,
        stageWrite: "door",
        viaOnFail: true,
      });
      await roomLine(
        parent,
        `Step ${stageName}'s run "${childName}" was ${ended}: the run goes back to step ${nameOf(stages.find((s) => s.key === toStage)!)}.`,
        key
      );
      return { status: "on_fail", satisfied: [], toStage };
    }
    await tellRunAgent(
      parent,
      runAgent,
      `Step ${stageName}'s run "${childName}" was ${ended} without delivering. This run waits until it is re-planned: run the step again, or drop the wait on that run and move on.`,
      key
    );
    return { status: "dropped", satisfied: [] };
  }

  const wanted = stage ? stageChildWanted(stage) : [];
  const { satisfyStageSlotsFromChild } =
    await import("../focus-sessions/satisfy-expected-output.js");
  const verdict = await satisfyStageSlotsFromChild({
    sessionId: parent.id,
    userId: parent.userId,
    childSessionId: child.id,
    wanted,
  });
  const satisfied = verdict.satisfied.map((s) => s.label);

  // Every required slot of the step met, read off the parent as it now stands.
  const { findSlotIndex } = await import("../focus-sessions/slot-keys.js");
  const after: ExpectedOutput[] =
    verdict.outputs ??
    (Array.isArray(parent.expectedOutputs)
      ? (parent.expectedOutputs as ExpectedOutput[])
      : []);
  const missing = wanted
    .filter((w) => w.required)
    .filter((w) => {
      const i = findSlotIndex(after, { label: w.parentLabel }, (s) => !!s);
      return i === -1 || after[i]!.status !== "done";
    })
    .map((w) => w.parentLabel);
  const next = index >= 0 ? stages[index + 1] : undefined;
  const nextGated = next ? resolveStageGate(next) !== undefined : false;

  if (
    next &&
    !nextGated &&
    missing.length === 0 &&
    parent.currentStage === stageOf.stageKey
  ) {
    await resumeParent(
      parent.id,
      parent.userId,
      `Step ${stageName}'s run delivered.`
    );
    const { advanceSessionStage } =
      await import("../focus-sessions/advance-stage.js");
    await advanceSessionStage({
      session: parent,
      toStage: next.key,
      userId: parent.userId,
      stageWrite: "door",
    });
    return { status: "advanced", satisfied, toStage: next.key };
  }

  const why = !next
    ? "it was the last step: close the run when it is done."
    : missing.length > 0
      ? `it did not deliver ${missing.join(", ")}: produce ${missing.length === 1 ? "it" : "them"}, then move on.`
      : nextGated
        ? `the next step, ${nameOf(next)}, is gated: move on when it is right to.`
        : "the run moved meanwhile: pick up from where it is.";
  await tellRunAgent(
    parent,
    runAgent,
    `Step ${stageName}'s run "${childName}" is done${satisfied.length > 0 ? ` (delivered ${satisfied.join(", ")})` : ""}; ${why}`,
    key
  );
  return { status: "told", satisfied };
}

/** The reactor: every session close, settled when it is a step's child run. */
export const stageChildReactor: Reactor = {
  id: "stage-child-settle",
  match: (payload: SideEffectPayload) =>
    payload.subjectType === FOCUS_SESSION_SUBJECT_TYPE &&
    payload.action === FOCUS_SESSION_CLOSE_ACTION,
  async handler(payload: SideEffectPayload) {
    const closedId =
      (payload.data?.sessionId as string | undefined) ?? payload.subjectId;
    if (!closedId) return;
    await settleStageChild(closedId);
  },
};

let registered = false;

/** Register the reactor. Called once at boot (`apps/api` side-effect reactors). */
export function registerStageChildReactor(): void {
  if (registered) return;
  registered = true;
  registerReactor(stageChildReactor);
  logger.info("Registered stage child reactor");
}
