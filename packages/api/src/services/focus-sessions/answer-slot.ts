/**
 * answerExpectedOutput — the ONE door that records the PERSON'S ANSWER on a
 * session slot.
 *
 * WHY (research brief 2026-09-25, M5). An agent that needed a decision could
 * hand the slot to the person (`blockExpectedOutput`) or ask in the room
 * (`post_message kind:'question'`), and the person could reply on Relay — but
 * nothing linked the reply to what was asked. "Unblock" was a manual second
 * step nobody took, the slot sat owed forever, and the agent never learned it
 * had an answer. Two entrances now reach THIS function, so the tray and the
 * room cannot answer the same question two different ways:
 *   - the direct door (tRPC `focusSessions.answerOutput`, Hub
 *     `POST /focus-sessions/:id/outputs/answer`) → `answerSessionSlot`;
 *   - the owner's reply to an agent question → `recordOwnerRoomReply`
 *   (both in `session-answer.ts`).
 *
 * WHAT "ANSWERED" MEANS — the state decision. An answer is INPUT, not a
 * delivery, so `status` is never touched (`satisfyExpectedOutputs` and
 * `attestExpectedOutput` stay the only `done` doors). On a HUMAN-owned slot the
 * answer hands the slot BACK to the agent with exactly the clearing
 * `stampUnblocked` performs — `owner`, `blockedReason`, `why`, `owedSince`
 * removed together, `owner` DELETED rather than written as `'agent'` (see
 * block-output.ts). That is the one thing the existing state rules can already
 * express without a new status: the owed predicate (`isOwedSlot`) drops it, so
 * the needs-you tray/count clear on their own, and the agent's open-slot read
 * (`isOpenAgentSlot`) picks it up with `answer` attached — "answered but not
 * yet acted on" is DERIVED (answer present ∧ open agent slot), never stored.
 * The question survives on `answer.question`, because the hand-back deletes
 * `why`. An AGENT-owned slot (the agent asked about its own work) just gets the
 * answer stamped; nothing else changes.
 *
 * WHO. Owner-floored like every sibling (`focus_sessions` is owner-private, no
 * `VisibilityRule`): the session's owner is the only person whose answer is
 * recorded. v1 deliberately does not let a second human in the room answer for
 * the owner — whose principal an answer from a co-member speaks for is an OPEN
 * founder decision (AI principal), not something this door decides.
 *
 * ONE EVENT. `focus_session.slot_answered.completed` — the history row is
 * appended INSIDE the stamping transaction (it commits iff the answer does);
 * the reactor hop fires after commit.
 */

import { db, focusSessions, and, eq } from "@synap/database";
import { emitSideEffects } from "@synap/events";
import { createLogger } from "@synap-core/core";
import type {
  ExpectedOutput,
  SlotAnswer,
  SlotAnswerValue,
} from "@synap/playbooks";
import { askFingerprint, buildAskSnapshot } from "@synap-core/types/ask";
import { archivedAnswerHistory } from "./answer-history.js";
import {
  fileAnswerDecision,
  type DecisionFilingOutcome,
} from "../decisions/file-answer-decision.js";
import { logEvent } from "../../lib/event-helpers.js";
import { findSlotIndex } from "./slot-keys.js";
import { stampUnblocked } from "./block-output.js";
import { acceptDraftOnEngagement } from "./accept-on-engagement.js";
import { paramValueFromAnswer } from "./param-slots.js";
import { RUN_PARAMS_METADATA_KEY } from "../playbooks/playbook-lifecycle.js";
import {
  FOCUS_SESSION_SUBJECT_TYPE,
  FOCUS_SESSION_SLOT_ANSWER_ACTION,
  FOCUS_SESSION_SLOT_ANSWERED_EVENT_TYPE,
} from "./lifecycle-events.js";

const logger = createLogger({ module: "answer-slot" });

/** Bound on an answer's text — a reply, not a document. */
export const SLOT_ANSWER_TEXT_MAX = 4000;

