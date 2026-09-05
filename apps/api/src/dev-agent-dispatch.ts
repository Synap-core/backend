/**
 * dev-agent-dispatch — apps/api's fill for @synap/api's `registerDevAgentSpawner`
 * slot.
 *
 * This is what turns "a playbook whose executor is `external-agent`, with no
 * webhookUrl" into a real coding agent running on the pod. It adds NO second
 * spawn path: it resolves the run's context into an instruction and calls the
 * ONE spawn door (`spawnDevAgent`, dev-agent-spawn.ts) that the DevPlane
 * `/api/devplane/claude-code` WS handler also calls.
 *
 * The run is a `playbook_runs` row, so it already appears in the unified runs
 * feed as `flowType: "playbook"` — no new FlowType is introduced (see
 * services/runs/types.ts: the ledger, not the executor, decides the flow type).
 *
 * SECURITY: the spawn puts a shell on the pod host, so it is gated by the SAME
 * user-controlled flag as the interactive terminal —
 * `workspace.settings.devplane.localTerminalEnabled`. A run in a workspace that
 * has not opted in is REFUSED (throw → the executor fails the run with the
 * reason), never silently downgraded.
 *
 * WHY THE FLAG IS THERE, AND WHAT WOULD JUSTIFY RELAXING IT. Today the child
 * inherits THIS PROCESS'S env — the pod's own secrets — and runs with the pod's
 * filesystem access on the host. That is only acceptable when the pod runs on a
 * machine the user already trusts with those secrets, which is exactly what the
 * flag asserts: "this host is trusted", NOT "this user may run dev agents".
 * On a cloud pod it must stay off.
 *
 * It becomes relaxable ONLY when the spawn no longer lands on the pod host —
 * i.e. when the child runs in an ephemeral per-session container with a scoped
 * env instead of `...process.env`. At that point the question the flag answers
 * changes from "is this machine trusted" to "is a container runtime
 * available", and it should be REPLACED by that capability check, not deleted.
 * Do not remove it because it looks like friction: it is the only thing between
 * an `external-agent` playbook and a shell holding the pod's credentials.
 */

import { createLogger } from "@synap-core/core";
import type {
  DevAgentDispatchRequest,
  DevAgentDispatchResult,
} from "@synap/api";
import { isLocalTerminalEnabled } from "./local-terminal.js";
import { spawnDevAgent } from "./dev-agent-spawn.js";

const logger = createLogger({ module: "dev-agent-dispatch" });

/** How much PTY output to keep for the log line when the agent exits. */
const TAIL_LIMIT = 4_000;

export async function dispatchDevAgentRun(
  req: DevAgentDispatchRequest
): Promise<DevAgentDispatchResult> {
  const enabled = await isLocalTerminalEnabled(req.workspaceId, req.userId);
  if (!enabled) {
    throw new Error(
      "local dev agent is not enabled for this workspace (settings.devplane.localTerminalEnabled)"
    );
  }

  const subjectLine = req.subject
    ? `\n\nSubject: ${req.subject.name ?? "entity"}${
        req.subject.profile ? ` (${req.subject.profile})` : ""
      } — id ${req.subject.id}`
    : "";
  const captureLine = req.runId
    ? `\n\nWhen you are done, report back with POST /api/hub/runs/${req.runId}/capture (status, summary, producedEntityIds).`
    : "";
  const instruction = `${req.goal}${subjectLine}${captureLine}`;

  // Headless: nothing is watching a WS, so the PTY output is tailed into the
  // pod log. The RUN's own record comes from the agent's capture-back, exactly
  // as it does for the webhook branch.
  let tail = "";

  const agent = await spawnDevAgent({
    workspaceId: req.workspaceId,
    userId: req.userId,
    sessionId: req.sessionId,
    instruction,
    extraEnv: {
      SYNAP_SESSION_ID: req.sessionId,
      ...(req.runId ? { SYNAP_RUN_ID: req.runId } : {}),
      ...(req.channelId ? { SYNAP_CHANNEL_ID: req.channelId } : {}),
    },
    onData: (chunk) => {
      tail = (tail + chunk).slice(-TAIL_LIMIT);
    },
    onExit: (exitCode) => {
      // NOTE: a non-zero exit does NOT fail the run here. The run is closed by
      // the agent's capture-back (same contract as the webhook branch); if the
      // agent never captures, the playbook-run reaper force-fails it. Closing it
      // from here would be a second run-write door.
      logger[exitCode === 0 ? "info" : "warn"](
        { runId: req.runId, sessionId: req.sessionId, exitCode, tail },
        "Dev-agent run process exited"
      );
    },
  });

  logger.info(
    {
      runId: req.runId,
      sessionId: req.sessionId,
      workspaceId: req.workspaceId,
      pid: agent.pid,
      cwd: agent.cwd,
    },
    "Dev-agent run dispatched"
  );

  return { pid: agent.pid, cwd: agent.cwd };
}
