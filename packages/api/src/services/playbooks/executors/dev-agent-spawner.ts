/**
 * dev-agent-spawner — the IoC slot the `external-agent` executor dispatches a
 * LOCAL coding agent through.
 *
 * WHY A SLOT. "Bring Your Own Agent" has two dispatch shapes: a WEBHOOK (the
 * agent lives elsewhere; already implemented in external-agent-executor.ts) and
 * a LOCAL SPAWN (the pod starts Claude Code itself in a PTY). The spawn lives in
 * `apps/api` — it needs node-pty and the DevPlane workspace gate — and
 * @synap/api cannot import apps/api. So this is the SAME inversion
 * `registerAgentWaker` / `registerPlaybookRunner` / `registerCapabilityExecutor`
 * use: the package declares the slot, apps/api fills it at boot with a thunk
 * that calls the ONE real spawn door (`apps/api/src/dev-agent-spawn.ts`).
 *
 * There is deliberately no fallback implementation here. An unfilled slot makes
 * the run FAIL with the reason — never a phantom `running` run that nothing will
 * ever close, which is what this branch did before it was wired.
 */

/** What the executor hands the spawner. Structurally mirrors `RunContext`. */
export interface DevAgentDispatchRequest {
  workspaceId: string;
  /** The human who owns the run — the spawn's provider keys resolve per-user. */
  userId: string;
  /** The focus session this run drives — KEYS THE CHECKOUT PATH. */
  sessionId: string;
  /** The playbook_runs row, so the agent can capture back to it. */
  runId: string | null;
  channelId: string | null;
  /** The resolved goal, seeded as the CLI's initial prompt. */
  goal: string;
  subject: {
    id: string;
    name: string | null;
    profile: string | null;
  } | null;
}

export interface DevAgentDispatchResult {
  pid: number;
  /** The working directory the agent was spawned in (session-keyed). */
  cwd: string;
}

export type DevAgentSpawner = (
  req: DevAgentDispatchRequest
) => Promise<DevAgentDispatchResult>;

let devAgentSpawner: DevAgentSpawner | null = null;

/** Fill the slot at boot: `registerDevAgentSpawner(dispatchDevAgentRun)`.
 *  `null` clears it (tests only — the slot is module-global). */
export function registerDevAgentSpawner(fn: DevAgentSpawner | null): void {
  devAgentSpawner = fn;
}

export function getDevAgentSpawner(): DevAgentSpawner | null {
  return devAgentSpawner;
}
