/**
 * THE ANSWER LOOP — the return half of "agents talk in the session room"
 * (founder-validated 2026-09-25; research brief M3 + M5).
 *
 * An agent asks in the room (`post_message kind:'question'`, optionally naming
 * the owed slot with `slotLabel`) or hands a slot to the person
 * (`block_output`). The person answers from the phone or the browser, in one of
 * two places, and BOTH land here so they cannot diverge:
 *
 *   - `recordOwnerRoomReply` — the session OWNER's plain reply in the room
 *     (tRPC `channels.sendMessage`, Hub `POST /threads/:id/messages` without an
 *     agent key);
 *   - `answerSessionSlot` — the direct door (tRPC `focusSessions.answerOutput`,
 *     Hub `POST /focus-sessions/:id/outputs/answer`), which also posts the
 *     answer into the room so the conversation stays whole.
 *
 * Each one: resolves the question it answers, records the answer on the slot
 * (`answerExpectedOutput` — the ONE slot write + the ONE event), and wakes the
 * agent that asked when the pod can run it.
 *
 * ── WHICH QUESTION A REPLY ANSWERS (the linkage, and its limit) ─────────────
 * No client sends a reply-to today (`channelSendMessageInputSchema` carries
 * only `anchor`; `messages.parentId` is message BRANCHING, not reply). So the
 * rule is: the owner's next message in the room answers the NEWEST OPEN agent
 * question there. "Open" is a server-owned marker — `metadata.roomPost.answer`
 * is claimed atomically (`UPDATE … WHERE NOT (… ? 'answer')`), so each question
 * is answered exactly once and each reply answers at most one question, even
 * under concurrent sends. Limit, stated: with two open questions a plain reply
 * answers the newer one (chat semantics — you reply to what is last); a future
 * reply-to on the send input would make it exact, and `findOpenQuestion` is
 * the one place to teach it.
 *
 * ── WHOSE REPLY COUNTS (v1) ────────────────────────────────────────────────
 * ONLY the session owner's. A second human in the room must not resolve the
 * owner's slot nor spend the owner's agent turn: whose principal a co-member's
 * reply speaks for is an OPEN founder decision (AI principal). Until it is
 * decided, a non-owner reply is an ordinary room message and nothing more.
 *
 * ── WHO IS WOKEN (M3) ───────────────────────────────────────────────────────
 * The agent that ASKED (the question's author), through the ONE turn door
 * `triggerAutoRespond` with its agent type named (session rooms are GROUP
 * rooms, which wake only a named agent). With no question to go on (the direct
 * door on a slot nobody asked about in the room) it falls back to the slot's
 * `delegatedTo`, then the first pod-run agent staffed on the session.
 * An agent the pod cannot run — Claude Code, claude.ai, Raycast, any agent
 * that holds its own door key — is NOT woken: an IS turn under its name would
 * be an impersonation. It reads the answer on its next turn instead
 * (continuation packet `aiCanDo[].answer`, the `answered` nudge, or the poll
 * door `GET /focus-sessions/:id/answers`).
 *
 * Side-effect helpers never throw into the caller's send: a failure here is
 * logged and the message the person sent still stands.
 */

import { randomUUID } from "crypto";
import {
  db,
  messages,
  users,
  apiKeys,
  focusSessions,
  MessageAuthorType,
  and,
  eq,
  desc,
  isNull,
  drizzleSql,
} from "@synap/database";
import type { SQL } from "@synap/database";
import { createLogger } from "@synap-core/core";
import type { ExpectedOutput, SlotAnswerValue } from "@synap/playbooks";
import {
  AskAnswerValueSchema,
  askFingerprint,
  resolveAskResolution,
  summarizeAnswer,
  validateAnswerAgainstAsk,
  ASK_CHANGED_PREFIX,
  ASK_INVALID_PREFIX,
  SLOT_MOVED_ON_PHRASES,
  type AskAnswerValue,
  type AskAnswerRefusalCode,
} from "@synap-core/types/ask";
import {
  ROOM_POST_META_KEY,
  readRoomPostMeta,
  type RoomPostMeta,
} from "../messaging/room-post-kind.js";
import { resolveRoomSession } from "../messaging/room-session.js";
import {
  postChannelMessage,
  postedMessageIdFor,
} from "../messaging/post-message.js";
import { findNewestSlotThreadSeed } from "./slot-thread.js";
import { triggerAutoRespond } from "../../utils/trigger-auto-respond.js";
import { normalizeExpectedLabel } from "./expected-label.js";
import {
  attestExpectedOutput,
  type AttestExpectedOutputResult,
} from "./satisfy-expected-output.js";
import { readCriteria } from "@synap/playbooks";
import { CRITERION_SLOT_KIND } from "@synap-core/types/focus-sessions";
import { checkProvideRef } from "./provide-ref.js";
import { paramValueFromAnswer } from "./param-slots.js";
import { criterionVerdictOf } from "./evaluations/record.js";
import {
  answerExpectedOutput,
  selectSlotToAnswer,
  SLOT_ANSWER_TEXT_MAX,
  type AnswerExpectedOutputResult,
} from "./answer-slot.js";

