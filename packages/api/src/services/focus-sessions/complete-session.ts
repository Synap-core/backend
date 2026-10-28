/**
 * completeFocusSession — lifecycle close for a focus session.
 *
 * THE ONE CLOSE DOOR. Every terminal exit — `closed`, `cancelled`, `failed`,
 * from any surface — runs through here: MCP `synap_complete_session`,
 * session-recap, triage discard, and (since `routers/focus-sessions.ts`'s update
 * funnels a terminal `status` into this service) the tRPC and Hub REST doors
 * too. The dual path those two used to take is CLOSED; the older note here that
 * said otherwise outlived the fix and is corrected.
 *
 * Closes running playbook_run, stamps the terminal status + report, expires the
 * session-bound ephemeral proposals, emits the close event, and returns a
 * **proposal pack** (pending proposals for this session).
 *
 * ── WHAT HAPPENS TO OWED SLOTS ──────────────────────────────────────────────
 * A slot handed to the human (`owner: 'human'`) OUTLIVES the session on
 * `closed`, `failed` and `stale`: the work was declared, the session ended, and
 * somebody still has to do it. `listOwedSlots` reads them back regardless of
 * session status precisely so they cannot be lost by closing the window they
 * were declared in.
 *
 * `cancelled` is the one exit that ends the obligation — the work is not
 * happening — and it STAMPS them (`retiredAt` + `retiredReason`) rather than
 * deleting them. A receipt, like `delegatedAt` / `returnedAt`: the slot, its
 * blocker and its `owedSince` stay readable, the stamp is reversible, and
 * deletion would be the only irreversible operation in this subsystem.
 *
 * `stale` never reaches this door at all (it is not a terminal status; the
 * focus-session reaper stamps it directly), so its slots survive. That is the
 * INTENDED outcome and it is now stated rather than left to accident: a session
 * the reaper gave up on is the strongest case there is for the human still
 * owing what they said they would do.
 *
 * One kind of owed slot does end on `closed` / `failed` too (founder,
 * 2026-10-26): a `confirm` / `choose` ask is the AGENT's need, and it
 * is stamped `session_ended` (`retirementForClose`). An `act`, `provide` or
 * `form` ask, or a slot with no ask, is the person's deliverable and stays owed.
 *
 * ── WHAT HAPPENS TO ROOM QUESTIONS ──────────────────────────────────────────
 * Every exit stamps the room's still-open agent questions `closed:
 * session_ended` (never deleted): they leave needs-you and no later reply in
 * the room reads as their answer. A room another session that has not ended
 * still uses is left alone: its questions may be that work's. Before that, an
 * AGENT closing as `closed` / `failed` must say what becomes of each question
 * IT asked (`questionDispositions`), or the close is refused with the list:
 * an agent that walks away from its own questions leaves the person answering
 * into a void. A person's close, a cancel and the reapers are never refused.
 */
import {
  db,
  focusSessions,
  messages,
  playbookRuns,
  proposals,
  ProposalStatus,
  eq,
  ne,
  notInArray,
  and,
  asc,
  desc,
  drizzleSql,
  liveRunStatusWhere,
  playbooks,
  stampOpenWorkerTargets,
  closeOpenRoomQuestions,
  openRoomQuestionConditions,
} from "@synap/database";
import { WORKER_TARGET_REASONS } from "@synap-core/types/workers";
import { isDeliverableOutstanding } from "@synap-core/types/units";
import { ASK_LIMITS } from "@synap-core/types/ask";
import type { FocusSession } from "@synap/database";
import type { ExpectedOutput } from "@synap/playbooks";
import { retirementForClose } from "./owed-outputs.js";
import {
  readRoomPostMeta,
  questionShortId,
  type CloseQuestionDisposition,
} from "../messaging/room-post-kind.js";
import { settleSessionNeedsYou } from "./notify-needs-you.js";
import {
  checkPermissionOrPropose,
  proposedMessageFor,
} from "../../utils/permission-check.js";
import { emitSideEffects } from "@synap/events";
import { expireSessionEphemerals } from "../proposals/expire-lapsed-proposals.js";
import { logEvent } from "../../lib/event-helpers.js";
import {
  FOCUS_SESSION_SUBJECT_TYPE,
  FOCUS_SESSION_CLOSE_ACTION,
  FOCUS_SESSION_CLOSED_EVENT_TYPE,
} from "./close-event.js";
import {
  isTerminalSessionStatus,
  TERMINAL_SESSION_STATUSES,
} from "./session-statuses.js";
import {
  stopSessionWork,
  cancelRecordMetadataSql,
  type SessionCancelRecord,
} from "./cancel-session.js";
import type { SessionVerdict } from "@synap-core/types/focus-sessions";
import { loadSessionEvaluationSummary } from "./evaluations/record.js";
import { sessionNameField } from "./session-update-goal.js";
import { createLogger } from "@synap-core/core";
import {
  isPinnedStrategy,
  metadataAfterUnpin,
  shouldDropPin,
} from "../playbooks/pinned-subject.js";
import { settleParentAutomationRunFromChild } from "@synap/jobs";

