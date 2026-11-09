/**
 * THE STAGE RUNNER — where a step of a playbook run STARTS (runner engine
 * slice 3; spec document 7111934d §3.1, §3.3, §5; founder decision 72fdca0b).
 *
 * One function, {@link enterStage}, called where a stage really begins to run
 * (the callers are pinned by `__tripwires__/stage-runner-entry.test.ts`):
 *   - the advance door (`advanceSessionStage`) once the stage stands and no
 *     gate holds it (ungated, or a check gate that passed);
 *   - a gate that passes later: the human-gate approval executor
 *     (`playbook-stage-gate`) and `resumeCheckGateIfMet`;
 *   - birth: stage 0, where a run's ledger row is written (`runPlaybook`,
 *     `createFocusSession` with a playbook, `followPlaybook`).
 *
 * It writes ONE `session_stage_runs` row per entry, for every run (decision
 * D4: "who is on it now" and "who did each step" have one source), then:
 *   - the step names nobody else (no `runner`, or `"self"`, or a runner that
 *     resolves to the run's own agent): nothing else changes;
 *   - another agent takes it: a TURN ON THE SAME SESSION — the agent joins the
 *     roster through the one append door (`attachSessionAgent`; a pull agent
 *     then finds it in orient's `handedToYou`) and a room line says who has the
 *     step. A runner named at the advance by an AGENT for another agent goes
 *     through the hand-off gate first (`gateAgentHandOff`), as `addAgentId`
 *     does;
 *   - Synap AI takes it while the run's own agent is an external one: ONE IS
 *     turn through the one turn door (`triggerAutoRespond`);
 *   - nobody can take it: the person picks — an owed `decision` slot (never
 *     an AI picker, the route's rung 5);
 *   - its runner's computer lacks a tool it `requires`: ONE install request
 *     per missing tool, filed by the pod for the person (`requestInstallation`
 *     with `filedByPod`: always a proposal); the row waits (`waiting_tools`)
 *     and the session pauses on the first proposal (`proposal:<id>`). It is
 *     checked again ({@link recheckStageTools}) when that hold resumes and
 *     when an install it waits on moves (`moveInstallation`).
 *
 * The step is read from the run's FROZEN definition (`definition_snapshot`),
 * never the live playbook: a run follows what it started with (as
 * `stage-gate.ts` does). Never throws: a failure is logged and returned, the
 * advance that called it stands (like the `stage_changed` emit).
 */

import {
  and,
  db,
  desc,
  eq,
  focusSessions,
  inArray,
  liveRunStatusWhere,
  playbookRuns,
  setSessionStatus,
  drizzleSql,
  users,
} from "@synap/database";
import {
  OPEN_STAGE_RUN_STATUSES,
  sessionStageRuns,
  type PlaybookRunExternalAgent,
  type SessionStageRun,
  type StageRunnerVia,
} from "@synap/database/schema";
import type { RunOn, RunnerPassedOver } from "@synap-core/types/agents";
import {
  runnerChoices,
  type ExpectedOutput,
  type PlaybookRunner,
  type PlaybookStage,
  type PlaybookStageUses,
  type SlotAsk,
} from "@synap/playbooks";
import { createLogger } from "@synap-core/core";
import { requiresOnComputer, resolveRunner } from "../agent-dispatch/runner.js";

const logger = createLogger({ module: "playbooks/stage-runner" });

/** Why a stage is entered: an advance, a gate that passed later, or birth. */
export type EnterStageCause =
  | {
      kind: "advance";
      /** A runner named for THIS entry (`synap_update_session { stageRunner }`). */
      stageRunner?: PlaybookRunner | null;
      /** The agent key that drove the advance, if any (the hand-off gate). */
      agentUserId?: string | null;
    }
  | { kind: "gate_passed" }
  | { kind: "birth" };

/** What happened to the step's runner when it was entered. */
export type StageHandOff =
  | "none" // the run's own agent works it
  | "attached" // another agent joined the session and has the step
  | "proposed" // an agent named another agent: the hand-off waits for the person
  | "refused" // the hand-off was refused (the route's words in `reason`)
  | "synap_ai_turn" // Synap AI was given a turn on the session
  | "nobody"; // nobody could take it: the person picks