const logger = createLogger({ module: "session-answer" });

// ── Questions ────────────────────────────────────────────────────────────────

export interface OpenQuestion {
  id: string;
  content: string;
  /** The agent that asked (`messages.routed_teammate_id`). */
  agentUserId: string | null;
  slotLabel: string | null;
  timestamp: Date;
}

/**
 * THE "open agent question" predicate on `messages`, as SQL — ONE definition
 * for every reader (this file, the needs-you union's live-state read). An
 * AI-agent message, not deleted, whose server-owned `roomPost` marker says
 * `question` and carries no `answer` stamp.
 */
export function openRoomQuestionConditions(): SQL[] {
  return [
    eq(messages.authorType, MessageAuthorType.AI_AGENT),
    isNull(messages.deletedAt),
    drizzleSql`${messages.metadata}->${ROOM_POST_META_KEY}->>'kind' = 'question'`,
    drizzleSql`NOT ((${messages.metadata}->${ROOM_POST_META_KEY}) ? 'answer')`,
  ];
}

/**
 * The newest OPEN agent question in a room — optionally about one slot.
 * "Open" = a persisted `roomPost.kind === 'question'` with no `answer` stamp.
 */
export async function findOpenQuestion(
  channelId: string,
  opts: { slotLabel?: string } = {}
): Promise<OpenQuestion | null> {
  const rows = await db
    .select({
      id: messages.id,
      content: messages.content,
      metadata: messages.metadata,
      routedTeammateId: messages.routedTeammateId,
      timestamp: messages.timestamp,
    })
    .from(messages)
    .where(
      and(eq(messages.channelId, channelId), ...openRoomQuestionConditions())
    )
    .orderBy(desc(messages.timestamp))
    // Bounded: a slot filter is applied below in TS (labels are normalized),
    // and a room does not hold hundreds of simultaneously open questions.
    .limit(opts.slotLabel ? 50 : 1);

  const wanted = opts.slotLabel ? normalizeExpectedLabel(opts.slotLabel) : null;
  for (const row of rows) {
    const meta = readRoomPostMeta(row.metadata);
    if (!meta) continue;
    if (wanted && normalizeExpectedLabel(meta.slotLabel) !== wanted) continue;
    return {
      id: row.id,
      content: row.content,
      agentUserId: row.routedTeammateId ?? null,
      slotLabel: meta.slotLabel ?? null,
      timestamp: row.timestamp,
    };
  }
  return null;
}

/**
 * Stamp the question answered — ATOMICALLY. Returns `false` when another reply
 * got there first (the question was no longer open), so a question is answered
 * exactly once. Hash-safe: `computeMessageHash` covers (id, content) only.
 */
export async function claimQuestionAnswered(
  questionId: string,
  answer: NonNullable<RoomPostMeta["answer"]>
): Promise<boolean> {
  const claimed = await db
    .update(messages)
    .set({
      metadata: drizzleSql`jsonb_set(${messages.metadata}, ${`{${ROOM_POST_META_KEY},answer}`}::text[], ${JSON.stringify(answer)}::jsonb, true)`,
    })
    .where(
      and(
        eq(messages.id, questionId),
        drizzleSql`NOT ((${messages.metadata}->${ROOM_POST_META_KEY}) ? 'answer')`
      )
    )
    .returning({ id: messages.id });
  return claimed.length > 0;
}

// ── Who is woken ─────────────────────────────────────────────────────────────

