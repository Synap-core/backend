/**
 * A STEP THAT RUNS ONCE PER BATCH OF ITEMS (`PlaybookStage.forEach`; plan
 * fbfadf54 fix 3). Wide work in one run blows its turn budget (runs
 * 122e5ac4, ccb75e61, 711dc6b1, a48110a1); a narrow run finishes. So the pod
 * cuts the collection and runs each batch as its own CHILD RUN.
 *
 * {@link startStageForEach} runs when the stage runner enters the step
 * (`stage-runner.ts`):
 *   - `over` is resolved against the run's params (`playbook_runs.input`) or
 *     the subject (`subject.<path>`); a list, or a text holding a JSON list;
 *   - capped at `max` and at `PLAYBOOK_FOR_EACH_MAX_ITEMS`, cut into batches
 *     of `batch` items, kept on the step row (`session_stage_runs.fan_out`);
 *   - at most `PLAYBOOK_FOR_EACH_PARALLEL` children run at once; the rest
 *     wait their turn and start as running ones end ({@link pumpFanOut});
 *   - a child is the step's `uses` playbook when it names one (pinned, its
 *     `with` params), else THIS playbook at the parent's version reduced to
 *     the step (`stageOnly`); its items come as the param `as` and in its goal;
 *   - it is the PERSON's run, as a `uses` child is (`stage-child.ts`): the
 *     parent run was already accepted, so no child files a proposal;
 *   - it is stamped `metadata.stageOf` with its batch (`forEachIndex`), is
 *     spawned from the parent and blocks it; the step row waits
 *     (`waiting_child`) and the parent PAUSES until every child has ended.
 *
 * {@link settleFanOutChild} runs when a child CLOSES (the stage-child reactor
 * routes it here): its batch is marked, a failed or cancelled child stops
 * blocking the parent (a failed child does not fail the parent, founder
 * 2026-11-10), the next waiting batch starts; when every batch has ended the
 * step is done, the parent resumes, moves into the next step when that step
 * is ungated and nothing the step declared is still owed, and the run's agent
 * is told what each child delivered and which failed.
 *
 * Every change to `fan_out` is a read-modify-write under a row lock, so two
 * children closing at once never start four, and a replayed close settles
 * nothing twice. Never throws.
 */

import {
  and,
  db,
  desc,
  drizzleSql,
  eq,
  entities,
  focusSessions,
  playbookRuns,
  setSessionStatus,
} from "@synap/database";
import {
  sessionStageRuns,
  type StageFanOut,
  type StageFanOutChild,
} from "@synap/database/schema";
import {
  PLAYBOOK_FOR_EACH_MAX_ITEMS,
  PLAYBOOK_FOR_EACH_PARALLEL,
  resolveStageGate,
  type ExpectedOutput,
  type PlaybookStageForEach,
  type PlaybookStageUses,
} from "@synap/playbooks";
import type { RunOn } from "@synap-core/types/agents";
import { createLogger } from "@synap-core/core";
import {
  mapStageChildParams,
  resumeParent,
  roomLine,
  tellRunAgent,
  type SettleStageChildResult,
} from "./stage-child.js";
import type { StageOf } from "./stage-of.js";

const logger = createLogger({ module: "playbooks/stage-for-each" });

/** A stage as a frozen definition carries it (stored jsonb: data). */
interface ForEachStage {
  key: string;
  name?: string;
  forEach?: PlaybookStageForEach;
  uses?: PlaybookStageUses;
  expectedOutputs?: unknown;
  gate?: unknown;
}

const nameOf = (s: { key: string; name?: string }) => s.name?.trim() || s.key;

/** At most this many children are listed, one line each, in the join message. */
const JOIN_LINES_MAX = 50;