export interface AnswerExpectedOutputParams {
  sessionId: string;
  /** Owner floor AND the answering identity — they are the same person. */
  userId: string;
  expectedLabel: string;
  text: string;
  /** The room message carrying the answer; `null` when there is no room. */
  messageId: string | null;
  /** Fallback question text when the slot carries no `why` (the agent's post). */
  question?: string;
  /**
   * The TYPED answer, already validated against the slot's ask by the caller
   * (`answerSessionSlot`) and already redacted (`AskAnswerValueSchema`).
   * Stored on `answer.value`. Absent on the room-reply entrance: a plain
   * reply is words, not a pick.
   */
  value?: SlotAnswerValue;
  /**
   * `askFingerprint(slot.ask)` of the ask the caller validated `value` (or
   * the text) AGAINST. Re-checked under the row lock: an agent that re-asked
   * between the caller's read and this write gets `ask_changed` instead of an
   * answer to a question the person was never shown. Absent ⇒ not checked
   * (the room-reply entrance, which answers in words whatever the ask).
   */
  askFingerprint?: string;
  /**
   * `false` keeps a human-owned slot the PERSON'S after the answer — used
   * only for a criterion slot, whose answer is a grade: the grade door then
   * discharges the slot (`done`, attested), so handing it to an agent first
   * would make that discharge impossible. Default `true`.
   */
  handBack?: boolean;
  now?: Date;
}

export type AnswerExpectedOutputResult =
  | { status: "not_found" }
  | { status: "unknown_label" }
  | { status: "already_done" }
  | { status: "retired" }
  | { status: "empty_answer" }
  /** The slot's ask is no longer the one the answer was given against. */
  | { status: "ask_changed" }
  | {
      status: "answered";
      /** The DECLARED label (the slot's own casing). */
      expectedLabel: string;
      kind: string;
      answer: SlotAnswer;
      /** `true` ⇒ the slot was the person's and is now back with the agent. */
      handedBack: boolean;
      /** The slot as it stood BEFORE the answer — who it was delegated to, etc. */
      before: ExpectedOutput;
      session: {
        id: string;
        workspaceId: string | null;
        projectId: string | null;
        channelId: string | null;
        agentIds: string[];
      };
      /**
       * The `decision` entity an answered confirm/choose filed or updated
       * (`services/decisions/`). `failed` is a LOUD outcome — the answer is
       * recorded, the decision is not. Absent for asks that file no decision.
       */
      decision?: DecisionFilingOutcome;
    };

/**
 * WHICH slot an answer may land on, or WHY not. Pure.
 *
 * Refused: an undeclared label, a DELIVERED slot (an answer after the fact is
 * not input to anything), and a RETIRED one (the session was cancelled — the
 * question is moot, and a stamp would read as live). Deliberately NOT refused:
 * an agent-owned slot — an agent may ask about its own work, and the answer is
 * still the input it needed.
 */
export function selectSlotToAnswer(
  outputs: ExpectedOutput[],
  expectedLabel: string | null | undefined
):
  | { index: number }
  | { refused: "unknown_label" | "already_done" | "retired" } {
  // KEY first, then the label (`findSlotIndex`) — `expectedLabel` may carry
  // either.
  if (!expectedLabel?.trim()) return { refused: "unknown_label" };
  const index = findSlotIndex(outputs, expectedLabel, (o) => !!o);
  if (index === -1) return { refused: "unknown_label" };
  const slot = outputs[index]!;
  if (slot.status === "done") return { refused: "already_done" };
  if (slot.retiredAt != null) return { refused: "retired" };
  return { index };
}

/**
 * The answer stamp. Pure. A human-owned slot is handed back through
 * `stampUnblocked` (the ONE clearing of the ownership quartet) and then gets
 * the answer; any other slot only gets the answer. Every other slot untouched.
 */