export interface EnterStageResult {
  status: "entered" | "no_run" | "no_stage" | "failed";
  stageRunId?: string;
  runnerAgentUserId?: string | null;
  via?: StageRunnerVia;
  handOff?: StageHandOff;
  /** The hand-off's proposal, or why it was refused. */
  proposalId?: string;
  reason?: string;
  /** A step that `uses` a playbook: the child run's session that works it. */
  childSessionId?: string;
  /** The tools it waits on (`waiting_tools`), with their install asks. */
  waitingTools?: string[];
  /**
   * An agent bound for dispatch: how the step reached it — sent into its
   * live task, a task started for the step, a start waiting for approval, or
   * failed (the room says why).
   */
  reached?: DispatchReach;
  error?: string;
}

/** One required tool, as the row reports it. */
interface RequiresEntry {
  state: "installed" | "missing" | "unverified";
  proposalId?: string;
  installationId?: string;
  refused?: string;
}

/** A stage as a frozen definition carries it (stored jsonb: data). */
interface SnapshotStage {
  key: string;
  name?: string;
  runner?: PlaybookRunner;
  requires?: unknown;
  /** The step IS this playbook (slice 4): a child run works it. */
  uses?: PlaybookStageUses;
}

/** The label of the slot the person answers when nobody can take a step. */
export function stageRunnerSlotLabel(stageName: string): string {
  return `Who works step ${stageName}`;
}

function stringsOf(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((k): k is string => typeof k === "string")
    : [];
}

function readStages(snapshot: unknown): SnapshotStage[] {
  const stages = (snapshot as { stages?: unknown } | null)?.stages;
  return Array.isArray(stages)
    ? stages.filter(
        (s): s is SnapshotStage =>
          !!s &&
          typeof s === "object" &&
          typeof (s as SnapshotStage).key === "string"
      )
    : [];
}

/** The runner a run named for each step at Run (`stageRunners`, stored on its input). */
function runChoiceFor(input: unknown, stageKey: string): PlaybookRunner | null {
  const map = (input as { stageRunners?: unknown } | null)?.stageRunners;
  if (!map || typeof map !== "object") return null;
  const r = (map as Record<string, unknown>)[stageKey];
  return r === undefined || r === null ? null : (r as PlaybookRunner);
}

async function computerName(
  computerUserId: string | null
): Promise<string | null> {
  if (!computerUserId) return null;
  const [row] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, computerUserId))
    .limit(1);
  return row?.name?.trim() || null;
}

/** A pod notice in the session's room (role system): nobody typed it. */
async function roomLine(
  session: { id: string; userId: string; channelId: string | null },
  content: string,
  key: string
): Promise<string | null> {
  if (!session.channelId) return null;
  try {
    const { postChannelMessage } = await import("../messaging/post-message.js");
    const posted = await postChannelMessage({
      channelId: session.channelId,
      content,
      userId: session.userId,
      role: "system",
      idempotencyKey: key,
    });
    return posted.messageId ?? null;
  } catch (err) {
    logger.warn(
      { err, sessionId: session.id },
      "stage runner: room line failed"
    );
    return null;
  }
}

/**
 * Ask for each MISSING tool (never an `unverified` one) on `computerUserId`,
 * filed by the pod for the person: always one proposal per tool.
 */
async function askForTools(p: {
  ownerId: string;
  sessionId: string;
  computerUserId: string | null;
  stageName: string;
  report: Record<string, RequiresEntry>;
}): Promise<string[]> {
  const missing = Object.entries(p.report)
    .filter(([, e]) => e.state === "missing")
    .map(([k]) => k);
  if (missing.length === 0 || !p.computerUserId) return [];
  const { loadPersonsComputer } =
    await import("../installations/installations.js");
  const { requestInstallation } =
    await import("../installations/request-installation.js");
  const computer = await loadPersonsComputer(p.ownerId, p.computerUserId);
  if (!computer) return [];
  const proposals: string[] = [];
  for (const key of missing) {
    try {
      const ask = await requestInstallation({
        userId: p.ownerId,
        agentUserId: null,
        computer,
        capabilityKey: key,
        action: "install",
        sessionId: p.sessionId,
        fromCatalog: true,
        filedByPod: {
          author: "system:stage-runner",
          reasoning: `Step ${p.stageName} needs ${key} on ${computer.name}.`,
        },
      });
      if (ask.status === "proposed") {
        p.report[key] = { ...p.report[key]!, proposalId: ask.proposalId };
        proposals.push(ask.proposalId);
      } else if (ask.status === "approved") {
        p.report[key] = {
          ...p.report[key]!,
          installationId: ask.installationId,
        };
      } else {
        p.report[key] = { ...p.report[key]!, refused: ask.error };
      }
    } catch (err) {
      logger.warn({ err, key }, "stage runner: install request failed");
      p.report[key] = {
        ...p.report[key]!,
        refused: err instanceof Error ? err.message : String(err),
      };
    }
  }
  return proposals;
}

