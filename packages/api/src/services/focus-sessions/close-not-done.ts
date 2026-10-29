/**
 * "Done" is checked, not claimed (firewall F11, pod document 9ca0c96b §5,
 * founder-approved 29 Oct 2026).
 *
 * An AGENT's close with `terminalStatus: "closed"` is refused while the
 * session still owes required work: a required criterion that does not pass
 * (failed, or never graded) or a required agent-owned outcome that is still
 * open. The refusal names every one of them and the ways out: grade or finish
 * them, withdraw an outcome that is no longer wanted (`retireOutput`), close
 * `cancelled` / `failed` instead, or name WHY it closes anyway (`reason`),
 * which is recorded on the session and in the close event.
 *
 * Scope, in the one close door (`completeFocusSession`), by the same signal
 * the OPEN_QUESTIONS refusal uses, `params.agentUserId`:
 *   - an agent through MCP `synap_complete_session` or Hub REST `/complete`
 *     and PATCH → checked;
 *   - the person (tRPC: keys never reach main /trpc), an approval of an
 *     agent's proposed close (`approvedCloseOf`, the person decided), and the
 *     automatic closes (jobs closer slot, reapers, triage, recap, reactors) →
 *     never checked: the person must always be able to close anything, and an
 *     automatic close is not anyone's claim that the work is done.
 *
 * This supersedes, for agent closes only, the earlier rule "close never
 * blocks on criteria" (complete-session.ts); a person's close keeps it.
 *
 * Human-owned outcomes do not block: the person owes them, not the agent, and
 * the close already has its own rule for them (confirm/choose asks retire,
 * act/provide stay owed past the close and are reported as `leftOwed`). A
 * deliverable whose key is also a declared criterion is judged by that
 * criterion only (the outcome model folds the two into one outcome).
 */
import {
  deriveSlotKeys,
  isDeliverableOutstanding,
} from "@synap-core/types/units";
import { isCriterionRequired, type ExpectedOutput } from "@synap/playbooks";
import type { FocusSession } from "@synap/database";
import { loadSessionEvaluationSummary } from "./evaluations/record.js";

export const NOT_DONE_AT_CLOSE = "NOT_DONE" as const;

/** A required criterion whose current verdict is not `pass`. */
export interface UnmetCriterionAtClose {
  key: string;
  statement: string;
  /** `fail`, or `unmeasured` when it was never graded. */
  verdict: "fail" | "unmeasured";
}

/** A required, agent-owned deliverable that is not done. */
export interface OpenOutcomeAtClose {
  key: string;
  label: string;
}

export interface NotDoneAtClose {
  criteria: UnmetCriterionAtClose[];
  outcomes: OpenOutcomeAtClose[];
}

/** What is recorded when an agent closes `closed` anyway, with its reason. */
export interface ClosedNotDoneRecord extends NotDoneAtClose {
  reason: string;
  by: string;
  at: string;
}

/** Longest statement / label quoted back in the refusal sentence. */
const QUOTE_MAX = 100;

function clip(s: string): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > QUOTE_MAX ? `${t.slice(0, QUOTE_MAX - 1)}…` : t;
}

/**
 * Pure: what required work is still open, from the session's declared
 * criteria, their current evaluations and its deliverable slots.
 */
