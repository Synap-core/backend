/**
 * "Done" is checked, not claimed (firewall F11, pod document 9ca0c96b §5,
 * founder-approved 29 Oct 2026).
 *
 * An AGENT's close with `terminalStatus: "closed"` is refused while the
 * session still owes required work (founder's rules, 29 Oct; overridable):
 *   - a required criterion that does not pass and that the agent can still
 *     check: the same rule as `pendingCriteria` (`evaluations/evaluate.ts`),
 *     ONE rule for "whose move is this criterion";
 *   - a required deliverable an agent owes that is still open (its own, or
 *     one delegated to another agent: `delegatedTo`);
 *   - a required deliverable the PERSON owes that is still open (`owner:
 *     "human"`), the slot an outcome-with-`verify` folds into included: the
 *     session waits for the person, or closes with a reason.
 * The refusal names every one of them and only ways out that work: grade,
 * claim or withdraw the agent's items; wait for the person (leave the session
 * open or pause it); close `cancelled` / `failed` when that is true; or name
 * WHY it closes anyway (`reason`), posted as one line in the session room.
 *
 * WAITING ON THE PERSON'S REVIEW never blocks. It is listed (`waiting`), so
 * the close says what it leaves:
 *   - a criterion only the PERSON can grade (`check.kind: "human"`, one a
 *     person already graded, one ESCALATED to the person: its non-human
 *     attempts are spent, `MAX_NON_HUMAN_ATTEMPTS`, and the criterion folded
 *     from a person-owned outcome with `verify`, whose SLOT blocks instead);
 *   - a deliverable the agent CLAIMED (`claimedDone`) or whose proposal is
 *     pending (pack mode: a pending proposal of the session names the slot).
 * Optional and withdrawn slots are owed by nobody (`isDeliverableOutstanding`).
 *
 * Scope, in the one close door (`completeFocusSession`), by the same signal
 * the OPEN_QUESTIONS refusal uses, `params.agentUserId`:
 *   - an agent through MCP `synap_complete_session` or Hub REST (`/complete`,
 *     PATCH to `closed`) → checked;
 *   - the person (tRPC: keys never reach main /trpc), an approval of an
 *     agent's proposed close (`approvedCloseOf`, the person decided), and the
 *     automatic closes (jobs closer slot, reapers, triage, recap, reactors) →
 *     never checked: the person must always be able to close anything, and an
 *     automatic close is nobody's claim that the work is done.
 *
 * This supersedes, for agent closes only, the earlier rule "close never
 * blocks on criteria" (complete-session.ts); a person's close keeps it.
 */
import {
  deriveSlotKeys,
  isDeliverableOutstanding,
} from "@synap-core/types/units";
import {
  isCriterionRequired,
  readCriteria,
  type ExpectedOutput,
} from "@synap/playbooks";
import {
  db,
  proposals,
  and,
  eq,
  ProposalStatus,
  type FocusSession,
} from "@synap/database";
import {
  listSessionEvaluations,
  summarizeEvaluations,
} from "./evaluations/record.js";
import { readProposalExpectedKey } from "./slot-keys.js";

export const NOT_DONE_AT_CLOSE = "NOT_DONE" as const;

/** Longest `reason` kept; a longer one is clipped, never refused. */
export const NOT_DONE_REASON_MAX = 1000;

/** A required criterion the agent can still move, whose verdict is not `pass`. */
export interface UnmetCriterionAtClose {
  key: string;
  statement: string;
  /** `fail`, or `unmeasured` when it was never graded. */
  verdict: "fail" | "unmeasured";
}

/** A required deliverable that is not done. */
export interface OpenOutcomeAtClose {
  key: string;
  label: string;
  /** Handed to another agent of this type: still agent work, still owed. */
  delegatedTo?: string;
}

/** Why a required item that is not done does not hold the close. */
export type AwaitingPerson =
  "person_check" | "person_graded" | "escalated" | "review" | "proposal";