/** The person picks who works a step nobody can take (an owed decision slot). */
async function askWhoWorksIt(p: {
  session: { id: string; userId: string };
  runId: string;
  stageName: string;
  passedOver: RunnerPassedOver[];
}): Promise<void> {
  const label = stageRunnerSlotLabel(p.stageName);
  const { updateExpectedOutputsLocked } =
    await import("../focus-sessions/delegate-output.js");
  const { normalizeExpectedLabel } =
    await import("../focus-sessions/expected-label.js");
  const { blockExpectedOutput } =
    await import("../focus-sessions/block-output.js");
  const wanted = normalizeExpectedLabel(label);
  const declared = await updateExpectedOutputsLocked(
    p.session.id,
    (current) => [
      ...current.filter((o) => normalizeExpectedLabel(o?.label) !== wanted),
      {
        kind: "decision",
        label,
        status: "pending",
        unblocks: `Step ${p.stageName} goes on`,
      } satisfies ExpectedOutput,
    ]
  );
  if (!declared) return;
  const why = `None of the runners step ${p.stageName} names can take it now (${p.passedOver
    .map(
      (o) =>
        `${o.name ?? "choice " + (o.choice + 1)}: ${o.why.replace(/_/g, " ")}`
    )
    .join("; ")}).`;
  const ask: SlotAsk = {
    mode: "confirm",
    prompt: `Should the run's own agent do step ${p.stageName}?`,
    yes: { description: "The run's agent does this step" },
    no: { description: "Name another agent for it in the session" },
  };
  await blockExpectedOutput({
    sessionId: p.session.id,
    userId: p.session.userId,
    expectedLabel: label,
    blockedReason: "decision",
    why,
    ask,
    askCause: { kind: "run", ref: { kind: "run", id: p.runId } },
  });
}

/** How a step reached an agent bound for dispatch. */
export type DispatchReach = "sent" | "started" | "proposed" | "failed";

/**
 * Send a step to the agent bound for dispatch that works it, through its
 * binding, governed and attributed to the agent exactly as a run hand-off:
 *   - the agent already works in a provider task for this session (the run's,
 *     or an earlier step's): the step goes INTO it (`wakeExternalAgent`, the
 *     one send door), keyed per stage-run row;
 *   - else a provider task is STARTED for the step (`startAgentTask`, THE
 *     start path the run executor uses): its goal, the playbook's method for
 *     this stage, the session and room.
 * The row records the task; a start waiting for approval leaves it
 * `waiting_start` with the review link in the room; a failed send or start
 * leaves it `unreached` and the room says why — never `running` over a
 * delivery nothing received.
 */