/** The list a resolved `over` value holds: a list, or a text holding a JSON list. */
export function forEachList(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The fan-out of a step: the items `over` names, capped and cut into batches
 * (every batch queued). Pure. An error when `over` names no list.
 */
export function planFanOut(
  forEach: PlaybookStageForEach,
  params: Record<string, unknown>,
  subject: Record<string, unknown> | null
): { fanOut: StageFanOut } | { error: string } {
  const value = mapStageChildParams({ v: forEach.over }, params, subject).v;
  const list = forEachList(value);
  if (!list) {
    return {
      error:
        value === undefined
          ? `"${forEach.over}" names nothing on this run.`
          : `"${forEach.over}" is not a list.`,
    };
  }
  const cap = Math.min(
    forEach.max ?? PLAYBOOK_FOR_EACH_MAX_ITEMS,
    PLAYBOOK_FOR_EACH_MAX_ITEMS
  );
  const items = list.slice(0, cap);
  const batch = Math.max(1, Math.floor(forEach.batch ?? 1));
  const children: StageFanOutChild[] = [];
  for (let i = 0; i < items.length; i += batch) {
    children.push({ items: items.slice(i, i + batch), status: "queued" });
  }
  return {
    fanOut: {
      over: forEach.over,
      as: forEach.as ?? "item",
      batch,
      total: list.length,
      children,
    },
  };
}

/** The queued batches that may start now, so no more than `parallel` run. Pure. */
export function batchesToStart(
  fanOut: StageFanOut,
  parallel: number = PLAYBOOK_FOR_EACH_PARALLEL
): number[] {
  const running = fanOut.children.filter((c) => c.status === "running").length;
  const free = Math.max(0, parallel - running);
  const out: number[] = [];
  fanOut.children.forEach((c, i) => {
    if (c.status === "queued" && out.length < free) out.push(i);
  });
  return out;
}

/**
 * The value a child gets as its `as` param: the item itself for a batch of
 * one plain value, else the batch as JSON text (a declared `text` param
 * takes it; no param type holds a list). Pure.
 */
export function batchParamValue(items: unknown[], batch: number): unknown {
  const one = items[0];
  if (
    batch === 1 &&
    (typeof one === "string" ||
      typeof one === "number" ||
      typeof one === "boolean")
  ) {
    return one;
  }
  return JSON.stringify(batch === 1 ? one : items);
}

/** The child's goal: its step's goal, then the items it works on. Pure. */
export function batchGoal(
  goal: string,
  p: {
    stageName: string;
    as: string;
    part: number;
    parts: number;
    items: unknown[];
  }
): string {
  const lines = p.items.map(
    (item) => `- ${typeof item === "string" ? item : JSON.stringify(item)}`
  );
  return [
    goal,
    "",
    `This run is part ${p.part} of ${p.parts} of step "${p.stageName}". Work only on these ${p.items.length} item${p.items.length === 1 ? "" : "s"} (${p.as}); the run that started this one gathers every part.`,
    ...lines,
  ].join("\n");
}

/**
 * Change the step row's fan-out under a row lock: `change` gets the current
 * one and returns the next (or null: nothing to write). Returns what was
 * written, or null when nothing was (no row, no fan-out, the step no longer
 * waits, or `change` declined).
 */
async function changeFanOut(
  stageRunId: string,
  change: (fanOut: StageFanOut) => StageFanOut | null
): Promise<StageFanOut | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        fanOut: sessionStageRuns.fanOut,
        status: sessionStageRuns.status,
      })
      .from(sessionStageRuns)
      .where(eq(sessionStageRuns.id, stageRunId))
      .for("update");
    if (!row?.fanOut || row.status !== "waiting_child") return null;
    const next = change(row.fanOut);
    if (!next) return null;
    await tx
      .update(sessionStageRuns)
      .set({ fanOut: next })
      .where(eq(sessionStageRuns.id, stageRunId));
    return next;
  });
}

const withChild = (
  fanOut: StageFanOut,
  index: number,
  patch: Partial<StageFanOutChild>
): StageFanOut => ({
  ...fanOut,
  children: fanOut.children.map((c, i) =>
    i === index ? { ...c, ...patch } : c
  ),
});

