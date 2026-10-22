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
 * Gate kinds that HOLD on entry are the ones skipping can bypass: `human` and
 * `check`. An `awaits` gate never holds on entry (its named proposal advances
 * the stage), so jumping over one is not counted here.
 */

import { resolveStageGate, type PlaybookStage } from "@synap/playbooks";
import { loadSessionProcess } from "@synap/jobs/utils/session-process.js";
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
  const skipped = await gatedStagesSkipped(session, toStage!);
  if (skipped.length === 0) return null;
  const names = skipped.map((s) => `"${s.name ?? s.key}"`).join(", ");
  return `Moving to "${toStage}" would skip the gated stage ${names}. Nothing was changed. Advance into it first — its gate decides whether the run goes on.`;
}

/**
 * The stages strictly between the current stage and `toStage` whose gate HOLDS
 * on entry, read from the definition the gate itself is judged by (the run's
 * frozen snapshot, then the playbook — `loadSessionProcess`, the same
 * precedence as `resolveStageGateForSession`). A backward move, an unknown
 * target or a session with no stages skips nothing. A current stage that is not
 * in the list counts as "before the first stage" — fail-closed.
 */
async function gatedStagesSkipped(
  session: GateBypassFloorInput["session"],
  toStage: string
): Promise<PlaybookStage[]> {
  const proc = await loadSessionProcess({
    sessionId: session.id,
    playbookId: session.playbookId,
  });
  if (!proc) return [];
  const keys = proc.stages.map((s) => s?.key);
  const to = keys.indexOf(toStage);
  if (to === -1) return [];
  const from = session.currentStage ? keys.indexOf(session.currentStage) : -1;
  if (to <= from) return [];
  return proc.stages.slice(from + 1, to).filter((stage) => {
    const gate = resolveStageGate(stage);
    return gate?.kind === "human" || gate?.kind === "check";
  });
}
