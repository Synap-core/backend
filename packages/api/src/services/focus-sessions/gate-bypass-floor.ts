/**
 * THE AGENT FLOOR on a stage gate — an agent may propose and may reject, it can
 * never approve. A stage declaring a gate holds the run until a person (human
 * gate) or the left stage's criteria (check gate) let it through; this floor
 * stops an AGENT's session update from walking around that hold.
 *
 * `focus_session.update` auto-approves for agents (`DEFAULT_AUTO_APPROVE`), and
 * the gate itself is a PAUSE applied after the stage write
 * (services/playbooks/stage-gate.ts). Nothing re-checked a held gate on the
 * NEXT write, so before this floor the same agent could
 *   - resume a gate-held session (`status: "active"`) or advance it while held;
 *   - jump over a gated stage: `applyStageGate` resolves only the stage being
 *     ENTERED, so `discover → ship` never saw `build`'s gate.
 *
 * Run by the two agent doors — the MCP `updateFocusSession` service and the
 * Hub `PATCH /focus-sessions/:id` — BEFORE their membrane and their write, so
 * the refusal goes back to the caller that tried it and nothing is stored or
 * proposed. Approval stays the one way out: the gate's executor
 * (`focus_session/playbook.stage_gate`) or a passing check
 * (`resumeCheckGateIfMet`).
 *
 * Deliberately AGENT-only (the doors call it when `agentUserId` is set). The
 * human tRPC door is unchanged: a person moving their own session is the
 * person deciding, and the gate's approval is still the door the clients show.
 * A bare (unattributed) key on the Hub stays on the human path, as everywhere
 * else in the membrane (`shouldRejectUnattributedWrite`).
 *
 * An `awaits` gate (a dev plan/deploy approval) never holds on entry — the
 * agent enters the stage and files the named proposal there, and the approval
 * executor moves the run on (`stageAfterDevGate`). So for an agent, LEAVING
 * such a stage forward is the bypass, as is jumping over it; and the legacy
 * stamps that executor writes when no stage names the gate
 * (`DEV_GATE_LEGACY_STAGES`, read by the polling CLI as "you may proceed") are
 * never an agent's to set.
 */

import { resolveStageGate, type PlaybookStage } from "@synap/playbooks";
import { loadSessionProcess } from "@synap/jobs/utils/session-process.js";
import { DEV_GATE_LEGACY_STAGES } from "../proposals/dev-approval.js";
import { pendingStageGate } from "./follow-playbook.js";
import { isTerminalSessionStatus } from "./session-statuses.js";

export interface GateBypassFloorInput {
  /** The session row as loaded BEFORE the write. */
  session: {
    id: string;
    status: string | null;
    currentStage: string | null;
    playbookId: string | null;
    metadata: unknown;
  };
  /** The status the write asks for, if any. */
  toStatus?: string;
  /** The stage the write asks for, if any. */
  toStage?: string;
}

/**
 * The refusal reason, or `null` when the write may proceed. Never writes.
 */
export async function refuseAgentGateBypass(
  input: GateBypassFloorInput
): Promise<string | null> {
  const { session, toStatus, toStage } = input;
  const movesStage =
    toStage !== undefined && toStage !== (session.currentStage ?? null);

  // HELD: a paused session with an open gate (the gate's own markers —
  // `pendingStageGate` reads both). Pausing again is a no-op and closing goes
  // through the close door's own governance; anything else resumes it.
  if (session.status === "paused") {
    const held = await pendingStageGate(session);
    if (held) {
      const resumes =
        toStatus !== undefined &&
        toStatus !== "paused" &&
        !isTerminalSessionStatus(toStatus);
      if (resumes || movesStage) {
        return held === "human"
          ? "A stage gate on this session is waiting for a person's approval — an agent cannot resume or advance it. Nothing was changed. The run resumes when the gate proposal is approved."
          : "A stage check on this session has not passed yet — an agent cannot resume or advance it. Nothing was changed. The run resumes when the left stage's required criteria pass.";
      }
    }
  }

  if (!movesStage) return null;
  if ((Object.values(DEV_GATE_LEGACY_STAGES) as string[]).includes(toStage!)) {
    return `"${toStage}" is the stamp a person's dev approval writes — an agent cannot set it. Nothing was changed. File the approval and wait for the person to approve it.`;
  }
  const { leaving, skipped } = await gatedStagesPassed(session, toStage!);
  if (leaving) {
    const gate = resolveStageGate(leaving);
    const type = gate?.kind === "awaits" ? gate.proposalType : "its approval";
    return `Stage "${leaving.name ?? leaving.key}" waits for ${type} — its approval moves the run on, an agent cannot. Nothing was changed.`;
  }
  if (skipped.length === 0) return null;
  const names = skipped.map((s) => `"${s.name ?? s.key}"`).join(", ");
  return `Moving to "${toStage}" would skip the gated stage ${names}. Nothing was changed. Advance into it first — its gate decides whether the run goes on.`;
}

/**
 * What a FORWARD move from the current stage to `toStage` walks past, read from
 * the definition the gate itself is judged by (the run's frozen snapshot, then
 * the playbook — `loadSessionProcess`, the same precedence as
 * `resolveStageGateForSession`):
 *   - `leaving`  the current stage, when its gate AWAITS a named approval;
 *   - `skipped`  every gated stage strictly between (any gate kind).
 * A backward move, an unknown target or a session with no stages passes
 * nothing. A current stage that is not in the list counts as "before the first
 * stage" — fail-closed.
 */
async function gatedStagesPassed(
  session: GateBypassFloorInput["session"],
  toStage: string
): Promise<{ leaving?: PlaybookStage; skipped: PlaybookStage[] }> {
  const proc = await loadSessionProcess({
    sessionId: session.id,
    playbookId: session.playbookId,
  });
  if (!proc) return { skipped: [] };
  const keys = proc.stages.map((s) => s?.key);
  const to = keys.indexOf(toStage);
  if (to === -1) return { skipped: [] };
  const from = session.currentStage ? keys.indexOf(session.currentStage) : -1;
  if (to <= from) return { skipped: [] };
  const current = from >= 0 ? proc.stages[from] : undefined;
  return {
    ...(resolveStageGate(current)?.kind === "awaits"
      ? { leaving: current }
      : {}),
    skipped: proc.stages
      .slice(from + 1, to)
      .filter((stage) => resolveStageGate(stage) !== undefined),
  };
}