const logger = createLogger({ module: "complete-focus-session" });

/** The error a run carries when its session closed as `failed`. */
export const SESSION_FAILED_RUN_ERROR = "The session closed as failed.";

export interface CompleteFocusSessionParams {
  sessionId: string;
  userId: string;
  agentUserId?: string;
  /** Short human-readable outcome — surfaced in session lists. */
  summary?: string;
  verificationReport?: Record<string, unknown> | null;
  /**
   * Which terminal state the session lands in. `closed` is the ordinary
   * completion; `cancelled` / `failed` are the same lifecycle exit with a
   * different verdict. ONE door for all three: every exit expires the
   * session-bound ephemerals and emits the close event, so a session that is
   * cancelled through the ordinary update door can no longer leave its drafts
   * alive and its dependents unblocked in silence.
   */
  terminalStatus?: "closed" | "cancelled" | "failed";
  /** Why it was cancelled — kept on `metadata.run.cancel`. Ignored unless `cancelled`. */
  cancelReason?: string;
  /**
   * The closing AGENT's word on each question it asked in the room that is
   * still open. Required for every one of them on an agent's `closed` /
   * `failed` close (else {@link openQuestionsAtCloseError}); read only with
   * `agentUserId`.
   */
  questionDispositions?: CloseQuestionDisposition[];
  /**
   * The approval of an agent's PROPOSED close (the `focus_session/update`
   * executor): the agent whose `questionDispositions` ride on the proposal.
   * Its word on its own questions is applied as if it had closed directly;
   * it governs nothing (the person's approval already did) and refuses
   * nothing — a question it did not cover closes with the session.
   */
  approvedCloseOf?: string;
}

/** One of the closing agent's still-open questions, as the refusal lists it. */
export interface OpenQuestionAtClose {
  messageId: string;
  /** `Q-` + the first 8 characters of the message id — how agents show it in chat. */
  shortId: string;
  text: string;
  slotLabel: string | null;
}

export const OPEN_QUESTIONS_AT_CLOSE = "OPEN_QUESTIONS" as const;

/** Longest question text quoted back in the refusal sentence. */
const QUESTION_QUOTE_MAX = 120;

function clipText(s: string, max: number): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * The refusal an agent's close gets while it leaves its own questions open.
 * The sentence carries the list, so a door that only forwards `message` still
 * tells the agent what to settle and how.
 */
export function openQuestionsAtCloseError(
  questions: OpenQuestionAtClose[]
): Error & {
  code: typeof OPEN_QUESTIONS_AT_CLOSE;
  openQuestions: OpenQuestionAtClose[];
} {
  const list = questions
    .map(
      (q) =>
        `${q.shortId} (messageId ${q.messageId}): "${clipText(q.text, QUESTION_QUOTE_MAX)}"`
    )
    .join("; ");
  return Object.assign(
    new Error(
      `Not closed: ${questions.length} question(s) you asked the person in this session's room are still open — ${list}. ` +
        "Settle each: relay the person's exact words (relay_answer), or close through the complete door with " +
        "questionDispositions (withdrawn with a note / keep_as_owed)."
    ),
    { code: OPEN_QUESTIONS_AT_CLOSE, openQuestions: questions }
  );
}

/**
 * The refusal body every close door answers {@link openQuestionsAtCloseError}
 * with (Hub `/complete`, Hub PATCH to a terminal status, MCP
 * `synap_complete_session`): one shape, whichever door the agent closed by.
 */
export function openQuestionsRefusal(
  err: Error & {
    code: typeof OPEN_QUESTIONS_AT_CLOSE;
    openQuestions: OpenQuestionAtClose[];
  }
): {
  status: "refused";
  reasonCode: typeof OPEN_QUESTIONS_AT_CLOSE;
  error: string;
  openQuestions: OpenQuestionAtClose[];
} {
  return {
    status: "refused",
    reasonCode: err.code,
    error: err.message,
    openQuestions: err.openQuestions,
  };
}

export function isOpenQuestionsAtCloseError(err: unknown): err is Error & {
  code: typeof OPEN_QUESTIONS_AT_CLOSE;
  openQuestions: OpenQuestionAtClose[];
} {
  return (
    err instanceof Error &&
    (err as { code?: unknown }).code === OPEN_QUESTIONS_AT_CLOSE
  );
}

/**
 * Match the agent's dispositions to its open questions. Pure. `uncovered` is
 * what the refusal lists; a disposition naming no open question of this agent
 * (answered meanwhile, someone else's, a typo) is counted, never applied.
 */