/** What a child run needs from its parent, read once per start. */
interface FanOutContext {
  session: {
    id: string;
    userId: string;
    channelId: string | null;
    workspaceId: string | null;
    playbookId: string | null;
    subjectEntityId: string | null;
  };
  stage: ForEachStage;
  stageRunId: string;
  /** The run's params (`playbook_runs.input`, without `stageRunners`). */
  params: Record<string, unknown>;
  subject: Record<string, unknown> | null;
  /** The parent's definition version (the child of a step without `uses` runs it). */
  version: number | null;
  handTo: string | null;
}

async function readSubject(
  subjectEntityId: string | null
): Promise<Record<string, unknown> | null> {
  if (!subjectEntityId) return null;
  const [e] = await db
    .select({
      id: entities.id,
      title: entities.title,
      properties: entities.properties,
    })
    .from(entities)
    .where(eq(entities.id, subjectEntityId))
    .limit(1);
  return e
    ? {
        ...((e.properties as Record<string, unknown> | null) ?? {}),
        id: e.id,
        title: e.title,
      }
    : null;
}

async function readContext(stageRunId: string): Promise<FanOutContext | null> {
  const [row] = await db
    .select({
      sessionId: sessionStageRuns.sessionId,
      playbookRunId: sessionStageRuns.playbookRunId,
      stageKey: sessionStageRuns.stageKey,
      runnerAgentUserId: sessionStageRuns.runnerAgentUserId,
    })
    .from(sessionStageRuns)
    .where(eq(sessionStageRuns.id, stageRunId))
    .limit(1);
  if (!row?.playbookRunId) return null;
  const [run] = await db
    .select({
      input: playbookRuns.input,
      definitionSnapshot: playbookRuns.definitionSnapshot,
      runOn: playbookRuns.runOn,
    })
    .from(playbookRuns)
    .where(eq(playbookRuns.id, row.playbookRunId))
    .limit(1);
  const session = await db.query.focusSessions.findFirst({
    columns: {
      id: true,
      userId: true,
      channelId: true,
      workspaceId: true,
      playbookId: true,
      subjectEntityId: true,
    },
    where: eq(focusSessions.id, row.sessionId),
  });
  if (!run || !session) return null;
  const snapshot = (run.definitionSnapshot ?? {}) as {
    version?: unknown;
    stages?: unknown;
  };
  const stage = (Array.isArray(snapshot.stages) ? snapshot.stages : []).find(
    (s): s is ForEachStage =>
      !!s && typeof s === "object" && (s as ForEachStage).key === row.stageKey
  );
  if (!stage?.forEach) return null;
  const { stageRunners: _stageRunners, ...params } = (run.input ??
    {}) as Record<string, unknown>;
  // The step's runner, as the row recorded it: an agent, else Synap AI when
  // the run's own agent is an external one handed nothing (the stage runner
  // records NULL for Synap AI).
  const runAgent = (run.runOn as RunOn | null)?.agentUserId ?? null;
  const handTo =
    row.runnerAgentUserId ?? (runAgent !== null ? "synap_ai" : null);
  return {
    session,
    stage,
    stageRunId,
    params,
    subject: await readSubject(session.subjectEntityId),
    version: typeof snapshot.version === "number" ? snapshot.version : null,
    handTo,
  };
}