export interface WaitingAtClose {
  criteria: Array<{
    key: string;
    statement: string;
    waitingOn: AwaitingPerson;
  }>;
  outcomes: Array<{ key: string; label: string; waitingOn: AwaitingPerson }>;
}

export interface NotDoneAtClose {
  /** Blocking: criteria the agent can still check. */
  criteria: UnmetCriterionAtClose[];
  /** Blocking: deliverables an agent owes (its own or a delegate's). */
  outcomes: OpenOutcomeAtClose[];
  /** Blocking: deliverables the person owes. */
  owedByPerson: OpenOutcomeAtClose[];
  /** Not blocking: awaiting the person's grade or review. */
  waiting: WaitingAtClose;
}

/** What is recorded when an agent closes `closed` anyway, with its reason. */
export interface ClosedNotDoneRecord {
  criteria: UnmetCriterionAtClose[];
  outcomes: OpenOutcomeAtClose[];
  owedByPerson: OpenOutcomeAtClose[];
  reason: string;
  by: string;
  at: string;
}

/** A trimmed reason clipped to {@link NOT_DONE_REASON_MAX}; blank ⇒ none. */
export function boundReason(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  if (!t) return undefined;
  return t.length > NOT_DONE_REASON_MAX ? t.slice(0, NOT_DONE_REASON_MAX) : t;
}

/**
 * One `reason` on a close door's wire, routed by the exit it explains:
 * `cancelReason` on `cancelled`, `notDoneReason` on `closed` (the default
 * exit), nothing on `failed`. Never both from one value.
 */
export function closeReasonFields(
  terminalStatus: "closed" | "cancelled" | "failed" | undefined,
  reason: string | undefined
): { cancelReason?: string; notDoneReason?: string } {
  if (!reason) return {};
  const exit = terminalStatus ?? "closed";
  if (exit === "cancelled") return { cancelReason: reason };
  if (exit === "closed") return { notDoneReason: reason };
  return {};
}

/** Longest statement / label quoted back in the refusal sentence. */
const QUOTE_MAX = 100;

function clip(s: string): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > QUOTE_MAX ? `${t.slice(0, QUOTE_MAX - 1)}…` : t;
}

type SlotLike = Partial<ExpectedOutput> & Record<string, unknown>;

/** A stored slot as an object, or null for a malformed entry (never throws). */
function asSlot(raw: unknown): SlotLike | null {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as SlotLike)
    : null;
}

/**
 * Pure: what required work is still open, and whose move it is.
 *
 * `agentMovable` is the set of criterion keys the agent can still check: the
 * output of `pendingCriteria` (the loader computes it). A criterion outside it
 * is waiting on the person; the pure rule only says which person-side reason.
 * `pendingClaims` are the slot keys and labels a pending proposal of this
 * session names (pack mode).
 */