function planQuestionDispositions(
  open: readonly OpenQuestionAtClose[],
  dispositions: readonly CloseQuestionDisposition[] = []
): {
  uncovered: OpenQuestionAtClose[];
  withdrawn: Array<{ question: OpenQuestionAtClose; note?: string }>;
  keep: OpenQuestionAtClose[];
  unmatched: number;
} {
  const byId = new Map(open.map((q) => [q.messageId, q]));
  const decided = new Map<string, CloseQuestionDisposition>();
  let unmatched = 0;
  for (const d of dispositions) {
    if (byId.has(d.messageId)) decided.set(d.messageId, d);
    else unmatched += 1;
  }
  const withdrawn: Array<{ question: OpenQuestionAtClose; note?: string }> = [];
  const keep: OpenQuestionAtClose[] = [];
  const uncovered: OpenQuestionAtClose[] = [];
  for (const q of open) {
    const d = decided.get(q.messageId);
    if (d?.disposition === "withdrawn") {
      // The stamp's bound (`QuestionClosedSchema.note`).
      const note = d.note?.trim().slice(0, ASK_LIMITS.promptMaxChars);
      withdrawn.push({ question: q, ...(note ? { note } : {}) });
    } else if (d?.disposition === "keep_as_owed") keep.push(q);
    // No word, or a word that is neither: never read as "keep".
    else uncovered.push(q);
  }
  return { uncovered, withdrawn, keep, unmatched };
}

/**
 * Does another session that has not ended still use this room? Then the
 * room's open questions are not this session's to settle: the close neither
 * stamps them nor refuses over them (the guard migration 0358 applied to the
 * sessions that ended before the rule).
 */
async function roomUsedByAnotherLiveSession(
  channelId: string,
  sessionId: string
): Promise<boolean> {
  const [other] = await db
    .select({ id: focusSessions.id })
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.channelId, channelId),
        ne(focusSessions.id, sessionId),
        notInArray(focusSessions.status, [...TERMINAL_SESSION_STATUSES])
      )
    )
    .limit(1);
  return !!other;
}

/** The agent's own still-open questions in a room, oldest first. */
async function loadAgentOpenQuestions(
  channelId: string,
  agentUserId: string
): Promise<OpenQuestionAtClose[]> {
  const rows = await db
    .select({
      id: messages.id,
      content: messages.content,
      metadata: messages.metadata,
    })
    .from(messages)
    .where(
      and(
        eq(messages.channelId, channelId),
        eq(messages.routedTeammateId, agentUserId),
        ...openRoomQuestionConditions(messages)
      )
    )
    .orderBy(asc(messages.timestamp))
    .limit(100);
  return rows.map((r) => ({
    messageId: r.id,
    shortId: questionShortId(r.id),
    text: r.content,
    slotLabel: readRoomPostMeta(r.metadata)?.slotLabel ?? null,
  }));
}

/** The slot `why` ceiling (`room-question-slot.ts`). */
const KEPT_WHY_MAX = 500;
/** A new slot's label: the question's first words. */
const KEPT_LABEL_MAX = 120;
/**
 * What a question kept owed past its session's close unblocks (decision E):
 * the session is over, so the answer only goes back to the agent that asked.
 */
const KEPT_QUESTION_UNBLOCKS = "The answer goes back to the agent that asked";

/**
 * Hand a question the agent keeps owed to the person, through the slot doors
 * that already do it: a question about a slot re-files on THAT slot
 * (`fileRoomQuestionOnSlot`, the block door); a slotless one becomes a new
 * human slot (`updateFocusSession` `addOutput`, governed like any agent
 * declaration). Returns the slot's stored label, or why it could not.
 */
async function keepQuestionOwed(p: {
  sessionId: string;
  channelId: string;
  userId: string;
  agentUserId: string;
  question: OpenQuestionAtClose;
}): Promise<{ label: string } | { warning: string }> {
  const { question } = p;
  const why = clipText(question.text, KEPT_WHY_MAX);
  if (question.slotLabel) {
    const { fileRoomQuestionOnSlot } = await import("./room-question-slot.js");
    const filed = await fileRoomQuestionOnSlot({
      channelId: p.channelId,
      slotLabel: question.slotLabel,
      question: question.text,
      unblocks: KEPT_QUESTION_UNBLOCKS,
      agentUserId: p.agentUserId,
      userId: p.userId,
    });
    if (filed.status === "blocked") return { label: filed.expectedLabel };
    if (filed.status === "already_done") {
      return {
        warning: `${question.shortId}: its slot "${question.slotLabel}" is already delivered, so nothing is left owed.`,
      };
    }
    if (filed.status !== "unknown_label") {
      return {
        warning: `${question.shortId} could not be kept owed (${filed.status}); it was closed with the session.`,
      };
    }
    // The slot it named is gone: keep it as a new slot, like a slotless one.
  }
  const label = clipText(question.text.split("\n")[0] ?? "", KEPT_LABEL_MAX);
  const { updateFocusSession } = await import("./update-session.js");
  const added = await updateFocusSession({
    sessionId: p.sessionId,
    userId: p.userId,
    agentUserId: p.agentUserId,
    addOutput: {
      kind: "decision",
      label: label || question.shortId,
      owner: "human",
      blockedReason: "decision",
      why,
      unblocks: KEPT_QUESTION_UNBLOCKS,
    },
  });
  if (added.status === "updated") return { label: label || question.shortId };
  if (added.status === "proposed") {
    return {
      warning: `${question.shortId}: keeping it owed was proposed for review (proposal ${added.proposalId}); the question closed with the session and the slot lands when that is approved.`,
    };
  }
  return {
    warning: `${question.shortId} could not be kept owed (${added.status === "denied" ? added.reason : added.status}); it was closed with the session.`,
  };
}