export function openRequiredWork(args: {
  criteria: ReadonlyArray<{
    key: string;
    statement: string;
    required?: boolean;
  }>;
  evaluations: ReadonlyArray<{ criterionKey: string; verdict: string }>;
  expectedOutputs: readonly ExpectedOutput[];
}): NotDoneAtClose {
  const verdictOf = new Map(
    args.evaluations.map((e) => [e.criterionKey, e.verdict] as const)
  );
  const criteria: UnmetCriterionAtClose[] = [];
  for (const c of args.criteria) {
    if (!isCriterionRequired(c)) continue;
    const verdict = verdictOf.get(c.key);
    if (verdict === "pass") continue;
    criteria.push({
      key: c.key,
      statement: c.statement,
      verdict: verdict === "fail" ? "fail" : "unmeasured",
    });
  }
  const criterionKeys = new Set(args.criteria.map((c) => c.key));
  const keys = deriveSlotKeys(args.expectedOutputs);
  const outcomes: OpenOutcomeAtClose[] = [];
  args.expectedOutputs.forEach((slot, i) => {
    const key = keys[i] ?? slot.label;
    if (slot.owner === "human") return;
    if (criterionKeys.has(key)) return;
    if (!isDeliverableOutstanding(slot)) return;
    outcomes.push({ key, label: slot.label });
  });
  return { criteria, outcomes };
}

export function hasOpenRequiredWork(w: NotDoneAtClose): boolean {
  return w.criteria.length > 0 || w.outcomes.length > 0;
}

/**
 * Read what the session still owes. The verdict comes from the same reader
 * every session door shows (`loadSessionEvaluationSummary`), so "ready to
 * close" and "close refused" can never disagree. A failed read THROWS: an
 * unreadable grade is not a passing one.
 */
export async function loadOpenRequiredWork(
  session: Pick<FocusSession, "id" | "userId" | "criteria" | "expectedOutputs">
): Promise<NotDoneAtClose> {
  const summary = await loadSessionEvaluationSummary(session);
  return openRequiredWork({
    criteria: summary.criteria,
    evaluations: summary.evaluations,
    expectedOutputs: Array.isArray(session.expectedOutputs)
      ? (session.expectedOutputs as ExpectedOutput[])
      : [],
  });
}

/**
 * The refusal. The sentence carries the whole list, so a door that only
 * forwards `message` still tells the agent exactly what is left and how out.
 */
export function notDoneAtCloseError(
  work: NotDoneAtClose
): Error & { code: typeof NOT_DONE_AT_CLOSE; notDone: NotDoneAtClose } {
  const parts: string[] = [];
  if (work.criteria.length > 0) {
    parts.push(
      `required criteria not passing: ${work.criteria
        .map(
          (c) =>
            `${c.key} (${c.verdict === "fail" ? "failed" : "not graded"}): "${clip(c.statement)}"`
        )
        .join("; ")}`
    );
  }
  if (work.outcomes.length > 0) {
    parts.push(
      `required outcomes still open: ${work.outcomes
        .map((o) => `${o.key}: "${clip(o.label)}"`)
        .join("; ")}`
    );
  }
  return Object.assign(
    new Error(
      `Not closed: the session still owes required work — ${parts.join(" — ")}. ` +
        "Grade the criteria (synap_evaluate_session) or finish them; claim a finished outcome " +
        "(synap_update_session completeOutput) or withdraw one no longer wanted (retireOutput); " +
        "close as cancelled or failed instead; or, if it really is done another way, close again " +
        "with `reason` saying why (it is recorded on the session and shown)."
    ),
    { code: NOT_DONE_AT_CLOSE, notDone: work }
  );
}

export function isNotDoneAtCloseError(
  err: unknown
): err is Error & { code: typeof NOT_DONE_AT_CLOSE; notDone: NotDoneAtClose } {
  return (
    err instanceof Error &&
    (err as { code?: unknown }).code === NOT_DONE_AT_CLOSE
  );
}

/** The refusal body every agent close door answers with (MCP, Hub REST). */
export function notDoneRefusal(
  err: Error & { code: typeof NOT_DONE_AT_CLOSE; notDone: NotDoneAtClose }
): {
  status: "refused";
  reasonCode: typeof NOT_DONE_AT_CLOSE;
  error: string;
  unmetCriteria: UnmetCriterionAtClose[];
  openOutcomes: OpenOutcomeAtClose[];
} {
  return {
    status: "refused",
    reasonCode: err.code,
    error: err.message,
    unmetCriteria: err.notDone.criteria,
    openOutcomes: err.notDone.outcomes,
  };
}