/**
 * Can the POD run this agent (an Intelligence-Service agent), as opposed to an
 * agent that works through its own door key and reads the answer itself?
 *
 * The derived signal: an external agent (Claude Code, Raycast, a named CLI
 * agent) authenticates with a key OWNED by its agent user
 * (`provisionSurfaceAgentKey` mints `api_keys.user_id = agentUser`); a pod-run
 * agent acts through the IS, whose only key is `is_internal`. So "owns a
 * non-internal key, live or revoked" ⇒ external ⇒ never woken here. A revoked
 * key still counts: the principal was external, and an IS turn under its name
 * would be an impersonation either way.
 */
export async function podRunAgentType(
  agentUserId: string
): Promise<string | null> {
  const [agent] = await db
    .select({ agentType: users.agentType, userType: users.userType })
    .from(users)
    .where(eq(users.id, agentUserId))
    .limit(1);
  const agentType = agent?.agentType?.trim();
  if (!agent || agent.userType !== "agent" || !agentType) return null;
  const [ownKey] = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.userId, agentUserId),
        drizzleSql`${apiKeys.keyType} IS DISTINCT FROM 'is_internal'`
      )
    )
    .limit(1);
  return ownKey ? null : agentType;
}

/**
 * The agent TYPE to wake, or `null` for "nobody the pod can run". The asker
 * wins outright — when a question exists, only its author may be woken (never
 * a bystander agent answering someone else's question).
 */
export async function resolveWakeAgentType(p: {
  askingAgentUserId?: string | null;
  slot?: ExpectedOutput | null;
  agentIds?: string[];
}): Promise<string | null> {
  if (p.askingAgentUserId) return podRunAgentType(p.askingAgentUserId);
  const delegated = p.slot?.delegatedTo?.trim();
  if (delegated) return delegated;
  for (const agentId of p.agentIds ?? []) {
    const type = await podRunAgentType(agentId);
    if (type) return type;
  }
  return null;
}

async function wake(p: {
  channelId: string;
  messageId: string;
  content: string;
  ownerId: string;
  sessionId: string;
  agentType: string | null;
}): Promise<boolean> {
  if (!p.agentType) return false;
  return triggerAutoRespond({
    channelId: p.channelId,
    userMessageId: p.messageId,
    content: p.content,
    sourceUserId: p.ownerId,
    focusSessionId: p.sessionId,
    agentType: p.agentType,
  });
}

// ── Entrance 1: the owner's reply in the room ────────────────────────────────

/**
 * What a room reply did to the slot its question named. `kept_owed` ⇒ the
 * reply answered the QUESTION only — the slot's typed ask does not take free
 * words, or the reply was a follow-up in an "ask about it" thread.
 */
export type OwnerRoomReplySlotStatus =
  AnswerExpectedOutputResult["status"] | "kept_owed";

export type OwnerRoomReplyResult =
  | { status: "no_session" | "not_owner" | "no_open_question" | "failed" }
  | {
      status: "answered";
      questionId: string;
      /** The slot outcome when the question named one; absent otherwise. */
      slot?: OwnerRoomReplySlotStatus;
      woke: boolean;
    };

/**
 * May the owner's plain room reply ANSWER the slot the agent's question named,
 * and as what? Two cases say no, and both leave the slot owed:
 *
 *   - TYPED ASK: a slot whose ask is not legacy takes what the ask takes. A
 *     reply in words is validated as `{type:'text'}` by the ONE rule
 *     (`resolveAnswer`): a closed choose, a form, a confirm, a provide, an act
 *     all refuse it — the person answers those from the card, never by typing
 *     "the EU one" and having it handed to the agent as if it were the pick.
 *     A choose with `allowOther` accepts it, as the typed text answer.
 *   - "ASK ABOUT IT" THREAD: the person opened a thread about this step
 *     (`askAboutSlot`) during the slot's current owed episode, before this
 *     question — the question is the agent's reply in that conversation, and
 *     the person's words are conversation too. The agent's slot-thread prompt
 *     says the same: it never answers for them.
 *
 * A legacy slot outside a thread answers exactly as before.
 */
async function readRoomReplyAsAnswer(p: {
  channelId: string;
  sessionId: string;
  userId: string;
  slotLabel: string;
  questionAt: Date;
  text: string;
}): Promise<
  | { keepOwed: true }
  | {
      keepOwed: false;
      text: string;
      value?: SlotAnswerValue;
      askFingerprint?: string;
    }
