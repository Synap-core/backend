/**
 * SESSION NUDGES — what a session still OWES, said at the door the agent is
 * already calling.
 *
 * Measured 2026-09-25 on session 7c97c528: two days of agent work with no
 * playbook, no stage ever set, 0/5 criteria graded and progress typed by hand.
 * Nothing in the loop was refused — it was simply never asked for, because the
 * loop lived in a skill the agent had to choose to load. So the two write doors
 * an agent reliably calls on its own session (MCP `update_session`,
 * `complete_session`) now answer with what is still owed.
 *
 * READ-ONLY by contract: a nudge never blocks, never proposes, never changes
 * governance. `complete_session` closes exactly as before; the nudge only says
 * what closed ungraded. The ONE write in this module is the offer stamp
 * (`metadata.playbookOfferedAt`, see `claimPlaybookOffer`) — bookkeeping that
 * makes the playbook offer fire once, never a change to the work.
 *
 * NOTHING HERE RE-DERIVES A VERDICT. Which evaluation row is current for a
 * criterion is decided by `summarizeEvaluations` (→ `latestEvaluationPerCriterion`,
 * human wins); this module only reads that row's verdict. Ranking playbooks is
 * `matchSessionTemplate`, the same matcher the start door uses. Owed-by-the-
 * person is `isOwedSlot`, the predicate the needs-you read uses.
 */
import {
  db,
  focusSessions,
  and,
  eq,
  inArray,
  desc,
  drizzleSql,
} from "@synap/database";
import type { FocusSession } from "@synap/database";
import type { ExpectedOutput } from "@synap/playbooks";
import { resolveSessionTitle } from "@synap-core/types/focus-sessions";
import {
  attachSessionVerdicts,
  loadSessionEvaluationSummary,
  type SessionEvaluationSummary,
} from "./evaluations/record.js";
import {
  matchSessionTemplate,
  type PlaybookCandidate,
} from "./match-session-template.js";
import { isOwedSlot } from "./owed-outputs.js";
import { isOpenAgentSlot } from "./continuation-packet.js";
import { OPEN_SESSION_STATUSES } from "./session-statuses.js";
import { mergeSessionMetadata } from "./session-metadata.js";
import { openLink } from "../../utils/deep-links.js";

/** How many playbook candidates ride on a nudge — cheap, never the full list. */
export const NUDGE_PLAYBOOK_CANDIDATES_MAX = 3;

/** The metadata key that records the playbook offer was made (once). */
export const PLAYBOOK_OFFERED_AT_KEY = "playbookOfferedAt";

export type NudgePhase = "update" | "complete";

/** The fields of a session row the nudges read. */
export type NudgeSessionLike = Pick<
  FocusSession,
  | "playbookId"
  | "origin"
  | "currentStage"
  | "stages"
  | "expectedOutputs"
  | "metadata"
>;

export interface SessionNudges {
  /** Declared criteria with no pass/fail verdict yet (keys). */
  ungradedCriteria?: string[];
  /** The session declares no criteria — "done" can only be announced. */
  noCriteria?: true;
  /**
   * The session has stages and `currentStage` is unset, or (at complete) it
   * never reached the last one. Absent for a session with no stages — a
   * stageless playbook keeps `currentStage` NULL by design.
   */
  stage?: {
    state: "unset" | "not_final";
    current: string | null;
    stages: string[];
  };
  /** Outputs handed to the person (`owner: 'human'`) still pending. */
  owedByPerson?: number;
  /**
   * Labels of outputs the PERSON ANSWERED (`answer-slot.ts`) that are still
   * open on the agent — the answer is waiting to be acted on.
   */
  answered?: string[];
  /** Ranked playbooks for a session born without one — offered once. */
  playbookCandidates?: PlaybookCandidate[];
  /** One imperative line per nudge above, in the same order. */
  hints: string[];
}

/** A nudge read that failed — never folded into "nothing owed". */
export interface SessionNudgesUnavailable {
  status: "unavailable";
}

function stageKeys(stages: unknown): string[] {
  if (!Array.isArray(stages)) return [];
  return stages
    .map((s) => (s as { key?: unknown } | null)?.key)
    .filter((k): k is string => typeof k === "string" && k.length > 0);
}

function readSlots(raw: unknown): ExpectedOutput[] {
  return Array.isArray(raw) ? (raw as ExpectedOutput[]) : [];
}