async function reachDispatchAgent(p: {
  session: {
    id: string;
    userId: string;
    channelId: string | null;
    goal: string | null;
    playbookId: string | null;
  };
  runId: string;
  stage: SnapshotStage;
  stageName: string;
  stageRunId: string;
  agentUserId: string;
}): Promise<DispatchReach> {
  const { session } = p;
  const stageGoal =
    typeof (p.stage as { goal?: unknown }).goal === "string" &&
    ((p.stage as { goal?: string }).goal ?? "").trim()
      ? (p.stage as { goal: string }).goal.trim()
      : null;
  const goal = `Step ${p.stageName} of: ${session.goal ?? "this session"}${
    stageGoal ? `\n\n${stageGoal}` : ""
  }`;
  const mark = (
    status: "running" | "waiting_start" | "unreached",
    externalAgent?: PlaybookRunExternalAgent
  ) =>
    db
      .update(sessionStageRuns)
      .set({ status, ...(externalAgent ? { externalAgent } : {}) })
      .where(eq(sessionStageRuns.id, p.stageRunId));

  const { dispatchedTaskFor, wakeExternalAgent } =
    await import("../agent-dispatch/wake-external-agent.js");
  const live = await dispatchedTaskFor(session.id, p.agentUserId);
  if (live) {
    const sent = await wakeExternalAgent({
      sessionId: session.id,
      agentUserId: p.agentUserId,
      kind: "message",
      text: goal,
      idempotencyKey: `stage:${p.stageRunId}`,
    });
    if (sent.status === "sent") {
      await mark("running", live.ext);
      return "sent";
    }
    // The wake door already said why in the room.
    if (sent.status === "proposed") {
      await mark("waiting_start", live.ext);
      return "proposed";
    }
    if (sent.status === "failed") {
      await mark("unreached");
      return "failed";
    }
    // not_dispatch: no task after all — start one.
  }

  const { startAgentTask } =
    await import("./executors/external-agent-executor.js");
  const started = await startAgentTask({
    agentUserId: p.agentUserId,
    ownerId: session.userId,
    userId: session.userId,
    playbookId: session.playbookId,
    sessionId: session.id,
    channelId: session.channelId,
    runId: p.runId,
    goal,
    stage: p.stage as unknown as PlaybookStage,
    idempotencyKey: `stage-start:${p.stageRunId}`,
  });
  if (started.status === "running") {
    await mark("running", started.externalAgent);
    await roomLine(
      session,
      `Step ${p.stageName} was sent to the ${started.service} agent.`,
      `stage-runner:${p.stageRunId}:started`
    );
    return "started";
  }
  if (started.status === "proposed") {
    await mark("waiting_start", started.externalAgent);
    await roomLine(
      session,
      `Starting the ${started.service} agent for step ${p.stageName} needs your approval: ${started.reviewUrl}`,
      `stage-runner:${p.stageRunId}:proposed`
    );
    return "proposed";
  }
  await mark("unreached");
  await roomLine(
    session,
    `Step ${p.stageName} did not reach its agent: ${started.error}`,
    `stage-runner:${p.stageRunId}:unreached`
  );
  return "failed";
}