> {
  const row = await db.query.focusSessions.findFirst({
    where: eq(focusSessions.id, p.sessionId),
    columns: { expectedOutputs: true },
  });
  const outputs: ExpectedOutput[] = Array.isArray(row?.expectedOutputs)
    ? (row.expectedOutputs as ExpectedOutput[])
    : [];
  const chosen = selectSlotToAnswer(outputs, p.slotLabel);
  // A refused slot (unknown / done / retired) is reported by the answer door
  // itself, exactly as before.
  if ("refused" in chosen) return { keepOwed: false, text: p.text };
  const slot = outputs[chosen.index]!;

  if (slot.owner === "human") {
    const seed = await findNewestSlotThreadSeed({
      channelId: p.channelId,
      sessionId: p.sessionId,
      label: slot.label,
      userId: p.userId,
    });
    const episodeStart = slot.owedSince ? Date.parse(slot.owedSince) : NaN;
    if (
      seed &&
      seed.timestamp.getTime() <= p.questionAt.getTime() &&
      (Number.isNaN(episodeStart) || seed.timestamp.getTime() >= episodeStart)
    ) {
      return { keepOwed: true };
    }
  }

  const ask = slot.ask ?? null;
  if (resolveAskResolution(ask) === "legacy") {
    return { keepOwed: false, text: p.text };
  }
  const resolved = resolveAnswer(ask, { type: "text" }, p.text);
  if ("refused" in resolved) return { keepOwed: true };
  return {
    keepOwed: false,
    text: resolved.text,
    ...(resolved.value ? { value: resolved.value } : {}),
    // Re-checked under the lock: the agent re-asking in between refuses the
    // reply as an answer (`ask_changed`) instead of landing it on a new ask.
    askFingerprint: askFingerprint(ask),
  };
}

/**
 * Call AFTER a HUMAN's message landed in a room (never for an agent's post —
 * the caller guarantees that from its verified auth context).
 *
 * `wake: false` when the send already starts an agent turn on its own (an
 * @mention the routing engine resolved, an anchored comment, `autoRespond`):
 * the answer is still recorded, but a second turn would double-answer.
 */
export async function recordOwnerRoomReply(p: {
  channelId: string;
  messageId: string;
  content: string;
  /** The human who sent it. */
  userId: string;
  wake: boolean;
}): Promise<OwnerRoomReplyResult> {
  try {
    const session = await resolveRoomSession(p.channelId);
    if (!session) return { status: "no_session" };
    // v1: the OWNER only — see the module docblock (open AI-principal decision).
    if (session.userId !== p.userId) return { status: "not_owner" };

    const question = await findOpenQuestion(p.channelId);
    if (!question) return { status: "no_open_question" };

    const answeredAt = new Date();
    const text = p.content.trim().slice(0, SLOT_ANSWER_TEXT_MAX);
    const claimed = await claimQuestionAnswered(question.id, {
      messageId: p.messageId,
      answeredBy: p.userId,
      answeredAt: answeredAt.toISOString(),
      text,
    });
    if (!claimed) return { status: "no_open_question" };

    let slot: OwnerRoomReplySlotStatus | undefined;
    if (question.slotLabel) {
      const reading = await readRoomReplyAsAnswer({
        channelId: p.channelId,
        sessionId: session.id,
        userId: p.userId,
        slotLabel: question.slotLabel,
        questionAt: question.timestamp,
        text,
      });
      if (reading.keepOwed) {
        // The reply answered the agent's QUESTION (claimed above, and the
        // asker is still woken below) — but it is not an answer the slot's
        // ask accepts, or it is conversation inside an "ask about it"
        // thread. The slot stays the person's; the step itself is where
        // they answer it.
        slot = "kept_owed";
      } else {
        const answered = await answerExpectedOutput({
          sessionId: session.id,
          userId: p.userId,
          expectedLabel: question.slotLabel,
          text: reading.text,
          messageId: p.messageId,
          question: question.content,
          now: answeredAt,
          ...(reading.value ? { value: reading.value } : {}),
          ...(reading.askFingerprint !== undefined
            ? { askFingerprint: reading.askFingerprint }
            : {}),
        });
        slot = answered.status;
      }
    }

    const woke = p.wake
      ? await wake({
          channelId: p.channelId,
          messageId: p.messageId,
          content: p.content,
          ownerId: p.userId,
          sessionId: session.id,
          agentType: await resolveWakeAgentType({
            askingAgentUserId: question.agentUserId,
          }),
        })
      : false;

    return {
      status: "answered",
      questionId: question.id,
      ...(slot ? { slot } : {}),
      woke,
    };
  } catch (err) {
    logger.warn(
      { err, channelId: p.channelId, messageId: p.messageId },
      "owner room reply: recording the answer failed — the message stands"
    );
    return { status: "failed" };
  }
}