export type ProposalPackItem = {
  id: string;
  status: string;
  proposalType: string | null;
  summary: string | null;
  workspaceId: string | null;
  createdAt: Date | null;
};

export type CompleteFocusSessionResult = {
  session: FocusSession;
  /** Pending proposals attributed to this session (review pack). */
  pendingProposals: ProposalPackItem[];
  counts: {
    pending: number;
    /** expectedOutputs still status !== done (warn only — does not block close). */
    unfinishedOutputs: number;
    /**
     * Ephemeral proposals retired because this session closed — bound to it and
     * no longer answerable. Reported so the close is never a silent retirement.
     */
    expiredEphemerals: number;
    /**
     * Owed (human-owned, not-done) outputs RETIRED by this close: every one on
     * `cancelled`; only the `confirm` / `choose` asks on `closed` / `failed`
     * (`retirementForClose`).
     */
    retiredSlots: number;
    /** Room questions still open at the end, stamped `closed: session_ended`. */
    closedQuestions: number;
  };
  warnings: string[];
  /** `cancelled` only: what was stopped, what will finish, what already applied. */
  cancel?: SessionCancelRecord;
  /**
   * The session's grade against its criteria at close. Never blocks the close:
   * unmet required criteria close FLAGGED (a warning + this), not refused.
   */
  verdict?: SessionVerdict;
};

/**
 * The `verification_report` write for a close. MERGES (shallow) into whatever
 * is stored instead of replacing it: the CLI writes `codeQuality` into the
 * report mid-session, and a close that carried only a summary used to erase
 * it. An explicit `null` report still CLEARS. Returns `undefined` when the
 * close has nothing to say about the report.
 */
export function closeReportPatch(args: {
  summary?: string;
  verificationReport?: Record<string, unknown> | null;
  unfinishedOutputs: number;
}): Record<string, unknown> | null | undefined {
  const { summary, verificationReport, unfinishedOutputs } = args;
  if (verificationReport === null) return null;
  const patch = {
    ...(summary !== undefined ? { summary } : {}),
    ...(verificationReport ?? {}),
    ...(unfinishedOutputs > 0 ? { unfinishedOutputs } : {}),
  };
  return Object.keys(patch).length > 0 ? patch : undefined;
}

function packItem(row: typeof proposals.$inferSelect): ProposalPackItem {
  const data = (row.data ?? {}) as Record<string, unknown>;
  const summary =
    typeof data.summary === "string"
      ? data.summary
      : typeof data.targetName === "string"
        ? data.targetName
        : null;
  return {
    id: row.id,
    status: row.status,
    proposalType: row.proposalType ?? null,
    summary,
    workspaceId: row.workspaceId ?? null,
    createdAt: row.createdAt ?? null,
  };
}

