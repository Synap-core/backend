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
import { postChannelMessage } from "../messaging/post-message.js";
import { triggerAutoRespond } from "../../utils/trigger-auto-respond.js";
import { normalizeExpectedLabel } from "./expected-label.js";
import {
  attestExpectedOutput,
  type AttestExpectedOutputResult,
} from "./satisfy-expected-output.js";
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

export type OwnerRoomReplyResult =
  | { status: "no_session" | "not_owner" | "no_open_question" | "failed" }
  | {
      status: "answered";
      questionId: string;
      /** The slot outcome when the question named one; absent otherwise. */
      slot?: AnswerExpectedOutputResult["status"];
      woke: boolean;
    };

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

    let slot: AnswerExpectedOutputResult["status"] | undefined;
    if (question.slotLabel) {
      const answered = await answerExpectedOutput({
        sessionId: session.id,
        userId: p.userId,
        expectedLabel: question.slotLabel,
        text,
        messageId: p.messageId,
        question: question.content,
        now: answeredAt,
      });
      slot = answered.status;
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
    columns: { id: true, channelId: true, expectedOutputs: true },
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
  const text = resolved.text.trim().slice(0, SLOT_ANSWER_TEXT_MAX);
  if (!text) return { status: "empty_answer" };
  const value = resolved.value;

  // The answer is said IN the room, as the person, so the conversation the
  // agent reads is whole. Posted BEFORE the stamp (the delegate door's order):
  // a stamp pointing at a message that never landed would be a durable lie.
  let messageId: string | null = null;
  let question: OpenQuestion | null = null;
  if (session.channelId) {
    question = await findOpenQuestion(session.channelId, { slotLabel: label });
    const posted = await postChannelMessage({
      channelId: session.channelId,
      content: text,
      role: "user",
      triggerAI: false,
      userId: p.userId,
      // A fresh key: two identical answers ("yes") to two questions are two
      // answers, never a content-dedup collapse.
      idempotencyKey: `slot-answer:${randomUUID()}`,
    });
    messageId = posted.messageId;
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
  });
  if (answered.status !== "answered") return answered;

  let questionId: string | null = null;
  if (question && messageId) {
    const claimed = await claimQuestionAnswered(question.id, {
      messageId,
      answeredBy: p.userId,
      answeredAt: answered.answer.answeredAt,
      text,
    });
    if (claimed) questionId = question.id;
  }

  let wokeAgentType: string | null = null;
  let triggered = false;
  if (session.channelId && messageId) {
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
  }

  return {
    status: "answered",
    expectedLabel: answered.expectedLabel,
    kind: answered.kind,
    answer: answered.answer,
    handedBack: answered.handedBack,
    messageId,
    questionId,
    wokeAgentType,
    triggered,
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
 * Ordered AFTER the stamp (unlike the answer door, which posts first because
 * its stamp points at the message): a refused attestation must leave no
 * "Done" in the room, and nothing points back at the receipt. An open agent
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
 * The ONE wording of an answer-door refusal, for both doors (tRPC and Hub),
 * so a client reads the same sentence — and the same machine prefix
 * (`ask_changed:` / `ask_invalid:`, `SLOT_MOVED_ON_PHRASES`) — whichever it
 * called. `null` for success.
 */
export function describeAnswerRefusal(
  result: AnswerSessionSlotResult,
  expectedLabel: string,
  sessionId: string
): {
  code: "NOT_FOUND" | "BAD_REQUEST" | "CONFLICT";
  message: string;
} | null {
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
    case "answered":
      return null;
  }
}