// ── Entrance 2: the direct door (needs-you tray) ─────────────────────────────

export type AnswerSessionSlotResult =
  | Exclude<AnswerExpectedOutputResult, { status: "answered" }>
  /** The answer does not fit the slot's ask (or the ask resolves by attest). */
  | { status: "ask_invalid"; code: AskAnswerRefusalCode; message: string }
  | {
      status: "answered";
      expectedLabel: string;
      kind: string;
      answer: Extract<
        AnswerExpectedOutputResult,
        { status: "answered" }
      >["answer"];
      handedBack: boolean;
      /** The room message now carrying the answer; `null` when no room. */
      messageId: string | null;
      /** The agent question this answered, when one was open for the slot. */
      questionId: string | null;
      /** The agent type woken, or `null` when none the pod can run. */
      wokeAgentType: string | null;
      triggered: boolean;
      /**
       * A CRITERION slot's answer is a grade: present when the pass/fail went
       * through the grade door (`gradeCriterionAsOwner`), which discharged
       * the slot. `recorded` false ⇒ the answer stands but the grade did not
       * land (the criterion was removed in between) — said, never hidden.
       */
      graded?: {
        verdict: "pass" | "fail";
        recorded: boolean;
        resumed: boolean;
      };
    };

/**
 * The direct door's answer, typed or not.
 *
 * - `value` — the typed answer (`@synap-core/types/ask`). Parsed HERE with
 *   `AskAnswerValueSchema` whatever door it came through, so a form's secret
 *   values are redacted before anything (slot, room post, event) sees them.
 * - `text` — free text; for a typed value, an optional note.
 * - `askFingerprint` — `askFingerprint(ask)` of the ask the client RENDERED.
 *   A mismatch with the slot's ask is `ask_changed` (the agent re-asked).
 *
 * A slot WITHOUT an ask keeps today's rule exactly: free text only, no value
 * stored. A slot WITH one is validated by the ONE rule
 * (`validateAnswerAgainstAsk`); `text` then becomes the answer's summary
 * (`summarizeAnswer`) — what the room post says and what every text-only
 * reader (CLI, continuation packet) reads.
 */