export async function completeFocusSession(
  params: CompleteFocusSessionParams
): Promise<CompleteFocusSessionResult | null> {
  const {
    sessionId,
    summary,
    verificationReport,
    terminalStatus = "closed",
  } = params;

  const session = await db.query.focusSessions.findFirst({
    where: and(
      eq(focusSessions.id, sessionId),
      eq(focusSessions.userId, params.userId)
    ),
  });
  if (!session) return null;

  // Already-terminal guard lives HERE, in the one close door, not in each
  // caller: a second close would re-run the membrane, re-stamp `closedAt` and
  // re-emit the close event (the unblock reactor is idempotent by group key,
  // the automation matcher is not). Return the row as it stands, no side
  // effects — the caller asked for a closed session and has one.
  if (isTerminalSessionStatus(session.status)) {
    return {
      session: session as FocusSession,
      pendingProposals: [],
      counts: {
        pending: 0,
        unfinishedOutputs: 0,
        expiredEphemerals: 0,
        retiredSlots: 0,
        closedQuestions: 0,
      },
      warnings: [],
    };
  }

  // THE AGENT'S OWN QUESTIONS, before governance: a refused close files no
  // proposal and changes nothing. A cancel is exempt — abandoning the work is
  // the disposition — and so is every close no agent made.
  const questionsOf = params.agentUserId ?? params.approvedCloseOf;
  const roomShared = session.channelId
    ? await roomUsedByAnotherLiveSession(session.channelId, sessionId)
    : false;
  const agentQuestions =
    questionsOf && session.channelId && terminalStatus !== "cancelled"
      ? planQuestionDispositions(
          await loadAgentOpenQuestions(session.channelId, questionsOf),
          params.questionDispositions
        )
      : null;
  if (
    params.agentUserId &&
    !roomShared &&
    agentQuestions &&
    agentQuestions.uncovered.length > 0
  ) {
    throw openQuestionsAtCloseError(agentQuestions.uncovered);
  }

  // Lifecycle close must not be blocked by session forceProposeWrites (pack mode).
  // ignoreSessionForcePropose keeps auto-approve / execute path for complete only.
  // When a proposal is still required, gate data carries goal + summary so the
  // proposal card and focus_session/update executor can complete the session.
  const perm = await checkPermissionOrPropose({
    userId: params.userId,
    agentUserId: params.agentUserId,
    workspaceId: session.workspaceId,
    // Attribute + honor pack-mode escape: stamp would force-propose without
    // ignoreSessionForcePropose; both must be set for lifecycle complete.
    sessionId,
    subjectType: "focus_session",
    action: "update",
    source: "intelligence",
    data: {
      id: sessionId,
      status: terminalStatus,
      goal: session.goal,
      ...sessionNameField(session),
      previousStatus: session.status,
      ...(summary !== undefined ? { sessionSummary: summary } : {}),
      ...(verificationReport != null ? { verificationReport } : {}),
      // A proposed close carries the agent's word on its own questions, so
      // the approval applies it (`approvedCloseOf`) instead of dropping it.
      ...(params.agentUserId && params.questionDispositions?.length
        ? { questionDispositions: params.questionDispositions }
        : {}),
    },
    ignoreSessionForcePropose: true,
  });

  if ("denied" in perm && perm.denied) {
    throw Object.assign(new Error(perm.reason), { code: "FORBIDDEN" });
  }
  if ("proposalId" in perm) {
    // Hub REST surfaces proposalId/summary/review*; human approve runs
    // focus_session/update which reuses completeFocusSession (no agentUserId).
    throw Object.assign(
      new Error(
        proposedMessageFor(
          perm.proposalType,
          "Session completion proposed for review — approval required"
        )
      ),
      {
        code: "FORBIDDEN",
        proposalId: perm.proposalId,
        proposalType: perm.proposalType,
        summary: perm.summary,
        reasoning: perm.reasoning,
        reviewPath: perm.reviewPath,
        reviewUrl: perm.reviewUrl,
      }
    );
  }

  const [run] = await db
    .select()
    .from(playbookRuns)
    .where(
      and(
        eq(playbookRuns.sessionId, sessionId),
        // LIVE, not just `running`: a run the reaper parked as
        // `waiting_on_you` must still finish when its session does.
        liveRunStatusWhere(playbookRuns.status)
      )
    )
    .limit(1);

  // `keep_as_owed`, through the slot doors, before the close takes the row
  // lock: the slots it hands over are then in the array the retirement reads,
  // and `keep` exempts them by label.
  const warnings: string[] = [];
  const keep = new Set<string>();
  if (agentQuestions && questionsOf && session.channelId) {
    for (const question of agentQuestions.keep) {
      const kept = await keepQuestionOwed({
        sessionId,
        channelId: session.channelId,
        userId: params.userId,
        agentUserId: questionsOf,
        question,
      });
      if ("label" in kept) keep.add(kept.label);
      else warnings.push(kept.warning);
    }
    if (agentQuestions.unmatched > 0) {
      warnings.push(
        `${agentQuestions.unmatched} question disposition(s) named no open question of yours in this room — ignored.`
      );
    }
  }

  if (run) {
    // The run's terminal status FOLLOWS how the session closed. Stamping
    // `completed` on a failed/cancelled close hid the failure from the parent
    // automation run (the settle helper only reacts to a `failed` child).
    const runStatus =
      terminalStatus === "failed"
        ? "failed"
        : terminalStatus === "cancelled"
          ? "cancelled"
          : "completed";
    await db
      .update(playbookRuns)
      .set({
        status: runStatus,
        completedAt: new Date(),
        error: runStatus === "failed" ? SESSION_FAILED_RUN_ERROR : null,
      })
      .where(eq(playbookRuns.id, run.id));
    // The parent automation run settles from its children (never throws).
    await settleParentAutomationRunFromChild({ playbookRunId: run.id });
  }

  // THE owed floor (`isDeliverableOutstanding`): a retired or OPTIONAL slot is
  // owed by nobody, so it is no reason to warn.
  const unfinishedOutputs = (
    (session.expectedOutputs as ExpectedOutput[] | null) ?? []
  ).filter((o) => isDeliverableOutstanding(o)).length;

  // The close retires slots (see the header: all of them on cancel, the
  // agent's confirm/choose asks otherwise). Stamped, never deleted. Computed
  // inside the update's own transaction, from a ROW-LOCKED read, and only there.
  //
  // WHY NOT FROM `session` ABOVE. That row was loaded BEFORE the governance
  // membrane, which is an await of unbounded duration (it can hit the policy
  // engine and write a proposal). `expectedOutputs` is JSONB written WHOLESALE
  // by five other doors — attest, satisfy, delegate, return, the update merge —
  // every one of which takes `FOR UPDATE` precisely because a stale read here is
  // a lost write. This one did not, and it does not merely lose the retirement:
  // it writes the WHOLE array back, so an attestation landing during the
  // membrane was silently reverted, receipt and all.
  let retiredSlots = 0;
  let closedQuestions = 0;

  if (unfinishedOutputs > 0) {
    warnings.push(
      `${unfinishedOutputs} expected output(s) still not marked done — session closed anyway (warn-only).`
    );
  }

  // CANCEL IS CANCEL (cancel-session.ts): the INTENT commits with the status —
  // only now, after the gate let the cancel through (a proposed cancel stops
  // nothing). The stop itself runs after the commit, holding no lock.
  let cancel: SessionCancelRecord | undefined =
    terminalStatus === "cancelled"
      ? {
          at: new Date().toISOString(),
          by: params.agentUserId ?? params.userId,
          ...(params.cancelReason ? { reason: params.cancelReason } : {}),
          state: "stopping",
          stopped: [],
          notStoppable: [],
          notLinked: [],
          stopFailed: [],
          finished: [],
        }
      : undefined;

  const reportPatch = closeReportPatch({
    summary,
    verificationReport,
    unfinishedOutputs,
  });

  const [updated] = await db.transaction(async (tx) => {
    // Every exit may retire a slot now, so every exit reads the array under
    // the lock it writes it with.
    const [locked] = await tx
      .select({ expectedOutputs: focusSessions.expectedOutputs })
      .from(focusSessions)
      .where(eq(focusSessions.id, sessionId))
      .for("update");
    const lockedOutputs: ExpectedOutput[] = Array.isArray(
      locked?.expectedOutputs
    )
      ? (locked.expectedOutputs as ExpectedOutput[])
      : [];
    const retirement = retirementForClose(
      lockedOutputs,
      terminalStatus,
      new Date(),
      keep
    );
    retiredSlots = retirement?.retiredSlots ?? 0;

    // The room's questions end with the session, in the same transaction as
    // the status: a session is never terminal over an open question. The
    // agent's withdrawals first (its note is the record), then whatever is
    // still open — the questions it kept owed included: their slot carries
    // them on now.
    if (session.channelId) {
      const at = new Date().toISOString();
      for (const { question, note } of agentQuestions?.withdrawn ?? []) {
        await closeOpenRoomQuestions(tx, {
          channelId: session.channelId,
          messageIds: [question.messageId],
          askedBy: questionsOf,
          closed: {
            reason: "withdrawn",
            at,
            ...(questionsOf ? { by: questionsOf } : {}),
            ...(note ? { note } : {}),
          },
        });
      }
      if (!roomShared) {
        closedQuestions = (
          await closeOpenRoomQuestions(tx, {
            channelId: session.channelId,
            closed: { reason: "session_ended", at },
          })
        ).length;
      }
    }

    return await tx
      .update(focusSessions)
      .set({
        status: terminalStatus,
        closedAt: new Date(),
        ...(retirement ? { expectedOutputs: retirement.outputs } : {}),
        ...(cancel ? { metadata: cancelRecordMetadataSql(cancel) } : {}),
        ...(reportPatch === null
          ? { verificationReport: null }
          : reportPatch
            ? {
                // Shallow merge in SQL, inside this UPDATE, so a report written
                // since the load above is merged into, never overwritten.
                verificationReport: drizzleSql`(CASE WHEN jsonb_typeof(${focusSessions.verificationReport}) = 'object' THEN ${focusSessions.verificationReport} ELSE '{}'::jsonb END) || ${JSON.stringify(reportPatch)}::jsonb`,
              }
            : {}),
      })
      .where(eq(focusSessions.id, sessionId))
      .returning();
  });

  // A successful close drops this subject from that playbook's pin list.
  // Cancel and fail keep it. The already-terminal guard above returned
  // before any write, and a proposal threw before this transaction, so
  // neither of those unpins. The close has committed: a failed unpin is
  // logged and does not roll it back. Version is not bumped — the list is
  // metadata, not the definition.
  if (shouldDropPin(terminalStatus) && updated) {
    await unpinClosedSubject({
      playbookId: session.playbookId,
      subjectEntityId: session.subjectEntityId,
    });
  }

  // A stage worker's targets the session never settled are `skipped` /
  // `session_closed` — "unfinished" is a mark, never an absence (work model
  // L4). Every exit, after the commit; first verdict wins, so a target already
  // settled keeps its result. A failed stamp never rolls the close back.
  if (updated) {
    try {
      await stampOpenWorkerTargets({
        sessionId,
        result: "skipped",
        reason: WORKER_TARGET_REASONS.sessionClosed,
      });
    } catch (err) {
      logger.warn(
        { err, sessionId },
        "worker targets not stamped on close (the close stands)"
      );
    }
  }

  // The stop, AFTER the commit: no lock is held across its calls and nothing it
  // does can roll the cancel back. It never throws — a failed stop lands in
  // `stopFailed`. The outcome is the record's second write.
  if (cancel) {
    const outcome = await stopSessionWork({
      session: {
        id: session.id,
        userId: params.userId,
        channelId: session.channelId ?? null,
      },
    });
    cancel = { ...cancel, state: "done", ...outcome };
    try {
      const [recorded] = await db
        .update(focusSessions)
        .set({ metadata: cancelRecordMetadataSql(cancel) })
        .where(eq(focusSessions.id, sessionId))
        .returning();
      if (recorded) updated.metadata = recorded.metadata;
    } catch (err) {
      warnings.push(
        `The session is cancelled, but what the cancel stopped could not be recorded on it (${err instanceof Error ? err.message : String(err)}).`
      );
    }
    if (outcome.notStoppable.length > 0) {
      warnings.push(
        `${outcome.notStoppable.length} piece(s) of work were already running and could not be stopped — they will finish.`
      );
    }
    if (outcome.stopFailed.length > 0) {
      warnings.push(
        `${outcome.stopFailed.length} stop(s) failed — the session is cancelled anyway; see cancel.stopFailed for why.`
      );
    }
    if (outcome.notLinked.length > 0) {
      warnings.push(
        `${outcome.notLinked.length} import job(s) name no session, so this cancel cannot tell whether they belong to it — they will run.`
      );
    }
  }

  // The session is closed, so its EPHEMERAL proposals are no longer answerable.
  // A capability run is an outbound call bound to this session — urgent for
  // minutes, worthless after. OpenID CIBA's rule is the one to follow here: a
  // server should "terminate the authentication when it knows the client is no
  // longer interested in the result". Session close IS that signal; the 6h cron
  // is only the backstop for sessions that die without a clean close.
  //
  // Runs BEFORE the pack query below so the pack reports what is really still
  // owed, not rows this call is about to retire. Best-effort and never throws —
  // a session must close even if the sweep fails. Only classes WITH a lifetime
  // are touched: a proposed entity or a merge candidate created during a session
  // outlives it by design.
  //
  // NOTE how this composes with owed slots: expiring an ephemeral can retire the
  // only answer a still-pending slot had, so a close genuinely leaves MORE work
  // undone than it found. That is why owed slots must SURVIVE the close rather
  // than be swept with it — and why both counts are reported out loud instead of
  // being absorbed silently.
  const expiredEphemerals = await expireSessionEphemerals(sessionId);

  // A secret handed over for an ask was readable by the asking agent "in this
  // session": the session ended, so the read does too. Never blocks the
  // close: a failure is logged, and the read still ends with its TTL.
  await import("./provide-secret-grant.js")
    .then((m) => m.revokeSessionProvidedGrants(sessionId))
    .catch((err: unknown) =>
      logger.error(
        { err, sessionId },
        "could not revoke the reads granted in this session"
      )
    );

  // Proposal pack — pending rows attributed to this session.
  const pendingRows = await db
    .select()
    .from(proposals)
    .where(
      and(
        eq(proposals.sessionId, sessionId),
        eq(proposals.status, ProposalStatus.PENDING)
      )
    )
    .orderBy(desc(proposals.createdAt))
    .limit(100);

  const pendingProposals = pendingRows.map(packItem);

  // Say it out loud. Expiry is honest only if the person closing the session
  // learns it happened — a silent retirement is the lying-count defect the C2
  // TTL removal was about, wearing a different hat.
  // Same rule as the ephemeral sweep below: a retirement nobody is told about is
  // a silent one. Say which slots stopped being owed and why.
  if (retiredSlots > 0) {
    warnings.push(
      terminalStatus === "cancelled"
        ? `${retiredSlots} output(s) you owed were retired because this session was ` +
            `cancelled — they are stamped, not deleted, and stay readable on the session.`
        : `${retiredSlots} question(s) waiting for your yes/no or choice were retired because ` +
            `the session ended — they are stamped, not deleted, and stay readable on the session.`
    );
  }

  if (closedQuestions > 0) {
    warnings.push(
      `${closedQuestions} question(s) still open in the room were closed because the session ` +
        `ended — they are stamped, not deleted, and stay readable in the room.`
    );
  }

  // Nothing left for the person here: the "this session needs you" rows leave
  // the bell too. Never throws.
  await settleSessionNeedsYou(sessionId);

  if (expiredEphemerals > 0) {
    warnings.push(
      `${expiredEphemerals} unanswered capability run(s) expired with this session — ` +
        `they were bound to it and are no longer actionable.`
    );
  }

  // The grade at close — computed, never enforced (founder decision: close
  // never blocks on criteria). Unmet required criteria are said out loud.
  const { verdict } = await loadSessionEvaluationSummary(updated);
  if (verdict.requiredUnmet > 0) {
    warnings.push(
      `${verdict.requiredUnmet} required criteri${verdict.requiredUnmet === 1 ? "on" : "a"} not met — session closed anyway, flagged.`
    );
  }

  // ── THE CLOSE EVENT ────────────────────────────────────────────────────────
  // Closing a session is a fact about the work, and until now it left no trace
  // anyone could react to or read back: no automation could fire on it, the
  // unblock reactor had nothing to listen for, and the Why spine had no row.
  //
  // BOTH halves are required and they are not substitutes. `emitSideEffects` is
  // the TRANSIENT reactor hop (pg-boss): it reaches the automation trigger
  // matcher and the webhook fan-out, and it is gone the moment it is handled.
  // `logEvent` is the PERSISTED history row on the events spine — the only half
  // a later reader (session history, the Why pane) can ever see. Emitting only
  // the first is the integration-continent defect: live firing with no history.
  const eventData = {
    sessionId: updated.id,
    workspaceId: updated.workspaceId,
    projectId: updated.projectId,
    userId: params.userId,
    subjectId: updated.subjectEntityId,
    playbookId: updated.playbookId,
    origin: updated.origin,
    goal: updated.goal,
    status: updated.status,
    ...(summary !== undefined ? { summary } : {}),
    // Additive: reactors that do not know it ignore it.
    verdict,
  };

  await logEvent(params.userId, FOCUS_SESSION_CLOSED_EVENT_TYPE, eventData, {
    subjectId: updated.id,
    subjectType: FOCUS_SESSION_SUBJECT_TYPE,
    source: params.agentUserId ? "intelligence" : "api",
    ...(params.agentUserId
      ? { metadata: { agentUserId: params.agentUserId } }
      : {}),
  });

  // `emitSideEffects` composes `${subjectType}.${action}.completed`, which is
  // exactly FOCUS_SESSION_CLOSED_EVENT_TYPE — the constants are the SAME two
  // halves, so the emitted type and the persisted type can never diverge.
  await emitSideEffects({
    subjectType: FOCUS_SESSION_SUBJECT_TYPE,
    action: FOCUS_SESSION_CLOSE_ACTION,
    subjectId: updated.id,
    userId: params.userId,
    workspaceId: updated.workspaceId,
    sessionId: updated.id,
    data: eventData,
  });

  return {
    session: updated,
    pendingProposals,
    counts: {
      pending: pendingProposals.length,
      unfinishedOutputs,
      expiredEphemerals,
      retiredSlots,
      closedQuestions,
    },
    warnings,
    ...(cancel ? { cancel } : {}),
    verdict,
  };
}

/**
 * Remove the closed session's subject from its playbook's pin list.
 * No-op when the playbook is not pinned, or the id is not on the list.
 * Never throws — the close has already committed.
 */
async function unpinClosedSubject(session: {
  playbookId: string | null;
  subjectEntityId: string | null;
}): Promise<void> {
  if (!session.playbookId || !session.subjectEntityId) return;
  try {
    const [playbook] = await db
      .select({
        id: playbooks.id,
        inputStrategy: playbooks.inputStrategy,
        metadata: playbooks.metadata,
      })
      .from(playbooks)
      .where(eq(playbooks.id, session.playbookId))
      .limit(1);
    if (!playbook || !isPinnedStrategy(playbook.inputStrategy)) return;
    const next = metadataAfterUnpin(playbook.metadata, session.subjectEntityId);
    if (!next) return;
    await db
      .update(playbooks)
      .set({ metadata: next, updatedAt: new Date() })
      .where(eq(playbooks.id, playbook.id));
  } catch (err) {
    logger.error(
      {
        err,
        playbookId: session.playbookId,
        subjectEntityId: session.subjectEntityId,
      },
      "closed session did not drop its pin"
    );
  }
}