/** Start the child run of batch `index`. Returns its session id, or why not. */
async function startBatch(
  ctx: FanOutContext,
  fanOut: StageFanOut,
  index: number
): Promise<{ sessionId: string } | { error: string }> {
  const { session, stage } = ctx;
  const stageName = nameOf(stage);
  const batch = fanOut.children[index]!;
  const part = index + 1;
  const parts = fanOut.children.length;
  if (!session.workspaceId) return { error: "the run has no space." };
  const value = batchParamValue(batch.items, fanOut.batch);
  const stageOf: StageOf = {
    sessionId: session.id,
    stageKey: stage.key,
    stageRunId: ctx.stageRunId,
    forEachIndex: index,
  };
  const { runPlaybook } = await import("./run-playbook.js");
  const { resolveGoal } = await import("./playbook-lifecycle.js");
  const common = {
    workspaceId: session.workspaceId,
    // The person's run (never an agent draft): the parent was accepted.
    userId: session.userId,
    onMissingRequired: "owe" as const,
    ...(session.subjectEntityId ? { subjectId: session.subjectEntityId } : {}),
    parentSessionId: session.id,
    suspendedIntent: `Step ${stageName}, part ${part} of ${parts}`,
    stageOf,
    ...(ctx.handTo === "synap_ai"
      ? { runOn: "synap_ai" as const }
      : ctx.handTo
        ? { handToAgentId: ctx.handTo }
        : {}),
  };
  const goalFor =
    (params: Record<string, unknown>) =>
    (template: string): string =>
      batchGoal(resolveGoal(template, params), {
        stageName,
        as: fanOut.as,
        part,
        parts,
        items: batch.items,
      });
  let started;
  if (stage.uses) {
    const params = {
      ...mapStageChildParams(stage.uses.with, ctx.params, ctx.subject),
      [fanOut.as]: value,
    };
    started = await runPlaybook({
      ...common,
      playbookId: stage.uses.playbookId,
      ...(typeof stage.uses.version === "number"
        ? { pinnedVersion: stage.uses.version }
        : {}),
      params,
      goalResolver: goalFor(params),
    });
  } else {
    if (!session.playbookId) return { error: "the run follows no playbook." };
    // The whole collection stays with the parent; the child gets its batch.
    const { [fanOut.over]: _whole, ...rest } = ctx.params;
    const params = { ...rest, [fanOut.as]: value };
    started = await runPlaybook({
      ...common,
      playbookId: session.playbookId,
      ...(ctx.version !== null ? { pinnedVersion: ctx.version } : {}),
      stageOnly: stage.key,
      params,
      goalResolver: goalFor(params),
    });
  }
  const child = started.session;
  if (!child) {
    return {
      error: `nothing was started (${"skipped" in started ? String(started.skipped) : "no session"}).`,
    };
  }
  return { sessionId: child.id };
}

/**
 * Start every waiting batch a free place allows (at most
 * `PLAYBOOK_FOR_EACH_PARALLEL` running). A batch that cannot start is marked
 * failed and its place goes to the next one. Returns the child sessions
 * started, and the step's end when no batch is left to run. Never throws.
 */
export async function pumpFanOut(stageRunId: string): Promise<{
  started: string[];
  finished: SettleStageChildResult | null;
}> {
  const started: string[] = [];
  let finished: SettleStageChildResult | null = null;
  try {
    let ctx: FanOutContext | null = null;
    for (;;) {
      let claimed: number[] = [];
      const fanOut = await changeFanOut(stageRunId, (f) => {
        claimed = batchesToStart(f);
        if (claimed.length === 0) return null;
        return claimed.reduce(
          (acc, i) => withChild(acc, i, { status: "running" }),
          f
        );
      });
      if (!fanOut || claimed.length === 0) break;
      ctx ??= await readContext(stageRunId);
      let refused = false;
      for (const index of claimed) {
        const out = ctx
          ? await startBatch(ctx, fanOut, index).catch(
              (err: unknown): { error: string } => ({
                error: err instanceof Error ? err.message : String(err),
              })
            )
          : { error: "the step could not be read." };
        if ("sessionId" in out) {
          started.push(out.sessionId);
          await changeFanOut(stageRunId, (f) =>
            withChild(f, index, { sessionId: out.sessionId })
          );
        } else {
          refused = true;
          logger.warn(
            { stageRunId, index, error: out.error },
            "for each: a batch could not start"
          );
          await changeFanOut(stageRunId, (f) =>
            withChild(f, index, { status: "failed", error: out.error })
          );
        }
      }
      // A refused batch freed its place: the next waiting one takes it.
      if (!refused) break;
    }
    // Every batch ended (or there was none): the step is done.
    finished = await finishIfAllEnded(stageRunId);
  } catch (err) {
    logger.error({ err, stageRunId }, "for each: starting batches failed");
  }
  return { started, finished };
}