export async function enterStage(p: {
  sessionId: string;
  stageKey: string;
  cause: EnterStageCause;
}): Promise<EnterStageResult> {
  try {
    return await enterStageUnsafe(p);
  } catch (err) {
    logger.error(
      { err, sessionId: p.sessionId, stageKey: p.stageKey },
      "stage runner: entering the step failed (the advance stands)"
    );
    return {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function enterStageUnsafe(p: {
  sessionId: string;
  stageKey: string;
  cause: EnterStageCause;
}): Promise<EnterStageResult> {
  const session = await db.query.focusSessions.findFirst({
    columns: {
      id: true,
      userId: true,
      channelId: true,
      workspaceId: true,
      goal: true,
      title: true,
      status: true,
      playbookId: true,
    },
    where: eq(focusSessions.id, p.sessionId),
  });
  if (!session) return { status: "no_run" };
  const [run] = await db
    .select({
      id: playbookRuns.id,
      definitionSnapshot: playbookRuns.definitionSnapshot,
      input: playbookRuns.input,
      runOn: playbookRuns.runOn,
    })
    .from(playbookRuns)
    .where(
      and(
        eq(playbookRuns.sessionId, p.sessionId),
        liveRunStatusWhere(playbookRuns.status)
      )
    )
    .orderBy(desc(playbookRuns.startedAt))
    .limit(1);
  if (!run) return { status: "no_run" };
  const stages = readStages(run.definitionSnapshot);
  const index = stages.findIndex((s) => s.key === p.stageKey);
  const stage = stages[index];
  if (!stage) return { status: "no_stage" };
  const stageName = stage.name?.trim() || stage.key;
  const next = stages[index + 1];

  // The step before it ends as this one begins.
  await db
    .update(sessionStageRuns)
    .set({ status: "done", endedAt: new Date() })
    .where(
      and(
        eq(sessionStageRuns.sessionId, p.sessionId),
        inArray(sessionStageRuns.status, [
          "running",
          "waiting_tools",
          "waiting_start",
          "unreached",
        ])
      )
    );
  const [{ prior } = { prior: 0 }] = await db
    .select({ prior: drizzleSql<number>`count(*)::int` })
    .from(sessionStageRuns)
    .where(
      and(
        eq(sessionStageRuns.sessionId, p.sessionId),
        eq(sessionStageRuns.stageKey, p.stageKey)
      )
    );

  // Who works it: named at the advance > the run's choice > the step's own.
  const entered =
    p.cause.kind === "advance" ? (p.cause.stageRunner ?? null) : null;
  const runChoice = runChoiceFor(run.input, p.stageKey);
  const [runner, via]: [PlaybookRunner | null, StageRunnerVia] = entered
    ? [entered, "entered"]
    : runChoice
      ? [runChoice, "run_choice"]
      : stage.runner !== undefined && stage.runner !== null
        ? [stage.runner, "stage"]
        : [null, "self"];
  const runOn = (run.runOn as RunOn | null) ?? null;
  const runAgent = runOn?.agentUserId ?? null;
  const requires = [
    ...new Set([
      ...stringsOf(stage.requires),
      ...stringsOf(
        (run.definitionSnapshot as { requires?: unknown } | null)?.requires
      ),
    ]),
  ];

  let holder: string | null = runAgent;
  let computerUserId: string | null = runOn?.computerUserId ?? null;
  let presetKey: string | null = null;
  /** How the pod reaches the agent the step is handed to. */
  let holderReach: "pull" | "dispatch" | null = null;
  let passedOver: RunnerPassedOver[] = [];
  let handOff: StageHandOff = "none";
  let proposalId: string | undefined;
  let reason: string | undefined;
  let report: Record<string, RequiresEntry> = {};
  let synapAiPersona: string | null = null;
  /** The runner resolved to Synap AI (a step that `uses` a playbook runs it there). */
  let synapAiChosen = false;

  const choices = runnerChoices(runner);
  const isSelf = choices.length === 0 || choices[0] === "self";
  if (isSelf) {
    const states = await requiresOnComputer({
      ownerId: session.userId,
      requires,
      computerUserId: runAgent ? computerUserId : null,
    });
    report = Object.fromEntries(
      Object.entries(states).map(([k, state]) => [k, { state }])
    );
  } else {
    const resolved = await resolveRunner({
      ownerId: session.userId,
      runner,
      requires,
      synapAiAllowed: true,
    });
    passedOver = resolved.passedOver;
    const chosen = resolved.chosen;
    if (chosen) {
      report = Object.fromEntries(
        Object.entries(chosen.requires).map(([k, state]) => [k, { state }])
      );
    }
    if (!chosen) {
      holder = null;
      computerUserId = null;
      handOff = "nobody";
    } else if (chosen.kind === "synap_ai") {
      holder = null;
      computerUserId = null;
      synapAiChosen = true;
      synapAiPersona = chosen.persona;
      if (runAgent !== null) {
        handOff = "synap_ai_turn";
      }
    } else if (chosen.agentUserId !== runAgent) {
      const askingAgent =
        p.cause.kind === "advance" ? (p.cause.agentUserId ?? null) : null;
      let granted = true;
      if (
        via === "entered" &&
        askingAgent &&
        askingAgent !== chosen.agentUserId
      ) {
        const { gateAgentHandOff } =
          await import("../focus-sessions/agent-hand-off.js");
        const decision = await gateAgentHandOff({
          userId: session.userId,
          agentUserId: askingAgent,
          workspaceId: session.workspaceId,
          sessionId: session.id,
          goal: session.goal,
          title: session.title,
          agentId: chosen.agentUserId,
          reasoning: `Step ${stageName}`,
        });
        if (decision.status === "proposed") {
          granted = false;
          handOff = "proposed";
          proposalId = decision.proposalId;
        } else if (decision.status === "denied") {
          granted = false;
          handOff = "refused";
          reason = decision.reason;
        }
      }
      if (granted) {
        holder = chosen.agentUserId;
        computerUserId = chosen.computerUserId;
        presetKey = chosen.preset;
        holderReach = chosen.reach;
        handOff = "attached";
      }
    } else {
      // The run's own agent: no hand-off.
      computerUserId = chosen.computerUserId ?? computerUserId;
      presetKey = chosen.preset;
    }
  }

  const missingTools = Object.entries(report)
    .filter(([, e]) => e.state === "missing")
    .map(([k]) => k);
  const proposals =
    missingTools.length > 0 && handOff !== "nobody"
      ? await askForTools({
          ownerId: session.userId,
          sessionId: session.id,
          computerUserId,
          stageName,
          report,
        })
      : [];
  const waitsOnTools =
    missingTools.length > 0 &&
    Object.values(report).some(
      (e) => e.state === "missing" && (e.proposalId || e.installationId)
    );

  const [row] = await db
    .insert(sessionStageRuns)
    .values({
      sessionId: session.id,
      playbookRunId: run.id,
      stageKey: p.stageKey,
      attempt: prior + 1,
      runnerAgentUserId: holder,
      runnerVia: via,
      presetKey,
      computerUserId,
      status: waitsOnTools ? "waiting_tools" : "running",
      requiresReport: Object.keys(report).length > 0 ? report : null,
      passedOver: passedOver.length > 0 ? passedOver : null,
    })
    .returning({ id: sessionStageRuns.id });
  const stageRunId = row!.id;
  let reached: DispatchReach | undefined;
  let childSessionId: string | undefined;

  // A step that IS a playbook (slice 4): its own run works it, handed to the
  // step's runner — never a turn on this session. Not while it waits on tools
  // (the re-check starts it) nor while nobody can take it (the person picks)
  // or a hand-off waits for the person.
  if (stage.uses && handOff !== "nobody" && handOff !== "proposed") {
    if (!waitsOnTools) {
      const { startStageChild } = await import("./stage-child.js");
      const child = await startStageChild({
        session,
        stage,
        stageRunId,
        handTo: synapAiChosen ? "synap_ai" : holder,
        persona: synapAiChosen ? synapAiPersona : null,
      });
      if (child.status === "started") childSessionId = child.childSessionId;
    }
  } else if (handOff === "attached" && holder) {
    // What the room is told, and the one turn a Synap AI step gets.
    const { attachSessionAgent } =
      await import("../focus-sessions/attach-session-agent.js");
    await attachSessionAgent({
      sessionId: session.id,
      agentId: holder,
      userId: session.userId,
    });
    const [agent] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, holder))
      .limit(1);
    const where = await computerName(computerUserId);
    const who = `${agent?.name?.trim() || "An agent"}${where ? ` on ${where}` : ""}`;
    await roomLine(
      session,
      `Step ${stageName} is with ${who}; ${next ? `it moves on to ${next.name?.trim() || next.key} when done.` : "the run ends when it is done."}`,
      `stage-runner:${stageRunId}`
    );
    // An agent bound for dispatch is TOLD: the step goes through its binding
    // (into its live task, else a task started for the step). Not while the
    // step waits on tools: the re-check sends it once they are there.
    if (holderReach === "dispatch" && !waitsOnTools) {
      reached = await reachDispatchAgent({
        session,
        runId: run.id,
        stage,
        stageName,
        stageRunId,
        agentUserId: holder,
      });
    }
  } else if (handOff === "proposed") {
    await roomLine(
      session,
      `Handing step ${stageName} to another agent waits for your approval.`,
      `stage-runner:${stageRunId}`
    );
  } else if (handOff === "refused") {
    await roomLine(
      session,
      `Step ${stageName} stays with the run's agent: ${reason ?? "the hand-off was refused."}`,
      `stage-runner:${stageRunId}`
    );
  } else if (handOff === "synap_ai_turn") {
    const content = `Step ${stageName} is with Synap AI.`;
    const messageId = await roomLine(
      session,
      content,
      `stage-runner:${stageRunId}`
    );
    if (messageId && session.channelId) {
      const { triggerAutoRespond } =
        await import("../../utils/trigger-auto-respond.js");
      await triggerAutoRespond({
        channelId: session.channelId,
        userMessageId: messageId,
        content,
        sourceUserId: session.userId,
        focusSessionId: session.id,
        agentType: synapAiPersona ?? "meta",
      });
    }
  } else if (handOff === "nobody") {
    await askWhoWorksIt({
      session,
      runId: run.id,
      stageName,
      passedOver,
    });
  }

  if (waitsOnTools) {
    await roomLine(
      session,
      `Step ${stageName} waits for ${missingTools.join(", ")} to be installed.`,
      `stage-runner:${stageRunId}:tools`
    );
    // Paused on the first install request: it resumes when the person
    // answers it, and the step is checked again then.
    if (
      proposals[0] &&
      (session.status === "active" || session.status === "forming")
    ) {
      // Best effort: a pause the hold rule refuses leaves the step waiting
      // (its row says so) and the session as it was.
      await setSessionStatus(db, {
        sessionId: session.id,
        from: ["active", "forming"],
        to: "paused",
        actor: { kind: "system", userId: session.userId },
        reason: `Step ${stageName} waits for ${missingTools.join(", ")}.`,
        hold: {
          on: "thing",
          ref: `installation:${missingTools[0]}`,
          reason: `Step ${stageName} needs ${missingTools.join(", ")} on its computer.`,
          until: { moves: `proposal:${proposals[0]}` },
        },
      }).catch((err: unknown) => {
        logger.warn(
          { err, sessionId: session.id },
          "stage runner: the pause on the install request was refused"
        );
      });
    }
  }

  return {
    status: "entered",
    stageRunId,
    runnerAgentUserId: holder,
    via,
    handOff,
    ...(proposalId ? { proposalId } : {}),
    ...(reason ? { reason } : {}),
    ...(waitsOnTools ? { waitingTools: missingTools } : {}),
    ...(reached ? { reached } : {}),
    ...(childSessionId ? { childSessionId } : {}),
  };
}

/** The session's open step, if any (`running`, `waiting_tools`, `waiting_child`). */
export async function readOpenStageRun(
  sessionId: string
): Promise<SessionStageRun | null> {
  const [row] = await db
    .select()
    .from(sessionStageRuns)
    .where(
      and(
        eq(sessionStageRuns.sessionId, sessionId),
        inArray(sessionStageRuns.status, [...OPEN_STAGE_RUN_STATUSES])
      )
    )
    .orderBy(desc(sessionStageRuns.startedAt))
    .limit(1);
  return row ?? null;
}

/**
 * Is the session's open step AWAY from Synap AI — held by an agent, or
 * waiting on a child run or on tools? Then a Synap AI turn that ends
 * `completed` must not end the run (spec §3.4, risk 2).
 */
export async function stageIsAway(sessionId: string): Promise<boolean> {
  const open = await readOpenStageRun(sessionId);
  if (!open) return false;
  return open.runnerAgentUserId !== null || open.status !== "running";
}

/**
 * Check a step that waits on tools again: every tool installed → it runs,
 * and the room says so; an install that failed → the room says the step
 * cannot go on (never an endless wait); otherwise it keeps waiting. Called
 * when the session's hold resumes and when an install it waits on moves.
 * Never throws.
 */
export async function recheckStageTools(
  sessionId: string
): Promise<"none" | "ready" | "waiting" | "failed"> {
  try {
    const open = await readOpenStageRun(sessionId);
    if (!open || open.status !== "waiting_tools") return "none";
    const session = await db.query.focusSessions.findFirst({
      columns: { id: true, userId: true, channelId: true },
      where: eq(focusSessions.id, sessionId),
    });
    if (!session) return "none";
    const before = (open.requiresReport ?? {}) as Record<string, RequiresEntry>;
    const states = await requiresOnComputer({
      ownerId: session.userId,
      requires: Object.keys(before),
      computerUserId: open.computerUserId,
    });
    const report = Object.fromEntries(
      Object.entries(before).map(([k, e]) => [
        k,
        { ...e, state: states[k] ?? e.state },
      ])
    );
    const missing = Object.entries(report)
      .filter(([, e]) => e.state === "missing")
      .map(([k]) => k);
    if (missing.length === 0) {
      await db
        .update(sessionStageRuns)
        .set({ status: "running", requiresReport: report })
        .where(eq(sessionStageRuns.id, open.id));
      await roomLine(
        session,
        `Step ${open.stageKey} has its tools: it goes on.`,
        `stage-runner:${open.id}:ready`
      );
      // A step that IS a playbook waited on tools: its run starts now.
      if (await startWaitedStageChild(open)) return "ready";
      // Its agent is bound for dispatch and was not told yet (the step
      // waited on tools first): it is told now.
      if (open.runnerAgentUserId && !open.externalAgent && open.playbookRunId) {
        await reachWaitedDispatchAgent(open);
      }
      return "ready";
    }
    await db
      .update(sessionStageRuns)
      .set({ requiresReport: report })
      .where(eq(sessionStageRuns.id, open.id));
    const { installations } = await import("@synap/database/schema");
    const failed = open.computerUserId
      ? await db
          .select({ key: installations.capabilityKey })
          .from(installations)
          .where(
            and(
              eq(installations.machineUserId, open.computerUserId),
              inArray(installations.capabilityKey, missing),
              eq(installations.status, "failed")
            )
          )
      : [];
    if (failed.length > 0) {
      await roomLine(
        session,
        `Installing ${failed.map((f) => f.key).join(", ")} failed: step ${open.stageKey} cannot go on until it is installed.`,
        `stage-runner:${open.id}:failed:${failed.map((f) => f.key).join(",")}`
      );
      return "failed";
    }
    return "waiting";
  } catch (err) {
    logger.warn({ err, sessionId }, "stage runner: tools re-check failed");
    return "none";
  }
}

/**
 * A step that `uses` a playbook and waited on tools: start its child run now,
 * handed to the runner the row recorded. False when the step is not one.
 */
async function startWaitedStageChild(open: SessionStageRun): Promise<boolean> {
  if (!open.playbookRunId) return false;
  const [run] = await db
    .select({ definitionSnapshot: playbookRuns.definitionSnapshot })
    .from(playbookRuns)
    .where(eq(playbookRuns.id, open.playbookRunId))
    .limit(1);
  const stage = readStages(run?.definitionSnapshot).find(
    (s) => s.key === open.stageKey
  );
  if (!stage?.uses) return false;
  const session = await db.query.focusSessions.findFirst({
    columns: {
      id: true,
      userId: true,
      channelId: true,
      workspaceId: true,
      status: true,
    },
    where: eq(focusSessions.id, open.sessionId),
  });
  if (!session) return false;
  const { startStageChild } = await import("./stage-child.js");
  await startStageChild({
    session,
    stage,
    stageRunId: open.id,
    handTo: open.runnerAgentUserId,
  });
  return true;
}

/** Tell a dispatch agent the step it waited on tools for (see `reachDispatchAgent`). */
async function reachWaitedDispatchAgent(open: SessionStageRun): Promise<void> {
  const { resolveAgentReach } =
    await import("../agent-dispatch/agent-binding.js");
  if ((await resolveAgentReach(open.runnerAgentUserId!)) !== "dispatch") return;
  const session = await db.query.focusSessions.findFirst({
    columns: {
      id: true,
      userId: true,
      channelId: true,
      goal: true,
      playbookId: true,
    },
    where: eq(focusSessions.id, open.sessionId),
  });
  const [run] = await db
    .select({ definitionSnapshot: playbookRuns.definitionSnapshot })
    .from(playbookRuns)
    .where(eq(playbookRuns.id, open.playbookRunId!))
    .limit(1);
  const stage = readStages(run?.definitionSnapshot).find(
    (s) => s.key === open.stageKey
  );
  if (!session || !stage) return;
  await reachDispatchAgent({
    session,
    runId: open.playbookRunId!,
    stage,
    stageName: stage.name?.trim() || stage.key,
    stageRunId: open.id,
    agentUserId: open.runnerAgentUserId!,
  });
}

/**
 * An install moved (`moveInstallation`): check again every step that waits on
 * tools on that computer. Never throws.
 */
export async function recheckStagesOnComputer(
  computerUserId: string
): Promise<void> {
  try {
    const rows = await db
      .select({ sessionId: sessionStageRuns.sessionId })
      .from(sessionStageRuns)
      .where(
        and(
          eq(sessionStageRuns.computerUserId, computerUserId),
          eq(sessionStageRuns.status, "waiting_tools")
        )
      );
    for (const r of rows) await recheckStageTools(r.sessionId);
  } catch (err) {
    logger.warn(
      { err, computerUserId },
      "stage runner: re-check on install move failed"
    );
  }
}