export function openRequiredWork(args: {
  criteria: ReadonlyArray<{
    key: string;
    statement: string;
    required?: boolean;
    check?: { kind?: string };
  }>;
  latest: ReadonlyArray<{
    criterionKey: string;
    verdict: string;
    evaluatorKind?: string;
  }>;
  agentMovable: ReadonlySet<string>;
  expectedOutputs: readonly unknown[];
  pendingClaims?: ReadonlySet<string>;
}): NotDoneAtClose {
  const slots = args.expectedOutputs;
  const keys = deriveSlotKeys(slots);
  const humanSlotKeys = new Set<string>();
  slots.forEach((raw, i) => {
    const s = asSlot(raw);
    const key = keys[i];
    if (s?.owner === "human" && key) humanSlotKeys.add(key);
  });

  const latestOf = new Map(
    args.latest.map((e) => [e.criterionKey, e] as const)
  );
  const waiting: WaitingAtClose = { criteria: [], outcomes: [] };
  const criteria: UnmetCriterionAtClose[] = [];
  for (const c of args.criteria) {
    if (!isCriterionRequired(c)) continue;
    const current = latestOf.get(c.key);
    if (current?.verdict === "pass") continue;
    if (args.agentMovable.has(c.key) && !humanSlotKeys.has(c.key)) {
      criteria.push({
        key: c.key,
        statement: c.statement,
        verdict: current?.verdict === "fail" ? "fail" : "unmeasured",
      });
      continue;
    }
    waiting.criteria.push({
      key: c.key,
      statement: c.statement,
      waitingOn:
        c.check?.kind === "human" || humanSlotKeys.has(c.key)
          ? "person_check"
          : current?.evaluatorKind === "human"
            ? "person_graded"
            : "escalated",
    });
  }

  const criterionKeys = new Set(args.criteria.map((c) => c.key));
  const outcomes: OpenOutcomeAtClose[] = [];
  const owedByPerson: OpenOutcomeAtClose[] = [];
  slots.forEach((raw, i) => {
    const s = asSlot(raw);
    if (!s) return;
    const key = keys[i] ?? "";
    const label = typeof s.label === "string" && s.label ? s.label : key;
    if (!key && !label) return;
    if (!isDeliverableOutstanding(s)) return;
    // Owed by the person: holds an agent's close (founder, 29 Oct), the
    // person-owned slot an outcome-with-`verify` folds into included.
    if (s.owner === "human") {
      owedByPerson.push({ key, label });
      return;
    }
    // Judged by its criterion (one outcome, two stores): listed there.
    if (key && criterionKeys.has(key)) return;
    // Awaiting the person's review: the agent's claim, or its proposal in
    // pack mode. Listed, never refusing.
    const awaiting: AwaitingPerson | null =
      s.claimedDone === true
        ? "review"
        : args.pendingClaims?.has(key) || args.pendingClaims?.has(label)
          ? "proposal"
          : null;
    if (awaiting) {
      waiting.outcomes.push({ key, label, waitingOn: awaiting });
      return;
    }
    const delegatedTo =
      typeof s.delegatedTo === "string" && s.delegatedTo
        ? s.delegatedTo
        : undefined;
    outcomes.push({ key, label, ...(delegatedTo ? { delegatedTo } : {}) });
  });
  return { criteria, outcomes, owedByPerson, waiting };
}

export function hasOpenRequiredWork(w: NotDoneAtClose): boolean {
  return (
    w.criteria.length > 0 || w.outcomes.length > 0 || w.owedByPerson.length > 0
  );
}

export function hasWaiting(w: NotDoneAtClose): boolean {
  return w.waiting.criteria.length > 0 || w.waiting.outcomes.length > 0;
}

/**
 * Read what the session still owes and whose move it is. The verdict comes
 * from the same rows every session door reads (`listSessionEvaluations` →
 * `summarizeEvaluations`), and "the agent can still move it" from the one
 * rule `pendingCriteria`. A failed read THROWS: an unreadable grade is not a
 * passing one.
 */
export async function loadOpenRequiredWork(
  session: Pick<FocusSession, "id" | "userId" | "criteria" | "expectedOutputs">
): Promise<NotDoneAtClose> {
  // Loaded lazily: evaluate.ts pulls the capability runner and the stage
  // gates, which the close door must not load at import time.
  const { pendingCriteria } = await import("./evaluations/evaluate.js");
  // No criteria ⇒ no grades to read (the same skip `loadSessionEvaluationSummary` makes).
  const rows = readCriteria(session.criteria).length
    ? await listSessionEvaluations({
        sessionId: session.id,
        userId: session.userId,
      })
    : [];
  const summary = summarizeEvaluations(session.criteria, rows);
  const movable = new Set(
    pendingCriteria(summary.criteria, rows, summary.evaluations).map(
      (c) => c.key
    )
  );
  const slots = Array.isArray(session.expectedOutputs)
    ? (session.expectedOutputs as unknown[])
    : [];
  // Pack mode: a pending proposal of this session naming a slot. Read only
  // when there is a slot it could name.
  const pending = slots.length
    ? await db
        .select({ data: proposals.data })
        .from(proposals)
        .where(
          and(
            eq(proposals.sessionId, session.id),
            eq(proposals.status, ProposalStatus.PENDING)
          )
        )
    : [];
  const pendingClaims = new Set<string>();
  for (const p of pending) {
    const key = readProposalExpectedKey(p.data);
    if (key) pendingClaims.add(key);
    const label = (p.data as { expectedLabel?: unknown } | null)?.expectedLabel;
    if (typeof label === "string" && label.trim())
      pendingClaims.add(label.trim());
  }
  return openRequiredWork({
    criteria: summary.criteria,
    latest: summary.evaluations,
    agentMovable: movable,
    expectedOutputs: slots,
    pendingClaims,
  });
}