export function stampAnswered(
  outputs: ExpectedOutput[],
  index: number,
  answer: SlotAnswer,
  handBack = true
): ExpectedOutput[] {
  const slot = outputs[index]!;
  const handedBack =
    slot.owner === "human" && handBack
      ? stampUnblocked(outputs, slot.label)[index]!
      : { ...slot };
  // A new answer has not been picked up yet — the prior receipt was about the
  // prior answer (`answer-pickup.ts`).
  const { answerPickedUpAt: _stale, ...fresh } = handedBack;
  // A SECOND answer archives the first instead of overwriting it.
  const answerHistory = archivedAnswerHistory(slot);
  return outputs.map((o, i) =>
    i === index
      ? { ...fresh, ...(answerHistory ? { answerHistory } : {}), answer }
      : o
  );
}

export async function answerExpectedOutput(
  params: AnswerExpectedOutputParams
): Promise<AnswerExpectedOutputResult> {
  const text = params.text.trim().slice(0, SLOT_ANSWER_TEXT_MAX);
  if (!text) return { status: "empty_answer" };
  const now = params.now ?? new Date();

  const result = await db.transaction(
    async (tx): Promise<AnswerExpectedOutputResult> => {
      const [locked] = await tx
        .select({
          id: focusSessions.id,
          expectedOutputs: focusSessions.expectedOutputs,
          workspaceId: focusSessions.workspaceId,
          projectId: focusSessions.projectId,
          channelId: focusSessions.channelId,
          agentIds: focusSessions.agentIds,
          metadata: focusSessions.metadata,
        })
        .from(focusSessions)
        .where(
          and(
            eq(focusSessions.id, params.sessionId),
            eq(focusSessions.userId, params.userId)
          )
        )
        .for("update");
      if (!locked) return { status: "not_found" };

      const current: ExpectedOutput[] = Array.isArray(locked.expectedOutputs)
        ? (locked.expectedOutputs as ExpectedOutput[])
        : [];
      const chosen = selectSlotToAnswer(current, params.expectedLabel);
      if ("refused" in chosen) return { status: chosen.refused };
      const before = current[chosen.index]!;
      if (
        params.askFingerprint !== undefined &&
        askFingerprint(before.ask ?? null) !== params.askFingerprint
      ) {
        return { status: "ask_changed" };
      }

      // The question the person was SHOWN: a confirm's own prompt outranks the
      // slot's `why` (the reason it is owed), which is only the fallback.
      const prompt =
        before.ask?.mode === "confirm" ? before.ask.prompt?.trim() : undefined;
      const question = prompt || before.why?.trim() || params.question?.trim();
      const answer: SlotAnswer = {
        text,
        messageId: params.messageId,
        answeredBy: params.userId,
        answeredAt: now.toISOString(),
        ...(question
          ? { question: question.slice(0, SLOT_ANSWER_TEXT_MAX) }
          : {}),
        ...(params.value ? { value: params.value } : {}),
        // The ask AS POSED — the hand-back below clears `ask`/`why`, and with
        // them the options, the recommendation and what the agent looked at.
        ...(before.ask
          ? {
              askSnapshot: buildAskSnapshot(
                before.ask,
                params.value,
                before.why
              ),
            }
          : {}),
      };
      const handBack = params.handBack !== false;
      const next = stampAnswered(current, chosen.index, answer, handBack);
      // A PARAM slot's answer IS the param's value: it lands in the run's
      // params (`RUN_PARAMS_METADATA_KEY`) in the same write, under the same
      // lock, so the answer and the value can never disagree. A value that
      // does not read as the param's type is refused by the direct door
      // before this point; from a room reply (words, whatever the ask) it is
      // recorded as the answer and writes no param.
      const param = paramValueFromAnswer(before, params.value, text);
      const metadata =
        param.status === "value"
          ? withRunParam(locked.metadata, param.name, param.value)
          : undefined;
      await tx
        .update(focusSessions)
        .set({
          expectedOutputs: next,
          ...(metadata ? { metadata } : {}),
          updatedAt: now,
        })
        .where(eq(focusSessions.id, locked.id));

      // The history row commits iff the answer does.
      await logEvent(
        params.userId,
        FOCUS_SESSION_SLOT_ANSWERED_EVENT_TYPE,
        slotAnsweredEventData(
          locked.id,
          before,
          answer,
          before.owner === "human" && handBack
        ),
        {
          subjectId: locked.id,
          subjectType: FOCUS_SESSION_SUBJECT_TYPE,
          source: "api",
        },
        tx
      );

      return {
        status: "answered",
        expectedLabel: before.label,
        kind: before.kind,
        answer,
        handedBack: before.owner === "human" && handBack,
        before,
        session: {
          id: locked.id,
          workspaceId: locked.workspaceId ?? null,
          projectId: locked.projectId ?? null,
          channelId: locked.channelId ?? null,
          agentIds: Array.isArray(locked.agentIds) ? locked.agentIds : [],
        },
      };
    }
  );

  if (result.status === "answered") {
    // The reactor hop — after commit, so a rule never fires on a rolled-back
    // answer. Best-effort: the answer and its history row already landed.
    try {
      await emitSideEffects({
        subjectType: FOCUS_SESSION_SUBJECT_TYPE,
        action: FOCUS_SESSION_SLOT_ANSWER_ACTION,
        subjectId: result.session.id,
        userId: params.userId,
        workspaceId: result.session.workspaceId ?? undefined,
        sessionId: result.session.id,
        data: slotAnsweredEventData(
          result.session.id,
          result.before,
          result.answer,
          result.handedBack
        ),
      });
    } catch (err) {
      logger.warn(
        { err, sessionId: result.session.id },
        "slot_answered side-effect emit failed — the answer is recorded"
      );
    }
    // Answering an ask on an undecided agent draft takes the draft on — the
    // ONE acceptance door, after commit, idempotent (accept-on-engagement.ts).
    await acceptDraftOnEngagement({
      sessionId: result.session.id,
      userId: params.userId,
    });
    // Every answered confirm/choose IS a decision — filed (or, for a slot
    // opened for one, updated) as the person's own act. After commit, never
    // inside it: a failed filing must not lose the answer, and it is
    // returned as `failed`, never swallowed (`file-answer-decision.ts`).
    const decision = await fileAnswerDecision({
      userId: params.userId,
      slot: result.before,
      answer: result.answer,
      session: result.session,
    });
    if (decision) return { ...result, decision };
  }
  return result;
}