/**
 * Pure: should THIS session be offered the pod's playbooks? It was born
 * without one (not a playbook run, nothing followed) and was never offered.
 */
export function shouldOfferPlaybooks(session: NudgeSessionLike): boolean {
  if (session.playbookId || session.origin === "playbook") return false;
  const meta = (session.metadata ?? {}) as Record<string, unknown>;
  return meta[PLAYBOOK_OFFERED_AT_KEY] === undefined;
}

/**
 * Pure: what the session still owes. `undefined` when nothing is owed — the
 * door then OMITS the field (absence says zero).
 */
export function computeSessionNudges(input: {
  session: NudgeSessionLike;
  evaluation: Pick<SessionEvaluationSummary, "criteria" | "evaluations">;
  phase: NudgePhase;
  playbookCandidates?: PlaybookCandidate[];
}): SessionNudges | undefined {
  const { session, evaluation, phase } = input;
  const out: SessionNudges = { hints: [] };

  // The CURRENT row per criterion is the shared summary's decision; a row that
  // says `unmeasured` is not a grade.
  const current = new Map(
    evaluation.evaluations.map((e) => [e.criterionKey, e.verdict])
  );
  if (evaluation.criteria.length === 0) {
    out.noCriteria = true;
    out.hints.push(
      "No criteria: propose 2–5 binary ones with update_session `criteria` so done can be checked, not announced."
    );
  } else {
    const ungraded = evaluation.criteria
      .map((c) => c.key)
      .filter((k) => {
        const v = current.get(k);
        return v !== "pass" && v !== "fail";
      });
    if (ungraded.length > 0) {
      out.ungradedCriteria = ungraded;
      out.hints.push(
        phase === "complete"
          ? `Closed with ${ungraded.length} ungraded criteri${ungraded.length === 1 ? "on" : "a"} — grade them now with evaluate_session and real evidence.`
          : `${ungraded.length} criteri${ungraded.length === 1 ? "on" : "a"} ungraded — grade with evaluate_session and real evidence before saying done.`
      );
    }
  }

  const stages = stageKeys(session.stages);
  if (stages.length > 0) {
    const cur = session.currentStage ?? null;
    if (cur === null) {
      out.stage = { state: "unset", current: null, stages };
      out.hints.push(
        `currentStage is unset — set it to the phase you are in (${stages.join(" → ")}).`
      );
    } else if (phase === "complete" && cur !== stages[stages.length - 1]) {
      out.stage = { state: "not_final", current: cur, stages };
      out.hints.push(
        `Closed at stage "${cur}", not the last ("${stages[stages.length - 1]}") — advance currentStage as the work moves.`
      );
    }
  }

  // Answered and back with the agent, not yet delivered or claimed — the same
  // open-agent-slot rule the continuation packet's `aiCanDo` uses.
  const answered = readSlots(session.expectedOutputs)
    .filter((s) => !!s?.answer && isOpenAgentSlot(s))
    .map((s) => s.label);
  if (answered.length > 0) {
    out.answered = answered;
    out.hints.push(
      `The person answered ${answered.length === 1 ? `"${answered[0]}"` : `${answered.length} outputs`} — read the answer (get_session aiCanDo) and continue.`
    );
  }

  const owed = readSlots(session.expectedOutputs).filter(isOwedSlot).length;
  if (owed > 0) {
    out.owedByPerson = owed;
    out.hints.push(
      `${owed} output${owed === 1 ? " is" : "s are"} owed by the person — ask them in the session room (post_message to session.channelId).`
    );
  }

  if (input.playbookCandidates && input.playbookCandidates.length > 0) {
    out.playbookCandidates = input.playbookCandidates.slice(
      0,
      NUDGE_PLAYBOOK_CANDIDATES_MAX
    );
    out.hints.push(
      "No playbook: if one of playbookCandidates fits, follow it with update_session `followPlaybookId`. Offered once."
    );
  }

  return out.hints.length > 0 ? out : undefined;
}

/**
 * Stamp the offer ONCE. Atomic: only the call that flips the key wins, so two
 * concurrent updates never both carry the candidates. Owner-floored.
 */
export async function claimPlaybookOffer(
  sessionId: string,
  userId: string
): Promise<boolean> {
  const won = await db
    .update(focusSessions)
    .set({
      metadata: mergeSessionMetadata({
        [PLAYBOOK_OFFERED_AT_KEY]: new Date().toISOString(),
      }),
    })
    .where(
      and(
        eq(focusSessions.id, sessionId),
        eq(focusSessions.userId, userId),
        drizzleSql`NOT (coalesce(${focusSessions.metadata}, '{}'::jsonb) ? ${PLAYBOOK_OFFERED_AT_KEY})`
      )
    )
    .returning({ id: focusSessions.id });
  return won.length > 0;
}