const WAITING_WORDS: Record<AwaitingPerson, string> = {
  person_check: "the person checks it",
  person_graded: "graded by the person",
  escalated: "escalated to the person",
  review: "claimed, awaiting the person's review",
  proposal: "its proposal awaits the person's review",
};

/** One line for what awaits the person's grade or review (never blocking). */
export function describeWaiting(w: WaitingAtClose): string | null {
  const parts = [
    ...w.criteria.map((c) => `${c.key} (${WAITING_WORDS[c.waitingOn]})`),
    ...w.outcomes.map(
      (o) => `${o.key || o.label} (${WAITING_WORDS[o.waitingOn]})`
    ),
  ];
  return parts.length > 0
    ? `Awaiting the person's grade or review, not holding the close: ${parts.join("; ")}.`
    : null;
}

/**
 * The refusal. The sentence carries the whole list, so a door that only
 * forwards `message` still tells the agent exactly what is left and how out.
 * Every way out it names works on exactly the items it lists.
 */
export function notDoneAtCloseError(
  work: NotDoneAtClose
): Error & { code: typeof NOT_DONE_AT_CLOSE; notDone: NotDoneAtClose } {
  const parts: string[] = [];
  const ways: string[] = [];
  if (work.criteria.length > 0) {
    parts.push(
      `required criteria you can still check, not passing: ${work.criteria
        .map(
          (c) =>
            `${c.key} (${c.verdict === "fail" ? "failed" : "not graded"}): "${clip(c.statement)}"`
        )
        .join("; ")}`
    );
    ways.push(
      "grade each criterion with synap_evaluate_session and its real evidence"
    );
  }
  if (work.outcomes.length > 0) {
    parts.push(
      `required outcomes an agent owes, still open: ${work.outcomes
        .map(
          (o) =>
            `${o.key}: "${clip(o.label)}"${o.delegatedTo ? ` (delegated to ${o.delegatedTo})` : ""}`
        )
        .join("; ")}`
    );
    ways.push(
      "claim each finished outcome (synap_update_session completeOutput) or withdraw one no longer wanted (retireOutput)"
    );
  }
  if (work.owedByPerson.length > 0) {
    parts.push(
      `required outcomes the person still owes: ${work.owedByPerson
        .map((o) => `${o.key}: "${clip(o.label)}"`)
        .join("; ")}`
    );
    ways.push(
      "wait for the person: leave the session open, or pause it (synap_update_session status 'paused'), until they answer"
    );
  }
  ways.push(
    "close as cancelled or failed when that is what happened",
    "or close again with `reason` saying why it is done anyway (MCP synap_complete_session, or Hub POST /focus-sessions/:id/complete): the reason is posted in the session room"
  );
  const waiting = describeWaiting(work.waiting);
  return Object.assign(
    new Error(
      `Not closed: the session still owes required work — ${parts.join(" — ")}. ` +
        `Ways out: ${ways.join("; ")}.` +
        (waiting ? ` ${waiting}` : "")
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
  owedByPerson: OpenOutcomeAtClose[];
  waiting: WaitingAtClose;
} {
  return {
    status: "refused",
    reasonCode: err.code,
    error: err.message,
    unmetCriteria: err.notDone.criteria,
    openOutcomes: err.notDone.outcomes,
    owedByPerson: err.notDone.owedByPerson,
    waiting: err.notDone.waiting,
  };
}