/** The metadata bag with one run param set, every other key untouched. Pure. */
export function withRunParam(
  metadata: unknown,
  name: string,
  value: unknown
): Record<string, unknown> {
  const bag =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : {};
  const stored = bag[RUN_PARAMS_METADATA_KEY];
  const runParams =
    stored && typeof stored === "object" && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};
  return {
    ...bag,
    [RUN_PARAMS_METADATA_KEY]: { ...runParams, [name]: value },
  };
}

function slotAnsweredEventData(
  sessionId: string,
  slot: ExpectedOutput,
  answer: SlotAnswer,
  handedBack: boolean
): Record<string, unknown> {
  return {
    sessionId,
    expectedLabel: slot.label,
    kind: slot.kind,
    handedBack,
    messageId: answer.messageId,
    answeredBy: answer.answeredBy,
    answeredAt: answer.answeredAt,
    // The TYPED answer, for a rule to branch on ("when they pick Ship…").
    // Already redacted at the parse (`AskAnswerValueSchema`) — a form's secret
    // never reaches an event row. `null` for a plain free-text answer.
    value: answer.value ?? null,
    // The ask as posed + whether the pick followed the recommendation — the
    // durable record of "the AI said X, the person chose Y". `null` when the
    // slot carried no ask.
    askSnapshot: answer.askSnapshot ?? null,
    ...(slot.decisionId ? { decisionId: slot.decisionId } : {}),
  };
}