/**
 * The door-side loader: read the evaluation summary (the shared read), rank
 * playbooks when an offer is due (update only), and compute. A failed read is
 * `unavailable`, never "nothing owed" — and never a thrown error: a nudge must
 * not fail the write it rides on.
 */
export async function loadSessionNudges(p: {
  session: FocusSession;
  phase: NudgePhase;
  userId: string;
  agentUserId?: string | null;
}): Promise<SessionNudges | SessionNudgesUnavailable | undefined> {
  let evaluation: SessionEvaluationSummary;
  try {
    evaluation = await loadSessionEvaluationSummary(p.session);
  } catch {
    return { status: "unavailable" };
  }
  let playbookCandidates: PlaybookCandidate[] | undefined;
  if (p.phase === "update" && shouldOfferPlaybooks(p.session)) {
    try {
      const ranked = await matchSessionTemplate({
        userId: p.userId,
        agentUserId: p.agentUserId ?? undefined,
        workspaceId: p.session.workspaceId,
        title: p.session.title,
        goal: p.session.goal,
      });
      // Nothing matched: no stamp, so a later update (new words) may still
      // match. Something matched: offer it only if THIS call won the stamp.
      if (
        ranked.candidates.length > 0 &&
        (await claimPlaybookOffer(p.session.id, p.userId))
      ) {
        playbookCandidates = ranked.candidates.slice(
          0,
          NUDGE_PLAYBOOK_CANDIDATES_MAX
        );
      }
    } catch {
      // The offer is a courtesy; the owed criteria/stage nudges still stand.
    }
  }
  return computeSessionNudges({
    session: p.session,
    evaluation,
    phase: p.phase,
    playbookCandidates,
  });
}

/** Open sessions read before reporting "at least N". */
export const SESSIONS_OWING_GRADE_READ_CAP = 10;

export interface SessionsOwingGrade {
  count: number;
  /** True when the read cap was hit — "at least this many". */
  countIsLowerBound: boolean;
  /** Open sessions the caller OWNS (any agent working for them), any kind. */
  lens: "owned-open";
  items: Array<{
    id: string;
    title: string;
    ungraded: number;
    link: string;
  }>;
}

/**
 * orient's `sessionsOwingGrade`: open sessions this user owns (any kind — a
 * playbook run declares criteria as much as ad-hoc work does) that declare
 * criteria and hold at least one without a pass/fail verdict. Reads
 * the newest `SESSIONS_OWING_GRADE_READ_CAP` sessions WITH criteria, grades
 * them through the shared batch verdict (one query), keeps the owing ones.
 * Throws on a failed read — the caller reports `unavailable`.
 */
export async function listSessionsOwingGrade(
  userId: string
): Promise<SessionsOwingGrade> {
  const rows = await db
    .select({
      id: focusSessions.id,
      userId: focusSessions.userId,
      title: focusSessions.title,
      goal: focusSessions.goal,
      criteria: focusSessions.criteria,
    })
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.userId, userId),
        inArray(
          focusSessions.status,
          OPEN_SESSION_STATUSES.filter((s) => s !== "scheduled")
        ),
        drizzleSql`(CASE WHEN jsonb_typeof(${focusSessions.criteria}) = 'array' THEN jsonb_array_length(${focusSessions.criteria}) ELSE 0 END) > 0`
      )
    )
    // SESSION-KIND-LENS-EXEMPT: a count + id/title summary for orient, never a page of session rows — every open kind that declares criteria owes its grade.
    .orderBy(desc(focusSessions.updatedAt))
    .limit(SESSIONS_OWING_GRADE_READ_CAP);
  const graded = await attachSessionVerdicts(rows);
  const owing = graded.filter((r) => (r.verdict?.unmeasured ?? 0) > 0);
  return {
    count: owing.length,
    countIsLowerBound: rows.length >= SESSIONS_OWING_GRADE_READ_CAP,
    lens: "owned-open",
    items: owing.map((r) => ({
      id: r.id,
      title: resolveSessionTitle(r),
      ungraded: r.verdict!.unmeasured,
      link: openLink(r.id),
    })),
  };
}