export async function answerSessionSlot(p: {
  sessionId: string;
  /** Owner floor AND the answering person. */
  userId: string;
  expectedLabel: string;
  text?: string;
  value?: AskAnswerValue | SlotAnswerValue;
  askFingerprint?: string;
}): Promise<AnswerSessionSlotResult> {
  const session = await db.query.focusSessions.findFirst({
    where: and(
      eq(focusSessions.id, p.sessionId),
      eq(focusSessions.userId, p.userId)
    ),
    columns: {
      id: true,
      channelId: true,
      expectedOutputs: true,
      criteria: true,
    },
  });
  if (!session) return { status: "not_found" };

  // Refuse BEFORE posting: a refusal must leave no message in the room.
  const outputs: ExpectedOutput[] = Array.isArray(session.expectedOutputs)
    ? (session.expectedOutputs as ExpectedOutput[])
    : [];
  const chosen = selectSlotToAnswer(outputs, p.expectedLabel);
  if ("refused" in chosen) return { status: chosen.refused };
  const slot = outputs[chosen.index]!;
  const label = slot.label;
  const ask = slot.ask ?? null;
  const seenAsk = askFingerprint(ask);
  if (p.askFingerprint !== undefined && p.askFingerprint !== seenAsk) {
    return { status: "ask_changed" };
  }

  const resolved = resolveAnswer(ask, p.value, p.text);
  if ("refused" in resolved) return resolved.refused;
  let summary = resolved.text;
  const value = resolved.value;

  // PROVIDE — the pod's half of the rule: the reference must name a row the
  // person owns (or, for a file, can see). The shape already refused a
  // plaintext credential; this refuses someone else's secret.
  if (value?.type === "provide") {
    const check = await checkProvideRef({ userId: p.userId, ref: value.ref });
    if (!check.ok) {
      return {
        status: "ask_invalid",
        code: "provide_unreachable",
        message: check.message,
      };
    }
    if (check.refName) {
      summary = summarizeAnswer(ask, value, p.text, {
        refName: check.refName,
      });
    }
  }

  const text = summary.trim().slice(0, SLOT_ANSWER_TEXT_MAX);
  if (!text) return { status: "empty_answer" };

  // PARAM — the answer becomes the run's param value (`answer-slot.ts`); a
  // value that cannot be read as the param's type is refused HERE, before
  // anything is posted.
  const param = paramValueFromAnswer(slot, value, text);
  if (param.status === "invalid") {
    return {
      status: "ask_invalid",
      code: "invalid_field",
      message: param.message,
    };
  }

  // CRITERION — the answer is a GRADE, and it goes through the grade door.
  // The criterion must still be declared, checked BEFORE posting so a stale
  // slot leaves no "Pass" in the room.
  const verdict =
    slot.kind === CRITERION_SLOT_KIND && slot.criterionKey
      ? criterionVerdictOf(value)
      : null;
  if (
    verdict &&
    !readCriteria(session.criteria).some((c) => c.key === slot.criterionKey)
  ) {
    return {
      status: "ask_invalid",
      code: "invalid_field",
      message: "This check is no longer one of the session's criteria.",
    };
  }

  // The answer is said IN the room, as the person, so the conversation the
  // agent reads is whole. The message id is MINTED here and the post lands
  // only AFTER the answer commits: a refusal at the lock (`ask_changed`, an
  // `already_done` race) must leave no answer sitting in the room, and the
  // stamp still names the message it will be (`postedMessageIdFor` is the
  // derivation `postChannelMessage` itself uses for this key).
  let messageId: string | null = null;
  let postKey: string | null = null;
  let question: OpenQuestion | null = null;
  if (session.channelId) {
    question = await findOpenQuestion(session.channelId, { slotLabel: label });
    // A fresh key: two identical answers ("yes") to two questions are two
    // answers, never a content-dedup collapse.
    postKey = `slot-answer:${randomUUID()}`;
    messageId = postedMessageIdFor(session.channelId, postKey);
  }

  const answered = await answerExpectedOutput({
    sessionId: session.id,
    userId: p.userId,
    expectedLabel: label,
    text,
    messageId,
    ...(question ? { question: question.content } : {}),
    ...(value ? { value } : {}),
    // The ask THIS answer was validated against — re-checked under the lock.
    askFingerprint: seenAsk,
    // A grade keeps the slot the person's: the grade door discharges it.
    ...(verdict ? { handBack: false } : {}),
  });
  if (answered.status !== "answered") return answered;

  // Everything below runs AFTER the answer committed, and is best-effort like
  // attest's tail: a failure is logged and reported in the result, never
  // thrown — a committed answer must not come back as a 500 that invites the
  // person to answer twice.
  let posted = false;
  if (session.channelId && postKey) {
    try {
      await postChannelMessage({
        channelId: session.channelId,
        content: text,
        role: "user",
        triggerAI: false,
        userId: p.userId,
        idempotencyKey: postKey,
      });
      posted = true;
    } catch (err) {
      logger.warn(
        { err, sessionId: session.id, messageId },
        "answer: the room post failed — the answer is recorded, its message id names no message"
      );
    }
  }

  let graded:
    | { verdict: "pass" | "fail"; recorded: boolean; resumed: boolean }
    | undefined;
  if (verdict && slot.criterionKey) {
    try {
      const { gradeCriterionAsOwner } =
        await import("./evaluations/evaluate.js");
      // The typed note (if any) is the rationale — never the summary line.
      const note = p.text?.trim() || null;
      const { out, resumed } = await gradeCriterionAsOwner({
        sessionId: session.id,
        userId: p.userId,
        criterionKey: slot.criterionKey,
        verdict,
        rationale: note,
      });
      graded = { verdict, recorded: out.status === "recorded", resumed };
      if (out.status !== "recorded") {
        logger.warn(
          { sessionId: session.id, status: out.status },
          "criterion answer: the grade did not land — the answer stands"
        );
      }
    } catch (err) {
      graded = { verdict, recorded: false, resumed: false };
      logger.warn(
        { err, sessionId: session.id },
        "criterion answer: the grade threw — the answer stands"
      );
    }
  }

  let questionId: string | null = null;
  let wokeAgentType: string | null = null;
  let triggered = false;
  if (session.channelId && messageId && posted) {
    try {
      if (question) {
        const claimed = await claimQuestionAnswered(question.id, {
          messageId,
          answeredBy: p.userId,
          answeredAt: answered.answer.answeredAt,
          text,
        });
        if (claimed) questionId = question.id;
      }
      wokeAgentType = await resolveWakeAgentType({
        askingAgentUserId: questionId ? question?.agentUserId : null,
        slot: answered.before,
        agentIds: answered.session.agentIds,
      });
      triggered = await wake({
        channelId: session.channelId,
        messageId,
        content: text,
        ownerId: p.userId,
        sessionId: session.id,
        agentType: wokeAgentType,
      });
    } catch (err) {
      logger.warn(
        { err, sessionId: session.id },
        "answer: closing the question / waking the agent failed — the answer is recorded"
      );
    }
  }

  return {
    status: "answered",
    expectedLabel: answered.expectedLabel,
    kind: answered.kind,
    answer: answered.answer,
    handedBack: answered.handedBack,
    messageId: posted ? messageId : null,
    questionId,
    wokeAgentType,
    triggered,
    ...(graded ? { graded } : {}),
  };
}

