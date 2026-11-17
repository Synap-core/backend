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
 *
 * A CHECK gate the move would certainly hold on is refused here too, before
 * anything is written (db6a5e17): a required criterion of the stage being
 * left that has no grade and that the gate cannot grade itself (an evidence
 * check with no evidence posted, a person's grade). Before, the stage was
 * written, the check paused the run and its `onFail` sent it back. The rule
 * "unmeasured is never passed" stays: the move waits for the grade, and a
 * criterion graded FAIL still holds through the gate as before.
 */

import {
  readCriteria,
  resolveStageGate,
  type PlaybookStage,
} from "@synap/playbooks";
import { db, focusSessions, eq } from "@synap/database";
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
  if (skipped.length > 0) {
    const names = skipped.map((s) => `"${s.name ?? s.key}"`).join(", ");
    return `Moving to "${toStage}" would skip the gated stage ${names}. Nothing was changed. Advance into it first — its gate decides whether the run goes on.`;
  }
  return ungradedEntryCheck(session, toStage);
}

/**
 * The refusal when `toStage`'s CHECK gate would hold only for want of a
 * grade the gate cannot give (header), naming what to grade; else null.
 */
async function ungradedEntryCheck(
  session: GateBypassFloorInput["session"],
  toStage: string
): Promise<string | null> {
  const fromStage = session.currentStage ?? null;
  if (!fromStage) return null;
  const proc = await loadSessionProcess({
    sessionId: session.id,
    playbookId: session.playbookId,
  });
  const entered = proc?.stages.find((s) => s?.key === toStage);
  if (resolveStageGate(entered)?.kind !== "check") return null;
  const [row] = await db
    .select({ userId: focusSessions.userId, criteria: focusSessions.criteria })
    .from(focusSessions)
    .where(eq(focusSessions.id, session.id))
    .limit(1);
  if (!row) return null;
  const left = readCriteria(row.criteria).filter(
    (c) =>
      c.stageKey === fromStage &&
      c.required !== false &&
      (c.check.kind === "evidence" || c.check.kind === "human")
  );
  if (left.length === 0) return null;
  const { listSessionEvaluations, summarizeEvaluations } =
    await import("./evaluations/record.js");
  const graded = new Set(
    summarizeEvaluations(
      row.criteria,
      await listSessionEvaluations({ sessionId: session.id, userId: row.userId })
    ).evaluations.map((e) => e.criterionKey)
  );
  const ungraded = left.filter((c) => !graded.has(c.key));
  if (ungraded.length === 0) return null;
  const what = ungraded
    .map((c) =>
      c.check.kind === "evidence"
        ? `"${c.key}" (post evidence \`${c.check.evidenceKey ?? c.key}\` with synap_evaluate_session)`
        : `"${c.key}" (the person grades it)`
    )
    .join(", ");
  const name = entered?.name ?? toStage;
  return `Stage "${name}" checks "${fromStage}" on entry, and ${ungraded.length === 1 ? "this criterion has" : "these criteria have"} no grade yet: ${what}. Nothing was changed. Grade ${ungraded.length === 1 ? "it" : "them"}, then move again.`;
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
