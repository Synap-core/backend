/**
 * The goal's WORKERS, for agents — ONE door both the MCP tools and Hub REST
 * call (goals that run, R2). A goal's "how it runs" is its workers: a
 * playbook's declared activator, enabled on the goal as a governed rule.
 *
 *   list    — the workers enabled on a goal (strict), each a GoalWorkerView
 *             (trigger words, last / next run, run health);
 *   enable  — enable a declared worker on a goal (or a project);
 *   pause   — pause or resume one enablement (by its rule id);
 *   run     — run a worker's playbook NOW, filed in its goal, through the
 *             shared playbook run door (`runPlaybookDoor`, governed).
 *
 * Governance is the services' own: enable and pause go through the ONE rule
 * door (`createRuleGoverned` / `updateRuleGoverned`), which turns an agent's
 * write into a proposal (`checkPermissionOrPropose`); run goes through
 * `playbooks.run`. Nothing here decides a permission.
 */
import { TRPCError } from "@trpc/server";
import {
  WorkerScopeOverlapError,
  enableWorker,
  listEnabledWorkers,
  listWorkerViews,
  setWorkerPaused,
} from "../../services/playbooks/workers.js";
import {
  runPlaybookDoor,
  type PlaybookDoorIdentity,
  type PlaybookDoorOutcome,
} from "./playbook-doors.js";

export type WorkerDoorOutcome<T> =
  | PlaybookDoorOutcome<T>
  /** Refused: the worker already runs over the same things (names the holder). */
  | {
      kind: "conflict";
      error: string;
      reasonCode: string;
      holder: WorkerScopeOverlapError["holder"];
    };

/** A service refusal as the door's outcome; anything else is thrown on. */
function refusalOf(err: unknown): WorkerDoorOutcome<never> | null {
  if (err instanceof WorkerScopeOverlapError) {
    return {
      kind: "conflict",
      error: err.message,
      reasonCode: err.reasonCode,
      holder: err.holder,
    };
  }
  if (err instanceof TRPCError) {
    if (err.code === "NOT_FOUND")
      return { kind: "not_found", error: err.message };
    if (
      err.code === "BAD_REQUEST" ||
      err.code === "PRECONDITION_FAILED" ||
      err.code === "CONFLICT"
    ) {
      return { kind: "invalid", error: err.message };
    }
  }
  return null;
}

async function guarded<T>(fn: () => Promise<T>): Promise<WorkerDoorOutcome<T>> {
  try {
    return { kind: "result", result: await fn() };
  } catch (err) {
    const refusal = refusalOf(err);
    if (refusal) return refusal;
    throw err;
  }
}

/** The workers enabled on a goal (strict), or a project's, as views. */
export function listWorkersDoor(
  identity: PlaybookDoorIdentity,
  input: { trackId?: string; projectId?: string; playbookId?: string }
): Promise<
  WorkerDoorOutcome<{ items: Awaited<ReturnType<typeof listWorkerViews>> }>
> {
  if (!input.trackId && !input.projectId) {
    return Promise.resolve({
      kind: "invalid",
      error:
        "trackId (the goal) or projectId is required — find a goal with synap_list_tracks.",
    });
  }
  return guarded(async () => ({
    items: await listWorkerViews({
      userId: identity.userId,
      ...(input.trackId ? { trackId: input.trackId } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.playbookId ? { playbookId: input.playbookId } : {}),
    }),
  }));
}

/** Enable a declared worker on a goal (or a project). An agent's is a proposal. */
export function enableWorkerDoor(
  identity: PlaybookDoorIdentity,
  input: {
    playbookId: string;
    activatorKey: string;
    trackId?: string;
    projectId?: string;
  }
): Promise<WorkerDoorOutcome<Awaited<ReturnType<typeof enableWorker>>>> {
  if (!input.trackId && !input.projectId) {
    return Promise.resolve({
      kind: "invalid",
      error: "Enable a worker for a goal (trackId) or a project (projectId).",
    });
  }
  return guarded(() =>
    enableWorker({
      userId: identity.userId,
      agentUserId: identity.agentUserId ?? null,
      playbookId: input.playbookId,
      activatorKey: input.activatorKey,
      ...(input.trackId ? { trackId: input.trackId } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
    })
  );
}

/** Pause or resume one enablement. An agent's is a proposal. */
export function setWorkerPausedDoor(
  identity: PlaybookDoorIdentity,
  input: { ruleId: string; paused: boolean }
): Promise<WorkerDoorOutcome<Awaited<ReturnType<typeof setWorkerPaused>>>> {
  return guarded(() =>
    setWorkerPaused({
      userId: identity.userId,
      agentUserId: identity.agentUserId ?? null,
      ruleId: input.ruleId,
      paused: input.paused,
    })
  );
}

/**
 * Run a worker's playbook NOW, filed in the goal (or project) it is enabled
 * on, through the shared playbook run door — the same governance as
 * `synap_run_playbook` with that `trackId`. A paused worker still runs once
 * when asked: "run now" is a person's or an agent's explicit act.
 */
export async function runWorkerDoor(
  identity: PlaybookDoorIdentity,
  input: { ruleId: string; reasoning?: string; source: string }
): Promise<WorkerDoorOutcome<unknown>> {
  const worker = (await listEnabledWorkers({ userId: identity.userId })).find(
    (w) => w.ruleId === input.ruleId
  );
  if (!worker) {
    return {
      kind: "not_found",
      error: `Worker ${input.ruleId} not found — list a goal's workers with synap_list_workers.`,
    };
  }
  return runPlaybookDoor(identity, {
    playbookId: worker.playbookId,
    ...(worker.projectId ? { projectId: worker.projectId } : {}),
    ...(worker.trackId ? { trackId: worker.trackId } : {}),
    ...(input.reasoning ? { reasoning: input.reasoning } : {}),
    source: input.source,
  });
}