// ── Entrance 3: "I did this" (attest) ───────────────────────────────────────

/** The room receipt an attestation posts as the person. */
export function attestReceiptText(label: string): string {
  return `Done: ${label}`;
}

export type AttestSessionSlotResult =
  | Exclude<AttestExpectedOutputResult, { status: "attested" }>
  | {
      status: "attested";
      expectedLabel: string;
      kind: string;
      /** The receipt posted in the room; `null` when the session has no room. */
      messageId: string | null;
      /** The agent question about this slot the receipt closed, if one was open. */
      questionId: string | null;
      wokeAgentType: string | null;
      triggered: boolean;
    };

/**
 * ATTEST, whole: the ONE `done` stamp (`attestExpectedOutput`, which also
 * appends `focus_session.slot_attested.completed`), then — only once it
 * committed — the receipt IN the room as the person ("Done: <label>") and the
 * wake of the agent that handed the work over, through the ONE turn door.
 *
 * Before this, "I did this" wrote the row and nothing else: the agent that was
 * blocked on the person was never told, and sat until something else woke it.
 *
 * Ordered AFTER the stamp (like the answer door, which pre-mints its message
 * id because its stamp points at the message): a refused attestation must
 * leave no "Done" in the room, and nothing points back at the receipt. An open agent
 * question about the slot is closed by the receipt, so an agent the pod cannot
 * wake still sees it on its poll door (`GET /focus-sessions/:id/answers`).
 * Side effects after the stamp are best-effort: the slot is done either way.
 */
export async function attestSessionSlot(p: {
  sessionId: string;
  /** Owner floor AND the attesting person. */
  userId: string;
  expectedLabel: string;
}): Promise<AttestSessionSlotResult> {
  const attested = await attestExpectedOutput(p);
  if (attested.status !== "attested") return attested;

  const channelId = attested.session.channelId;
  let messageId: string | null = null;
  let questionId: string | null = null;
  let wokeAgentType: string | null = null;
  let triggered = false;
  if (channelId) {
    try {
      const question = await findOpenQuestion(channelId, {
        slotLabel: attested.expectedLabel,
      });
      const content = attestReceiptText(attested.expectedLabel);
      const posted = await postChannelMessage({
        channelId,
        content,
        role: "user",
        triggerAI: false,
        userId: p.userId,
        idempotencyKey: `slot-attest:${attested.session.id}:${attested.attestedAt}:${attested.expectedLabel}`,
      });
      messageId = posted.messageId;
      if (question) {
        const claimed = await claimQuestionAnswered(question.id, {
          messageId,
          answeredBy: p.userId,
          answeredAt: attested.attestedAt,
          text: content,
        });
        if (claimed) questionId = question.id;
      }
      wokeAgentType = await resolveWakeAgentType({
        askingAgentUserId: questionId ? question?.agentUserId : null,
        slot: attested.before,
        agentIds: attested.session.agentIds,
      });
      triggered = await wake({
        channelId,
        messageId,
        content,
        ownerId: p.userId,
        sessionId: attested.session.id,
        agentType: wokeAgentType,
      });
    } catch (err) {
      logger.warn(
        { err, sessionId: attested.session.id },
        "attest: the room receipt / agent wake failed — the slot is done"
      );
    }
  }

  return {
    status: "attested",
    expectedLabel: attested.expectedLabel,
    kind: attested.kind,
    messageId,
    questionId,
    wokeAgentType,
    triggered,
  };
}