export type StartStageForEachResult =
  | { status: "started"; childSessionIds: string[] }
  | { status: "failed"; error: string };

/**
 * Enter a `forEach` step: plan its batches on the step row, start the first
 * ones, and pause the parent until every child has ended. Never throws: a
 * collection that cannot be read leaves the step row `failed` and says why in
 * the room.
 */
export async function startStageForEach(p: {
  session: {
    id: string;
    userId: string;
    channelId: string | null;
    status: string;
  };
  stage: ForEachStage;
  stageRunId: string;
}): Promise<StartStageForEachResult> {
  const { session, stage } = p;
  const stageName = nameOf(stage);
  try {
    const ctx = await readContext(p.stageRunId);
    if (!ctx) throw new Error("the step could not be read.");
    const plan = planFanOut(stage.forEach!, ctx.params, ctx.subject);
    if ("error" in plan) throw new Error(plan.error);
    const { fanOut } = plan;
    await db
      .update(sessionStageRuns)
      .set({ status: "waiting_child", fanOut })
      .where(eq(sessionStageRuns.id, p.stageRunId));
    const kept = fanOut.children.reduce((n, c) => n + c.items.length, 0);
    await roomLine(
      session,
      `Step ${stageName} runs as ${fanOut.children.length} run${fanOut.children.length === 1 ? "" : "s"} of up to ${fanOut.batch} item${fanOut.batch === 1 ? "" : "s"} each (${kept}${kept < fanOut.total ? ` of ${fanOut.total}` : ""} items), at most ${PLAYBOOK_FOR_EACH_PARALLEL} at once. This run goes on when they are done.`,
      `stage-for-each:${p.stageRunId}:planned`
    );
    const { started: childSessionIds } = await pumpFanOut(p.stageRunId);
    // Still waiting on a child: the parent pauses until the last one ends
    // (`settleFanOutChild` resumes it).
    const [row] = await db
      .select({ status: sessionStageRuns.status })
      .from(sessionStageRuns)
      .where(eq(sessionStageRuns.id, p.stageRunId))
      .limit(1);
    if (
      row?.status === "waiting_child" &&
      (session.status === "active" || session.status === "forming")
    ) {
      await setSessionStatus(db, {
        sessionId: session.id,
        from: ["active", "forming"],
        to: "paused",
        actor: { kind: "system", userId: session.userId },
        reason: `Step ${stageName} waits for its runs.`,
        hold: {
          on: "agent",
          ref: `session_stage_run:${p.stageRunId}`,
          reason: `Step ${stageName} is worked by ${fanOut.children.length} runs.`,
        },
      }).catch((err: unknown) => {
        // The step row still says it waits; the session stays as it was.
        logger.warn(
          { err, sessionId: session.id },
          "for each: the pause on the child runs was refused"
        );
      });
    }
    return { status: "started", childSessionIds };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await db
      .update(sessionStageRuns)
      .set({ status: "failed", endedAt: new Date() })
      .where(eq(sessionStageRuns.id, p.stageRunId));
    await roomLine(
      session,
      `Step ${stageName} could not run once per item: ${error}`,
      `stage-for-each:${p.stageRunId}:failed`
    );
    return { status: "failed", error };
  }
}

/**
 * A child of a `forEach` step closed: mark its batch, stop it blocking the
 * parent when it did not deliver, start the next waiting batch, and finish
 * the step when every batch has ended. Called by `settleStageChild` once the
 * child and its parent are read (owner floor included). Never throws.
 */