/**
 * The answer to STORE for a slot's ask, or the refusal. Pure.
 *
 * No ask ⇒ today's rule: free text, no typed value (a typed value on an
 * ask-less slot is refused rather than silently dropped). With an ask ⇒ the
 * value (default: free text) is re-parsed — redaction holds whichever door
 * called — then validated, and the text becomes its summary.
 */
export function resolveAnswer(
  ask: ExpectedOutput["ask"],
  rawValue: AskAnswerValue | SlotAnswerValue | undefined,
  rawText: string | undefined
):
  | { text: string; value: SlotAnswerValue | undefined }
  | {
      refused: Extract<AnswerSessionSlotResult, { status: "ask_invalid" }>;
    } {
  const text = rawText ?? "";
  if (!ask && rawValue === undefined) return { text, value: undefined };
  const parsed = AskAnswerValueSchema.safeParse(rawValue ?? { type: "text" });
  if (!parsed.success) {
    return {
      refused: {
        status: "ask_invalid",
        code: "type_mismatch",
        message: parsed.error.issues[0]?.message ?? "Invalid answer value",
      },
    };
  }
  const checked = validateAnswerAgainstAsk(ask ?? null, parsed.data, text);
  if (!checked.ok) {
    return {
      refused: {
        status: "ask_invalid",
        code: checked.code,
        message: checked.message,
      },
    };
  }
  // An ask-less slot answered with `{type:'text'}` stays a legacy answer.
  if (!ask) return { text, value: undefined };
  return {
    text: summarizeAnswer(ask, checked.value, text),
    value: checked.value,
  };
}

/**
 * Every way a slot door (answer, ask-about) refuses — the answer door's
 * refusals plus "this session has no room" (`askAboutSlot`).
 */
export type SlotDoorRefusal =
  | Exclude<AnswerSessionSlotResult, { status: "answered" }>
  | { status: "no_room" };

/**
 * The ONE wording of a slot-door refusal, for every door (tRPC answer +
 * ask-about, Hub answer), so a client reads the same sentence — and the same
 * machine prefix (`ask_changed:` / `ask_invalid:`, `SLOT_MOVED_ON_PHRASES`) —
 * whichever it called. Takes a REFUSAL only: callers narrow success away
 * first, so there is no "unknown" arm to invent.
 */
export function describeAnswerRefusal(
  result: SlotDoorRefusal,
  expectedLabel: string,
  sessionId: string
): {
  code: "NOT_FOUND" | "BAD_REQUEST" | "CONFLICT";
  message: string;
} {
  switch (result.status) {
    case "not_found":
      return {
        code: "NOT_FOUND",
        message: `Focus session ${sessionId} not found`,
      };
    case "unknown_label":
      return {
        code: "NOT_FOUND",
        message: `This session ${SLOT_MOVED_ON_PHRASES.unknownLabel} "${expectedLabel}"`,
      };
    case "already_done":
      return {
        code: "BAD_REQUEST",
        message: `"${expectedLabel}" ${SLOT_MOVED_ON_PHRASES.alreadyDone}`,
      };
    case "retired":
      return {
        code: "BAD_REQUEST",
        message: `"${expectedLabel}" ${SLOT_MOVED_ON_PHRASES.retired} with its cancelled session`,
      };
    case "empty_answer":
      return { code: "BAD_REQUEST", message: "The answer is empty" };
    case "ask_changed":
      return {
        code: "CONFLICT",
        message: `${ASK_CHANGED_PREFIX} the question on "${expectedLabel}" changed since you opened it — here is the current one`,
      };
    case "ask_invalid":
      return {
        code: "BAD_REQUEST",
        message: `${ASK_INVALID_PREFIX} ${result.message}`,
      };
    case "no_room":
      return {
        code: "BAD_REQUEST",
        message: "This session has no room to ask in.",
      };
  }
}