export async function settleFanOutChild(p: {
  child: { id: string; userId: string };
  ended: string;
  parent: { id: string; userId: string };
  stageOf: StageOf & { forEachIndex: number };
}): Promise<SettleStageChildResult> {
  const { child, parent, stageOf } = p;
  const index = stageOf.forEachIndex;
  const status: StageFanOutChild["status"] =
    p.ended === "closed"
      ? "done"
      : p.ended === "failed"
        ? "failed"
        : "cancelled";
  try {
    // Compare and set: only the batch still running, by this child, settles.
    const fanOut = await changeFanOut(stageOf.stageRunId, (f) => {
      const c = f.children[index];
      if (!c || c.status !== "running") return null;
      if (c.sessionId && c.sessionId !== child.id) return null;
      return withChild(f, index, { status, sessionId: child.id });
    });
    if (!fanOut) return { status: "settled_already" };
    if (status !== "done") {
      // A failed child does not fail the parent: it stops blocking it.
      const { removeSessionBlocker } =
        await import("../focus-sessions/session-blocked-by.js");
      await removeSessionBlocker({
        sessionId: parent.id,
        blockerSessionId: child.id,
        userId: parent.userId,
      }).catch((err: unknown) =>
        logger.warn({ err }, "for each: dropping the blocker failed")
      );
    }
    // The next waiting batch takes the freed place; the step ends with the
    // last batch.
    const { finished } = await pumpFanOut(stageOf.stageRunId);
    return (
      finished ?? { status: "fan_out_waiting", failed: failedParts(fanOut) }
    );
  } catch (err) {
    logger.error(
      { err, childSessionId: child.id },
      "for each: settling a child run failed"
    );
    return { status: "not_a_step" };
  }
}

const failedParts = (fanOut: StageFanOut) =>
  fanOut.children.flatMap((c, i) =>
    c.status === "failed" || c.status === "cancelled" ? [i + 1] : []
  );

/** One line per child for the join message (bounded). */
async function joinLines(fanOut: StageFanOut): Promise<string[]> {
  const ids = fanOut.children.flatMap((c) =>
    c.sessionId ? [c.sessionId] : []
  );
  const rows = ids.length
    ? await db.query.focusSessions.findMany({
        columns: { id: true, title: true, goal: true, expectedOutputs: true },
        where: (s, { inArray }) => inArray(s.id, ids),
      })
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const lines = fanOut.children.slice(0, JOIN_LINES_MAX).map((c, i) => {
    const s = c.sessionId ? byId.get(c.sessionId) : undefined;
    const name = s
      ? `"${s.title ?? s.goal}" (session ${s.id})`
      : "never started";
    const delivered = (
      Array.isArray(s?.expectedOutputs)
        ? (s!.expectedOutputs as ExpectedOutput[])
        : []
    )
      .filter((o) => o.status === "done")
      .map((o) => o.label);
    const what =
      c.status === "done"
        ? delivered.length > 0
          ? `delivered ${delivered.join(", ")}`
          : "done"
        : c.status === "failed"
          ? `FAILED${c.error ? `: ${c.error}` : ""}`
          : "CANCELLED";
    return `- part ${i + 1} (${c.items.length} item${c.items.length === 1 ? "" : "s"}): ${name}, ${what}`;
  });
  if (fanOut.children.length > JOIN_LINES_MAX) {
    lines.push(`- and ${fanOut.children.length - JOIN_LINES_MAX} more parts`);
  }
  return lines;
}

/**
 * Every batch ended: the step is done (once: compare and set on the row),
 * the parent resumes, moves into the next step when it may, and its agent is
 * told what each child delivered and which failed. Null while a batch still
 * waits or runs, or when another settle already finished it.
 */
async function finishIfAllEnded(
  stageRunId: string
): Promise<SettleStageChildResult | null> {
  const [row] = await db
    .update(sessionStageRuns)
    .set({ status: "done", endedAt: new Date() })
    .where(
      and(
        eq(sessionStageRuns.id, stageRunId),
        eq(sessionStageRuns.status, "waiting_child"),
        // Every batch ended: none queued or running.
        drizzleSql`NOT EXISTS (SELECT 1 FROM jsonb_array_elements(${sessionStageRuns.fanOut} -> 'children') AS c WHERE c ->> 'status' IN ('queued', 'running'))`
      )
    )
    .returning({
      sessionId: sessionStageRuns.sessionId,
      stageKey: sessionStageRuns.stageKey,
      fanOut: sessionStageRuns.fanOut,
      playbookRunId: sessionStageRuns.playbookRunId,
    });
  if (!row?.fanOut) return null;
  const fanOut = row.fanOut;
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
    where: eq(focusSessions.id, row.sessionId),
  });
  if (!parent) return null;
  const [run] = await db
    .select({
      definitionSnapshot: playbookRuns.definitionSnapshot,
      runOn: playbookRuns.runOn,
    })
    .from(playbookRuns)
    .where(eq(playbookRuns.sessionId, parent.id))
    .orderBy(desc(playbookRuns.startedAt))
    .limit(1);
  const stages = (
    Array.isArray(
      (run?.definitionSnapshot as { stages?: unknown } | null)?.stages
    )
      ? ((run!.definitionSnapshot as { stages: unknown[] })
          .stages as ForEachStage[])
      : []
  ).filter((s) => !!s && typeof s.key === "string");
  const index = stages.findIndex((s) => s.key === row.stageKey);
  const stage = stages[index];
  const stageName = stage ? nameOf(stage) : row.stageKey;
  const failed = failedParts(fanOut);
  const runAgent = (run?.runOn as RunOn | null)?.agentUserId ?? null;

  // What the step declared, still owed on the parent: the run's agent makes
  // it from the children's results; the pod does not guess which child's is it.
  const outputs = Array.isArray(parent.expectedOutputs)
    ? (parent.expectedOutputs as ExpectedOutput[])
    : [];
  const owed = (
    Array.isArray(stage?.expectedOutputs)
      ? (stage.expectedOutputs as ExpectedOutput[])
      : []
  )
    .filter((o) => typeof o?.label === "string" && !o.optional)
    .filter((o) => {
      const slot = outputs.find((s) => s.label === o.label);
      return !slot || slot.status !== "done";
    })
    .map((o) => o.label);
  const next = index >= 0 ? stages[index + 1] : undefined;
  const nextGated = next ? resolveStageGate(next) !== undefined : false;

  await resumeParent(
    parent.id,
    parent.userId,
    `Step ${stageName}'s runs have all ended.`
  );
  let toStage: string | undefined;
  if (
    next &&
    !nextGated &&
    owed.length === 0 &&
    parent.currentStage === row.stageKey
  ) {
    const { advanceSessionStage } =
      await import("../focus-sessions/advance-stage.js");
    await advanceSessionStage({
      session: parent,
      toStage: next.key,
      userId: parent.userId,
      stageWrite: "door",
    });
    toStage = next.key;
  }
  const done = fanOut.children.length - failed.length;
  const head =
    failed.length > 0
      ? `Step ${stageName} is done: ${done} of ${fanOut.children.length} runs delivered; part${failed.length === 1 ? "" : "s"} ${failed.join(", ")} failed.`
      : `Step ${stageName} is done: all ${fanOut.children.length} runs delivered.`;
  const then = toStage
    ? `The run moved on to step ${nameOf(next!)}.`
    : !next
      ? "It was the last step: close the run when it is done."
      : owed.length > 0
        ? `Make ${owed.join(", ")} from their results, then move on.`
        : nextGated
          ? `The next step, ${nameOf(next)}, is gated: move on when it is right to.`
          : "The run moved meanwhile: pick up from where it is.";
  await tellRunAgent(
    parent,
    runAgent,
    [head, then, "", ...(await joinLines(fanOut))].join("\n"),
    `stage-for-each:${stageRunId}:done`
  );
  return { status: "fan_out_done", failed, ...(toStage ? { toStage } : {}) };
}
