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
 * ── WHO IS WOKEN ────────────────────────────────────────────────────────────
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
  focusSessions,
  getRequestGrant,
  and,
  eq,
  desc,
  drizzleSql,
  playbookRuns,
  liveRunStatusWhere,
  isNull,
  MessageAuthorType,
  openRoomQuestionConditions as sharedOpenRoomQuestionConditions,
  proposals,
  ProposalStatus,
  inArray,
  or,
} from "@synap/database";
import type { SQL } from "@synap/database";
import { createLogger } from "@synap-core/core";
import type {
  ExpectedOutput,
  SlotAnswer,
  SlotAnswerProvenance,
  SlotAnswerValue,
  SlotAsk,
  SlotAskSnapshot,
  SlotPendingRelay,
} from "@synap/playbooks";
import {
  ASK_LIMITS,
  AskAnswerValueSchema,
  askFingerprint,
  effectiveAskStakes,
  effectiveSlotAsk,
  resolveAskResolution,
  summarizeAnswer,
  validateAnswerAgainstAsk,
  ASK_CHANGED_PREFIX,
  ASK_INVALID_PREFIX,
  SLOT_MOVED_ON_PHRASES,
  type Ask,
  type AskAnswerValue,
  type AskAnswerRefusalCode,
  type AskStakes,
  type ProvideSecretGrant,
  type QuestionClosed,
} from "@synap-core/types/ask";
import { vaultSecretIdOf } from "@synap-core/types/vault";
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
import { resolveAgentReach } from "../agent-dispatch/agent-binding.js";
import { agentsOperatedBy } from "../agent-presence.js";
import { wakeExternalAgent } from "../agent-dispatch/wake-external-agent.js";
import { normalizeExpectedLabel } from "./expected-label.js";
import { isTerminalSessionStatus } from "./session-statuses.js";
import {
  attestExpectedOutput,
  type AttestExpectedOutputResult,
} from "./satisfy-expected-output.js";
import { AWAITED_GATE_PROPOSAL_TYPES, readCriteria } from "@synap/playbooks";
import type { PROPOSE_REASON } from "@synap/governance-policy";
import { grantWriteDenial } from "../../utils/grant-write-check.js";
import { notifySessionNeedsYou } from "./notify-needs-you.js";
import { CRITERION_SLOT_KIND } from "@synap-core/types/focus-sessions";
import { checkProvideRef } from "./provide-ref.js";
import {
  grantProvidedSecret,
  planProvidedSecretGrant,
  withdrawProvidedSecretGrant,
} from "./provide-secret-grant.js";
import { paramValueFromAnswer } from "./param-slots.js";
import { criterionVerdictOf } from "./evaluations/record.js";
import {
  answerExpectedOutput,
  selectSlotToAnswer,
  SLOT_ANSWER_TEXT_MAX,
  type AnswerExpectedOutputResult,
} from "./answer-slot.js";
import { stampBlocked, stampUnblocked } from "./block-output.js";
import { updateExpectedOutputsLocked } from "./delegate-output.js";
import { emitSideEffects } from "@synap/events";
import { logEvent } from "../../lib/event-helpers.js";
import {
  FOCUS_SESSION_SUBJECT_TYPE,
  FOCUS_SESSION_RELAY_CORRECT_ACTION,
  FOCUS_SESSION_RELAY_CORRECTED_EVENT_TYPE,
  FOCUS_SESSION_QUESTION_WITHDRAWN_EVENT_TYPE,
} from "./lifecycle-events.js";

const logger = createLogger({ module: "session-answer" });

// ── Questions ────────────────────────────────────────────────────────────────

export interface OpenQuestion {
  id: string;
  content: string;
  /** The agent that asked (`messages.routed_teammate_id`). */
  agentUserId: string | null;
  slotLabel: string | null;
  /**
   * The provider tool call this question is the approval card for (set only
   * by the external-agent status poll). Only a typed confirm of the card's
   * slot settles it — never a reply in words.
   */
  confirmationId: string | null;
  timestamp: Date;
}

/**
 * THE "open agent question" predicate on `messages`, as SQL — ONE definition
 * for every reader (this file, the needs-you union's live-state read). An
 * AI-agent message, not deleted, whose server-owned `roomPost` marker says
 * `question` and carries no `answer` stamp.
 */
export function openRoomQuestionConditions(): SQL[] {
  // ONE rule, shared with the reapers (`@synap/database` open-room-question).
  return sharedOpenRoomQuestionConditions(messages);
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
      confirmationId: meta.confirmationId ?? null,
      timestamp: row.timestamp,
    };
  }
  return null;
}

/** The `{roomPost,<key>}` JSONB path of one stamp on a room post. */
function roomPostPath(key: keyof RoomPostMeta): string {
  return `{${ROOM_POST_META_KEY},${key}}`;
}

/** SQL: the room post carries no stamp under `key`. */
function roomPostLacks(key: keyof RoomPostMeta): SQL {
  // A typed key, inlined as a literal like every other `?` test here.
  return drizzleSql`NOT ((${messages.metadata}->${ROOM_POST_META_KEY}) ? ${drizzleSql.raw(`'${key}'`)})`;
}

/**
 * Stamp the question answered — ATOMICALLY. Returns `false` when another reply
 * got there first (the question was no longer open, or was closed), so a
 * question is answered exactly once. A relay that waited for the person's tap
 * (`pendingRelay`) goes in the same write: an answer settles it. Hash-safe:
 * `computeMessageHash` covers (id, content) only.
 */
export async function claimQuestionAnswered(
  questionId: string,
  answer: NonNullable<RoomPostMeta["answer"]>
): Promise<boolean> {
  const claimed = await db
    .update(messages)
    .set({
      metadata: drizzleSql`jsonb_set(${messages.metadata} #- ${roomPostPath("pendingRelay")}::text[], ${roomPostPath("answer")}::text[], ${JSON.stringify(answer)}::jsonb, true)`,
    })
    .where(
      and(
        eq(messages.id, questionId),
        roomPostLacks("answer"),
        roomPostLacks("closed")
      )
    )
    .returning({ id: messages.id });
  return claimed.length > 0;
}

/**
 * Write one stamp on a question that is still OPEN (no answer, not closed) —
 * atomically, like the answer claim. `false` ⇒ the question moved on first.
 */
async function stampOpenQuestion(
  questionId: string,
  key: "pendingRelay" | "closed",
  value: SlotPendingRelay | QuestionClosed
): Promise<boolean> {
  const stamped = await db
    .update(messages)
    .set({
      metadata: drizzleSql`jsonb_set(${messages.metadata}, ${roomPostPath(key)}::text[], ${JSON.stringify(value)}::jsonb, true)`,
    })
    .where(
      and(
        eq(messages.id, questionId),
        roomPostLacks("answer"),
        roomPostLacks("closed")
      )
    )
    .returning({ id: messages.id });
  return stamped.length > 0;
}

/**
 * Drop a relayed stamp from a question, when it is still there: the relay
 * waiting for the tap (`pendingRelay`), or a RELAYED answer nobody confirmed
 * (`answer` with `via: 'relayed'` and no `confirmedAt` — a tap is never
 * dropped this way). `false` ⇒ there was nothing of the kind to drop.
 */
async function dropRelayedQuestionStamp(
  questionId: string,
  key: "pendingRelay" | "answer"
): Promise<boolean> {
  const answerPath = drizzleSql`${messages.metadata}->${ROOM_POST_META_KEY}->'answer'`;
  const dropped = await db
    .update(messages)
    .set({
      metadata: drizzleSql`${messages.metadata} #- ${roomPostPath(key)}::text[]`,
    })
    .where(
      and(
        eq(messages.id, questionId),
        key === "pendingRelay"
          ? drizzleSql`(${messages.metadata}->${ROOM_POST_META_KEY}) ? 'pendingRelay'`
          : drizzleSql`${answerPath}->>'via' = 'relayed' AND NOT ((${answerPath}) ? 'confirmedAt')`
      )
    )
    .returning({ id: messages.id });
  return dropped.length > 0;
}

/**
 * ONE agent question in this room, by id — whatever state it is in (the
 * caller reads `meta` to tell open from answered / closed). `null` when the
 * id names no persisted, undeleted agent question of this room.
 */
async function findRoomQuestion(
  channelId: string,
  messageId: string
): Promise<(OpenQuestion & { meta: RoomPostMeta }) | null> {
  if (!UUID_SHAPE.test(messageId)) return null;
  const [row] = await db
    .select({
      id: messages.id,
      content: messages.content,
      metadata: messages.metadata,
      routedTeammateId: messages.routedTeammateId,
      timestamp: messages.timestamp,
    })
    .from(messages)
    .where(
      and(
        eq(messages.id, messageId),
        eq(messages.channelId, channelId),
        eq(messages.authorType, MessageAuthorType.AI_AGENT),
        isNull(messages.deletedAt)
      )
    )
    .limit(1);
  const meta = row ? readRoomPostMeta(row.metadata) : null;
  if (!row || meta?.kind !== "question") return null;
  return {
    id: row.id,
    content: row.content,
    agentUserId: row.routedTeammateId ?? null,
    slotLabel: meta.slotLabel ?? null,
    confirmationId: meta.confirmationId ?? null,
    timestamp: row.timestamp,
    meta,
  };
}

// ── Who is woken ─────────────────────────────────────────────────────────────

/**
 * Can the POD run this agent (an Intelligence-Service agent), as opposed to an
 * agent that works through its own door key?
 *
 * Built on THE reach rule (`resolveAgentReach`, `services/agent-dispatch`):
 * only reach `'pod'` returns its agent type. An external agent — one that owns
 * a non-internal key (live or revoked: `provisionSurfaceAgentKey` mints
 * `api_keys.user_id = agentUser`; a pod-run agent acts only through the IS's
 * `is_internal` key) or one bound for dispatch (`dispatched_via`) — is never
 * given an IS turn: that would be an impersonation.
 */
export async function podRunAgentType(
  agentUserId: string
): Promise<string | null> {
  if ((await resolveAgentReach(agentUserId)) !== "pod") return null;
  const [agent] = await db
    .select({ agentType: users.agentType })
    .from(users)
    .where(eq(users.id, agentUserId))
    .limit(1);
  return agent?.agentType?.trim() || null;
}

/**
 * WHO an answer wakes, and HOW — reach-aware.
 *   `{ reach: 'pod', agentType }`         an IS turn (`triggerAutoRespond`);
 *   `{ reach: 'dispatch', agentUserId }`  the agent's binding `send` verb
 *                                         (`wakeExternalAgent`);
 *   `null`                                nobody — a `'pull'` agent reads the
 *                                         answer itself on its next turn.
 */
export type WakeTarget =
  | { reach: "pod"; agentType: string }
  | { reach: "dispatch"; agentUserId: string; agentType: string | null };

/**
 * The asker wins outright — when a question exists, only its author may be
 * woken (never a bystander agent answering someone else's question). Without
 * one: the slot's `delegatedTo` (an agent TYPE the pod runs), then the first
 * staffed agent the pod can reach (pod-run or dispatch; pull agents are skipped).
 *
 * ONE exception to "only the asker": a dispatched agent reports back through
 * its OWN MCP connector, which is a different identity than the agent the pod
 * dispatched to (a Claude Code routine writes as the person's claude.ai
 * connector agent, not as the bound agent). So when the asker cannot be woken
 * itself (reach `pull`), is operated BY the session's owner, and the session
 * has a LIVE run handed to a dispatch agent, the answer goes to that run's
 * agent — it is who the work was handed to. Without `session` the rule is the
 * strict one.
 */
export async function resolveWakeTarget(p: {
  askingAgentUserId?: string | null;
  slot?: ExpectedOutput | null;
  agentIds?: string[];
  /** The room's session + its owner — enables the dispatched-run fallback. */
  session?: { id: string; ownerId: string };
}): Promise<WakeTarget | null> {
  const targetFor = async (agentUserId: string): Promise<WakeTarget | null> => {
    const reach = await resolveAgentReach(agentUserId);
    if (reach === "dispatch") {
      const [agent] = await db
        .select({ agentType: users.agentType })
        .from(users)
        .where(eq(users.id, agentUserId))
        .limit(1);
      return {
        reach,
        agentUserId,
        agentType: agent?.agentType?.trim() || null,
      };
    }
    if (reach === "pod") {
      const agentType = await podRunAgentType(agentUserId);
      return agentType ? { reach, agentType } : null;
    }
    return null;
  };
  if (p.askingAgentUserId) {
    const asker = await targetFor(p.askingAgentUserId);
    if (asker || !p.session) return asker;
    return dispatchedRunWakeTarget(p.askingAgentUserId, p.session, targetFor);
  }
  const delegated = p.slot?.delegatedTo?.trim();
  if (delegated) return { reach: "pod", agentType: delegated };
  for (const agentId of p.agentIds ?? []) {
    const target = await targetFor(agentId);
    if (target) return target;
  }
  return null;
}

/**
 * The dispatched-run fallback of `resolveWakeTarget` (see its docblock): the
 * newest LIVE run of this session handed to an external agent, when the asker
 * is an agent the session's owner operates. `null` otherwise.
 */
async function dispatchedRunWakeTarget(
  askingAgentUserId: string,
  session: { id: string; ownerId: string },
  targetFor: (agentUserId: string) => Promise<WakeTarget | null>
): Promise<WakeTarget | null> {
  const operated = await agentsOperatedBy(session.ownerId, [askingAgentUserId]);
  if (!operated.has(askingAgentUserId)) return null;
  const [run] = await db
    .select({
      agentUserId: drizzleSql<
        string | null
      >`${playbookRuns.externalAgent}->>'agentUserId'`,
    })
    .from(playbookRuns)
    .where(
      and(
        eq(playbookRuns.sessionId, session.id),
        liveRunStatusWhere(playbookRuns.status),
        drizzleSql`${playbookRuns.externalAgent}->>'externalId' IS NOT NULL`
      )
    )
    .orderBy(desc(playbookRuns.startedAt))
    .limit(1);
  if (!run?.agentUserId || run.agentUserId === askingAgentUserId) return null;
  const target = await targetFor(run.agentUserId);
  return target?.reach === "dispatch" ? target : null;
}

/**
 * The agent TYPE to wake with an IS turn, or `null` for "nobody the pod runs".
 * A dispatch target is NOT a type — callers that can reach one use
 * `resolveWakeTarget`; this stays for the IS-only doors (ask-about-slot).
 */
export async function resolveWakeAgentType(p: {
  askingAgentUserId?: string | null;
  slot?: ExpectedOutput | null;
  agentIds?: string[];
}): Promise<string | null> {
  const target = await resolveWakeTarget(p);
  return target?.reach === "pod" ? target.agentType : null;
}

/** The agent type a wake target names — the result's `wokeAgentType`. */
function wakeTargetLabel(target: WakeTarget | null): string | null {
  return target?.agentType ?? null;
}

async function wake(p: {
  channelId: string;
  messageId: string;
  content: string;
  ownerId: string;
  sessionId: string;
  target: WakeTarget | null;
  /** What the answer was about, for the external agent's `send`. */
  slotLabel?: string | null;
  /**
   * A typed approve / reject of an APPROVAL CARD (`OpenQuestion.confirmationId`):
   * the external agent gets a decision naming that provider tool call. Absent
   * ⇒ the words go to the agent as an answer, which never settles a call.
   */
  confirmation?: { confirmationId: string; decision: "approved" | "rejected" };
}): Promise<boolean> {
  if (!p.target) return false;
  if (p.target.reach === "dispatch") {
    // An external agent the pod dispatches to: its binding's `send` verb, the
    // ONE loop-back door. Never an IS turn under its name.
    const sent = await wakeExternalAgent({
      sessionId: p.sessionId,
      agentUserId: p.target.agentUserId,
      ...(p.confirmation
        ? {
            kind: "decision" as const,
            decision: p.confirmation.decision,
            confirmationId: p.confirmation.confirmationId,
          }
        : { kind: "answer" as const }),
      text: p.content,
      ...(p.slotLabel ? { slotKey: p.slotLabel } : {}),
      idempotencyKey: `answer:${p.messageId}`,
    });
    return sent.status === "sent";
  }
  return triggerAutoRespond({
    channelId: p.channelId,
    userMessageId: p.messageId,
    content: p.content,
    sourceUserId: p.ownerId,
    focusSessionId: p.sessionId,
    agentType: p.target.agentType,
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

  // The STORED ask, not the derived decision confirm (`effectiveSlotAsk`): a
  // decision filed without an ask was often an open question ("EU or US?"),
  // and the person's words in the room ARE their choice — recorded as the
  // answer, and filed as a decision by the answer door. Only a bare "I did
  // this" is refused on it.
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

    if (question.confirmationId) {
      // An APPROVAL CARD is answered from the card (a typed approve / reject),
      // never by words: the card stays open and its slot owed. The words still
      // reach the agent — as an answer, which settles nothing.
      const woke = p.wake
        ? await wake({
            channelId: p.channelId,
            messageId: p.messageId,
            content: p.content,
            ownerId: p.userId,
            sessionId: session.id,
            target: await resolveWakeTarget({
              askingAgentUserId: question.agentUserId,
              session: { id: session.id, ownerId: p.userId },
            }),
            slotLabel: question.slotLabel,
          })
        : false;
      return {
        status: "answered",
        questionId: question.id,
        slot: "kept_owed",
        woke,
      };
    }

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
          target: await resolveWakeTarget({
            askingAgentUserId: question.agentUserId,
            session: { id: session.id, ownerId: p.userId },
          }),
          slotLabel: question.slotLabel,
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
  /** `confirmRelayed` on a slot with no relay waiting for the person's tap. */
  | { status: "no_pending_relay" }
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
      /** The agent type woken (an IS turn, or a dispatched agent's `send`), or `null` when none the pod can reach. */
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
      /** The `decision` entity this answer filed or updated. */
      decision?: Extract<
        AnswerExpectedOutputResult,
        { status: "answered" }
      >["decision"];
      /**
       * A handed-over SECRET only: whether the agent that asked may now read
       * it (`@synap-core/types/ask` `ProvideSecretGrant`) — the receipt.
       */
      secretGrant?: ProvideSecretGrant;
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
const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The grant request an ANSWER is, for the key half of both answer doors (tRPC
 * `focusSessions.answerOutput`, Hub `POST /focus-sessions/:id/outputs/answer`):
 * an update of the session IN ITS OWN SPACE AND PROJECT. Without them a key
 * bounded to some spaces — a person's "Sign in with Synap" token — could
 * answer nowhere, and one with a pinned project would fail closed everywhere.
 * Read before the owner floor on purpose: a session the caller cannot answer
 * is refused the same way whether or not it exists.
 */
export async function answerGrantWrite(sessionId: string): Promise<{
  subjectType: "focus_session";
  action: "update";
  workspaceId: string | null;
  projectId: string | null;
}> {
  // Only a key bounded by space or project needs the session's place; a
  // signed-in person (no grant) and an unbounded key are answered as before.
  const placed =
    getRequestGrant()?.scopes.some((s) => s.workspaceIds || s.projectIds) ??
    false;
  const [row] =
    placed && UUID_SHAPE.test(sessionId)
      ? await db
          .select({
            workspaceId: focusSessions.workspaceId,
            projectId: focusSessions.projectId,
          })
          .from(focusSessions)
          .where(eq(focusSessions.id, sessionId))
          .limit(1)
      : [];
  return {
    subjectType: "focus_session",
    action: "update",
    workspaceId: row?.workspaceId ?? null,
    projectId: row?.projectId ?? null,
  };
}

export async function answerSessionSlot(p: {
  sessionId: string;
  /** Owner floor AND the answering person. */
  userId: string;
  expectedLabel: string;
  text?: string;
  value?: AskAnswerValue | SlotAnswerValue;
  askFingerprint?: string;
  /**
   * A secret answer: the agent the person was shown as the one who will read
   * it (`provideOptions`). The read is granted only when it is still the
   * asker; absent, the server's asker stands alone.
   */
  expectedGranteeId?: string;
  /**
   * The person's ONE TAP on a relay that waited for it (`pendingRelay`, a
   * `commitment` an agent relayed — `relaySessionAnswer`): the answer is the
   * relayed one, recorded as theirs (`via: 'tap'` + `confirmedAt`, keeping
   * `relayedBy` / `relaySurface` / `quote`), and everything a tap does follows
   * (hand-back, room post, decision, wake). `text` / `value` are not read.
   */
  confirmRelayed?: boolean;
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
  // A decision slot stored without an ask answers its derived confirm.
  const ask = effectiveSlotAsk(slot);
  const seenAsk = askFingerprint(ask);
  if (p.askFingerprint !== undefined && p.askFingerprint !== seenAsk) {
    return { status: "ask_changed" };
  }

  // CONFIRM — the relayed answer, re-checked against the ask like any other.
  // Its text is kept as relayed: re-summarizing it would fold the summary
  // into itself ("Yes — Yes").
  const pending = p.confirmRelayed ? slot.pendingRelay : undefined;
  if (p.confirmRelayed && !pending) return { status: "no_pending_relay" };
  const confirmedAt = pending ? new Date() : undefined;
  const provenance: SlotAnswerProvenance | undefined =
    pending && confirmedAt
      ? {
          via: "tap",
          relayedBy: pending.relayedBy,
          ...(pending.relaySurface
            ? { relaySurface: pending.relaySurface }
            : {}),
          ...(pending.quote ? { quote: pending.quote } : {}),
          confirmedAt: confirmedAt.toISOString(),
        }
      : undefined;

  const resolved = pending
    ? resolveAnswer(ask, pending.value, undefined)
    : resolveAnswer(ask, p.value, p.text);
  if ("refused" in resolved) return resolved.refused;
  let summary = pending ? pending.text : resolved.text;
  const value = resolved.value;

  // PROVIDE — the pod's half of the rule: the reference must name a row the
  // person owns (or, for a file, can see), and a connection must be for the
  // asked service. The shape already refused a plaintext credential; this
  // refuses someone else's secret or another service's connection.
  if (value?.type === "provide") {
    const check =
      ask?.mode === "provide"
        ? await checkProvideRef({
            userId: p.userId,
            ref: value.ref,
            asked: ask.provide,
          })
        : ({
            ok: false,
            message: "This question does not ask you to hand anything over.",
          } as const);
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

  let text = summary.trim().slice(0, SLOT_ANSWER_TEXT_MAX);
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

  // SECRET — handing it over also lets the agent that asked read it, for this
  // session (`provide-secret-grant.ts`). Written BEFORE the answer commits so
  // the receipt says exactly what exists, and taken back below if the commit
  // is refused. An agent the pod cannot name gets no read; the hand-over
  // still stands, and the receipt says no agent can read it.
  let secretGrant: ProvideSecretGrant | undefined;
  let createdGrantId: string | null = null;
  if (value?.type === "provide" && value.ref.kind === "secret") {
    const secretId = vaultSecretIdOf(value.ref.vaultRef);
    if (secretId) {
      const plan = await planProvidedSecretGrant({
        sessionId: session.id,
        expectedLabel: label,
        askFingerprint: seenAsk,
        secretId,
        ...(p.expectedGranteeId !== undefined
          ? { expectedGranteeId: p.expectedGranteeId }
          : {}),
      });
      ({ grant: secretGrant, createdGrantId } = await grantProvidedSecret({
        plan,
        secretId,
        ownerId: p.userId,
        sessionId: session.id,
        expectedLabel: label,
      }));
      text = summarizeAnswer(ask, value, p.text, {
        secretAccess: { grant: secretGrant, now: Date.now() },
      })
        .trim()
        .slice(0, SLOT_ANSWER_TEXT_MAX);
    }
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
    ...(provenance ? { provenance, now: confirmedAt } : {}),
    // A Confirm confirms the relay the person was shown, re-checked under the
    // lock: a "Not what I said" or a re-ask in between refuses it.
    ...(pending ? { confirmsRelayAt: pending.relayedAt } : {}),
  });
  if (answered.status !== "answered") {
    await withdrawProvidedSecretGrant(createdGrantId);
    return answered;
  }

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
          ...provenance,
        });
        if (claimed) questionId = question.id;
      }
      const target = await resolveWakeTarget({
        askingAgentUserId: questionId ? question?.agentUserId : null,
        slot: answered.before,
        agentIds: answered.session.agentIds,
        session: { id: session.id, ownerId: p.userId },
      });
      wokeAgentType = wakeTargetLabel(target);
      triggered = await wake({
        channelId: session.channelId,
        messageId,
        content: text,
        ownerId: p.userId,
        sessionId: session.id,
        target,
        slotLabel: answered.expectedLabel,
        // Only the claimed approval card's OWN typed confirm names the call.
        ...(questionId && question?.confirmationId && value?.type === "confirm"
          ? {
              confirmation: {
                confirmationId: question.confirmationId,
                decision: value.confirmed ? "approved" : "rejected",
              },
            }
          : {}),
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
    // The decision this answer filed/updated — `failed` said, never hidden.
    ...(answered.decision ? { decision: answered.decision } : {}),
    ...(secretGrant ? { secretGrant } : {}),
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
  /**
   * `askFingerprint(ask)` of the ask the person SAW — the lock-screen "I did
   * it" is sent without reading the pod first, so it must be bound to the
   * question it answered (same rule as the answer door). Omit ⇒ unbound, as
   * before.
   */
  askFingerprint?: string;
}): Promise<AttestSessionSlotResult> {
  // The fingerprint is compared INSIDE the attest door's locked read.
  const attested = await attestExpectedOutput({
    sessionId: p.sessionId,
    userId: p.userId,
    expectedLabel: p.expectedLabel,
    askFingerprint: p.askFingerprint,
  });
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
      const target = await resolveWakeTarget({
        askingAgentUserId: questionId ? question?.agentUserId : null,
        slot: attested.before,
        agentIds: attested.session.agentIds,
        session: { id: attested.session.id, ownerId: p.userId },
      });
      wokeAgentType = wakeTargetLabel(target);
      triggered = await wake({
        channelId,
        messageId,
        content,
        ownerId: p.userId,
        sessionId: attested.session.id,
        target,
        slotLabel: attested.expectedLabel,
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
  | { status: "no_room" }
  | { status: "no_relayed_answer" }
  | { status: "session_ended" };

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
    case "no_pending_relay":
      return {
        code: "BAD_REQUEST",
        message: `"${expectedLabel}" has no relayed answer waiting for you to confirm.`,
      };
    case "not_open":
      return {
        code: "CONFLICT",
        message: `"${expectedLabel}" is no longer an open question: it was answered, or it is no longer the person's.`,
      };
    case "session_ended":
      return {
        code: "BAD_REQUEST",
        message:
          "This session has ended, so its questions are closed — there is nothing to re-open.",
      };
    case "no_relayed_answer":
      return {
        code: "BAD_REQUEST",
        message: "There is no relayed answer here to correct.",
      };
  }
}

/**
 * The person's answer doors' input rule (tRPC `focusSessions.answerOutput`,
 * Hub `POST /focus-sessions/:id/outputs/answer`) — ONE wording for both.
 * An answer needs words or a pick; a Confirm of a relay needs only its slot;
 * a "Not what I said" names its slot, or a slotless room question
 * (`questionId`). `null` = the input is well-formed.
 */
export function answerDoorInputIssue(v: {
  expectedLabel?: string;
  text?: string;
  value?: unknown;
  confirmRelayed?: boolean;
  rejectRelayed?: boolean;
  questionId?: string;
}): string | null {
  if (v.confirmRelayed && v.rejectRelayed) {
    return "Pass `confirmRelayed` or `rejectRelayed`, not both.";
  }
  if (v.rejectRelayed) {
    return v.expectedLabel?.trim() || v.questionId
      ? null
      : "`rejectRelayed` needs `expectedLabel` or `questionId`.";
  }
  if (!v.expectedLabel?.trim()) return "An answer needs `expectedLabel`.";
  if (v.questionId) {
    return "`questionId` is only for `rejectRelayed` on a room question.";
  }
  if (v.confirmRelayed) return null;
  return v.value !== undefined || !!v.text?.trim()
    ? null
    : "An answer needs `text` or `value`.";
}

// ── Entrance 4: an agent RELAYS what the person said in a chat ──────────────

/**
 * What the relaying agent says happened to ONE question it asked.
 *   `answered`  — the person answered it in the chat; `quote` is their words.
 *   `withdrawn` — the agent's need is gone (overtaken); `note` says why.
 */
export const RELAY_DISPOSITIONS = ["answered", "withdrawn"] as const;
export type RelayDisposition = (typeof RELAY_DISPOSITIONS)[number];

export type RelaySessionAnswerResult =
  | Exclude<AnswerSessionSlotResult, { status: "answered" | "no_pending_relay" }>
  /** Neither `messageId` nor `slotLabel`: a relay names its question. */
  | { status: "address_required" }
  /** `messageId` names no agent question of this session's room. */
  | { status: "no_such_question" }
  /** The question / slot is answered, closed, or already awaits a tap. */
  | { status: "not_open" }
  /** `slotLabel` disagrees with the slot the question names. */
  | { status: "label_mismatch" }
  /** The relaying agent did not ask it (and is not on the session). */
  | { status: "not_yours" }
  | { status: "quote_required" }
  | { status: "note_required" }
  /** The key's grant does not reach the session's space / project. */
  | { status: "forbidden"; reason: string }
  /** A withdraw of a step only the person may take ({@link withdrawKeepsPersonsStep}). */
  | { status: "persons_step" }
  | {
      status: "relayed";
      stakes: "routine";
      questionId: string | null;
      expectedLabel: string | null;
      /** The answer as stamped (slot `answer`, or the room post's). */
      answer: SlotAnswer | NonNullable<RoomPostMeta["answer"]>;
      handedBack: boolean;
      decision?: Extract<
        AnswerExpectedOutputResult,
        { status: "answered" }
      >["decision"];
    }
  | {
      status: "awaiting_tap";
      stakes: "commitment";
      questionId: string | null;
      expectedLabel: string;
      pendingRelay: SlotPendingRelay;
    }
  | {
      status: "withdrawn";
      questionId: string | null;
      expectedLabel: string | null;
      /** The slot went back to the agent (it was the person's). */
      handedBack: boolean;
    };

/**
 * What the pod knows about where a slot's answer leads — facts an agent cannot
 * author, read by {@link readRelayPodFacts}.
 */
export interface RelayPodFacts {
  /**
   * The session is stopped at its plan/deploy gate: a PENDING proposal of an
   * awaited gate type (`AWAITED_GATE_PROPOSAL_TYPES`) filed in it.
   */
  gatePending: boolean;
  /** Objects with a PENDING human-only status move (`HUMAN_ONLY_STATUS`). */
  humanOnlyMoveOn: ReadonlySet<string>;
}

export const NO_RELAY_POD_FACTS: RelayPodFacts = {
  gatePending: false,
  humanOnlyMoveOn: new Set(),
};

/** The governance rung's reason code on a human-only status move proposal. */
const HUMAN_ONLY_STATUS_REASON =
  "HUMAN_ONLY_STATUS" satisfies keyof typeof PROPOSE_REASON;

/** A slot's ask as `effectiveSlotAsk` reads it. */
type RelayAsk = SlotAsk | Ask | null;

/** The in-pod entities a slot is ABOUT: its `ref` and what its ask looked at. Pure. */
function slotEntityIds(slot: ExpectedOutput, ask: RelayAsk): string[] {
  const ids = new Set<string>();
  const ref = slot.ref;
  if (ref && "kind" in ref && ref.kind === "entity") ids.add(ref.id);
  for (const r of ask?.lookedAt ?? []) if (r.kind === "entity") ids.add(r.id);
  return [...ids];
}

/**
 * A COMMITMENT the pod forces from its own facts (founder default: plan/deploy
 * gates, human-only status moves, provide-secret, spend). Pure.
 *   - GATE: the session is stopped at its plan/deploy gate, or the gate raised
 *     the ask (`askCause.kind === 'gate'`) — a relayed "yes" while the gate is
 *     pending would read as the go-ahead the gate exists to take;
 *   - HUMAN-ONLY STATUS: the slot is about (its `ref`, or what its ask looked
 *     at) an object with a pending human-only status move;
 *   - a provide-SECRET is forced by `effectiveAskStakes` itself.
 * NOT computable, stated: SPEND — no pod fact marks a write as spending, so
 * the agent's declared `stakes` stays the only signal for it.
 */
export function podForcesCommitment(p: {
  slot: ExpectedOutput | null;
  ask: RelayAsk;
  facts: RelayPodFacts;
}): boolean {
  if (!p.slot) return false;
  if (p.facts.gatePending || p.slot.askCause?.kind === "gate") return true;
  return slotEntityIds(p.slot, p.ask).some((id) =>
    p.facts.humanOnlyMoveOn.has(id)
  );
}

/** One read of the pending proposals {@link podForcesCommitment} looks for. */
export async function readRelayPodFacts(
  sessionId: string,
  slot: ExpectedOutput | null
): Promise<RelayPodFacts> {
  if (!slot) return NO_RELAY_POD_FACTS;
  const entityIds = slotEntityIds(slot, effectiveSlotAsk(slot));
  const rows = await db
    .select({
      proposalType: proposals.proposalType,
      targetId: proposals.targetId,
      governanceReason: proposals.governanceReason,
    })
    .from(proposals)
    .where(
      and(
        eq(proposals.status, ProposalStatus.PENDING),
        or(
          and(
            eq(proposals.sessionId, sessionId),
            inArray(proposals.proposalType, [...AWAITED_GATE_PROPOSAL_TYPES])
          ),
          ...(entityIds.length > 0
            ? [
                and(
                  eq(proposals.governanceReason, HUMAN_ONLY_STATUS_REASON),
                  inArray(proposals.targetId, entityIds)
                ),
              ]
            : [])
        )
      )
    );
  const gates = AWAITED_GATE_PROPOSAL_TYPES as readonly string[];
  return {
    gatePending: rows.some((r) => gates.includes(r.proposalType)),
    humanOnlyMoveOn: new Set(
      rows
        .filter((r) => r.governanceReason === HUMAN_ONLY_STATUS_REASON)
        .map((r) => r.targetId)
    ),
  };
}

/**
 * The facts that make a relay wait for the person's own tap, whatever stakes
 * the agent declared (`effectiveAskStakes` `forced`). Each one is a step only
 * the person may take:
 *   - an APPROVAL CARD — the question approves an external agent's tool call
 *     (`confirmationId`, set only by the status poll);
 *   - a GRADE — a criterion slot's answer passes or fails the agent's work;
 *   - a HAND-OVER — a `provide` ask gives the agent a connection, a file or a
 *     secret of the person's;
 *   - what the pod forces from its proposals ({@link podForcesCommitment}).
 */
export function relayForcedToTap(p: {
  slot: ExpectedOutput | null;
  ask: RelayAsk;
  question: Pick<OpenQuestion, "confirmationId"> | null;
  facts?: RelayPodFacts;
}): boolean {
  return (
    !!p.question?.confirmationId ||
    p.slot?.kind === CRITERION_SLOT_KIND ||
    p.ask?.mode === "provide" ||
    podForcesCommitment({
      slot: p.slot,
      ask: p.ask,
      facts: p.facts ?? NO_RELAY_POD_FACTS,
    })
  );
}

/**
 * Is the person's turn on this question a step only THEY may take — an
 * approval card, a grade, or a commitment (declared, a provide-secret, or
 * forced by the pod)? Then the asking agent may not withdraw it: a withdraw
 * hands the slot back with no answer, which would let the agent go on past
 * the very step the person holds. A connection or file the agent no longer
 * needs IS withdrawable. Pure.
 */
export function withdrawKeepsPersonsStep(p: {
  slot: ExpectedOutput | null;
  question: Pick<OpenQuestion, "confirmationId"> | null;
  facts: RelayPodFacts;
}): boolean {
  const ask = p.slot ? effectiveSlotAsk(p.slot) : null;
  return (
    !!p.question?.confirmationId ||
    p.slot?.kind === CRITERION_SLOT_KIND ||
    effectiveAskStakes({
      ask,
      forced: podForcesCommitment({ slot: p.slot, ask, facts: p.facts }),
    }) === "commitment"
  );
}

/** The stakes a relay to this slot / question is held to. Pure. */
export function relayStakes(p: {
  slot: ExpectedOutput | null;
  question: Pick<OpenQuestion, "confirmationId"> | null;
  facts?: RelayPodFacts;
}): AskStakes {
  const ask = p.slot ? effectiveSlotAsk(p.slot) : null;
  return effectiveAskStakes({
    ask,
    forced: relayForcedToTap({
      slot: p.slot,
      ask,
      question: p.question,
      facts: p.facts,
    }),
  });
}

/**
 * THE relay door — an agent carries what the person said in a CHAT (Claude
 * Code, claude.ai) back to the question it asked in the pod. MCP
 * `synap_relay_answer`, Hub `POST /focus-sessions/:id/answers/relay`.
 *
 * WHO: an AGENT key only (the doors refuse a person), relaying for the
 * session's owner (`userId`, the owner floor), inside the key's grant (the
 * answer doors' rung, `answerGrantWrite` — here, so both relay doors run it).
 * The narrowest rule that still lets the agent do its job: a room question
 * may be relayed only by the agent that ASKED it (`messages.routed_teammate_id`);
 * a slot with no room question, only by the agent that asked it (`askedBy`),
 * else — a slot asked before that stamp existed — an agent on the roster.
 *
 * WHICH: an EXACT question — `messageId` (a room question) or `slotLabel` (a
 * slot; with it, the open question naming that slot moves too). Never "the
 * newest open one": a relay that guessed would put words on the wrong ask.
 * And only a question still OPEN: a slot the person still owes, unanswered,
 * with no relay waiting — a relay never overwrites the person's own tap.
 *
 * ANSWERED — `quote` (the person's words, verbatim, trimmed and capped like an
 * answer) is required; `value` is the typed pick the agent read in them,
 * checked against the ask like a tap. The stakes decide what it does:
 *   - `routine`    → the answer, stamped `via: 'relayed'` + `relayedBy` +
 *                    `relaySurface` + `quote`, through the ONE slot write
 *                    (`answerExpectedOutput`: hand-back, event, decision) and
 *                    the ONE room claim. `answeredBy` stays the owner — it is
 *                    their answer. Nobody is woken: the relaying agent already
 *                    has it, and an IS turn needs a person's message to start
 *                    from, which a relay never posts.
 *   - `commitment` → `pendingRelay` on the slot AND its question, and a push
 *                    asking for the tap; nothing else: the slot stays owed
 *                    (the needs-you row is the one-tap Confirm), no decision,
 *                    no wake. The person's Confirm (`answerSessionSlot`
 *                    `confirmRelayed`) answers.
 *   A slotless room question has no ask, so nothing can raise its stakes: it
 *   is always routine.
 * WITHDRAWN — `note` required. The question is stamped `closed` (reason
 * `withdrawn`); a slot that was the person's goes back to the agent exactly as
 * `unblockExpectedOutput` hands it back, and the note is kept on the
 * `question_withdrawn` history row. Never retired: an act / provide / form
 * slot handed back is still owed, by the agent, until delivered. Refused for a
 * step only the person may take ({@link withdrawKeepsPersonsStep}).
 *
 * NOT `checkPermissionOrPropose`, deliberately: like posting a question or
 * blocking a slot, this records speech about the agent's own ask, and its
 * governance IS the stakes rule above — a commitment never moves without the
 * person's tap, and the person's step is never withdrawn. Every stamp is
 * attributed (`relayedBy`, `closed.by`, the withdraw's history row).
 */
export async function relaySessionAnswer(p: {
  sessionId: string;
  /** Owner floor: the person the agent relays for. */
  userId: string;
  /** The RELAYING agent — the door's verified auth context, never a body. */
  agentUserId: string;
  disposition: RelayDisposition;
  messageId?: string;
  slotLabel?: string;
  quote?: string;
  text?: string;
  value?: AskAnswerValue;
  relaySurface?: string;
  note?: string;
  now?: Date;
}): Promise<RelaySessionAnswerResult> {
  const wantedLabel = p.slotLabel?.trim() || null;
  if (!p.messageId && !wantedLabel) return { status: "address_required" };
  const denial = await grantWriteDenial(await answerGrantWrite(p.sessionId));
  if (denial) return { status: "forbidden", reason: denial };
  const session = await db.query.focusSessions.findFirst({
    where: and(
      eq(focusSessions.id, p.sessionId),
      eq(focusSessions.userId, p.userId)
    ),
    columns: {
      id: true,
      channelId: true,
      expectedOutputs: true,
      agentIds: true,
    },
  });
  if (!session) return { status: "not_found" };
  const outputs: ExpectedOutput[] = Array.isArray(session.expectedOutputs)
    ? (session.expectedOutputs as ExpectedOutput[])
    : [];

  // 1. The EXACT question.
  let question: OpenQuestion | null = null;
  let label = wantedLabel;
  if (p.messageId) {
    const found = session.channelId
      ? await findRoomQuestion(session.channelId, p.messageId)
      : null;
    if (!found) return { status: "no_such_question" };
    if (found.meta.answer || found.meta.closed || found.meta.pendingRelay) {
      return { status: "not_open" };
    }
    if (
      wantedLabel &&
      normalizeExpectedLabel(wantedLabel) !==
        normalizeExpectedLabel(found.slotLabel ?? "")
    ) {
      return { status: "label_mismatch" };
    }
    question = found;
    label = found.slotLabel;
  } else if (session.channelId && label) {
    question = await findOpenQuestion(session.channelId, { slotLabel: label });
  }

  const chosen = label ? selectSlotToAnswer(outputs, label) : null;
  if (chosen && "refused" in chosen) return { status: chosen.refused };
  const slot = chosen ? outputs[chosen.index]! : null;

  // 2. Whose it is: the asker's.
  const mine = question
    ? question.agentUserId === p.agentUserId
    : slot?.askedBy
      ? slot.askedBy === p.agentUserId
      : (session.agentIds ?? []).includes(p.agentUserId);
  if (!mine) return { status: "not_yours" };
  const now = p.now ?? new Date();
  const facts = await readRelayPodFacts(session.id, slot);

  if (p.disposition === "withdrawn") {
    return withdrawRelayedQuestion({ ...p, now, question, slot, facts });
  }

  // 3. ANSWERED — the person's words first.
  const quote = p.quote?.trim().slice(0, ASK_LIMITS.answerTextMaxChars);
  if (!quote) return { status: "quote_required" };
  const surface = p.relaySurface?.trim();
  const provenance: SlotAnswerProvenance = {
    via: "relayed",
    relayedBy: p.agentUserId,
    ...(surface ? { relaySurface: surface } : {}),
    quote,
  };

  if (!slot) {
    // A slotless room question: words only, no ask to read a pick against.
    const resolved = resolveAnswer(null, p.value, p.text?.trim() || quote);
    if ("refused" in resolved) return resolved.refused;
    const text = resolved.text.trim().slice(0, SLOT_ANSWER_TEXT_MAX);
    const answer = {
      // No message carries a relay: the stamp names the question it answers.
      messageId: question!.id,
      answeredBy: p.userId,
      answeredAt: now.toISOString(),
      text,
      ...provenance,
    };
    if (!(await claimQuestionAnswered(question!.id, answer))) {
      return { status: "not_open" };
    }
    return {
      status: "relayed",
      stakes: "routine",
      questionId: question!.id,
      expectedLabel: null,
      answer,
      handedBack: false,
    };
  }

  if (!isOpenAsk(slot)) return { status: "not_open" };
  const ask = effectiveSlotAsk(slot);
  const resolved = resolveAnswer(ask, p.value, p.text?.trim() || quote);
  if ("refused" in resolved) return resolved.refused;
  const text = resolved.text.trim().slice(0, ASK_LIMITS.answerTextMaxChars);
  if (!text) return { status: "empty_answer" };
  const param = paramValueFromAnswer(slot, resolved.value, text);
  if (param.status === "invalid") {
    return {
      status: "ask_invalid",
      code: "invalid_field",
      message: param.message,
    };
  }
  const seenAsk = askFingerprint(ask);

  if (relayStakes({ slot, question, facts }) === "commitment") {
    const pendingRelay: SlotPendingRelay = {
      text,
      ...(resolved.value ? { value: resolved.value } : {}),
      relayedBy: p.agentUserId,
      ...(surface ? { relaySurface: surface } : {}),
      quote,
      relayedAt: now.toISOString(),
    };
    // Under the lock, on the SAME ask the words were read against — a re-ask
    // in between refuses rather than pre-filling the new question.
    const lock: {
      refused?: "unknown_label" | "already_done" | "retired" | "ask_changed";
    } = {};
    const stamped = await updateExpectedOutputsLocked(session.id, (current) => {
      const again = selectSlotToAnswer(current, slot.label);
      if ("refused" in again) {
        lock.refused = again.refused;
        return null;
      }
      const live = current[again.index]!;
      if (!isOpenAsk(live)) return null;
      if (askFingerprint(effectiveSlotAsk(live)) !== seenAsk) {
        lock.refused = "ask_changed";
        return null;
      }
      return current.map((o, i) =>
        i === again.index ? { ...o, pendingRelay } : o
      );
    });
    if (!stamped) return { status: lock.refused ?? "not_open" };
    const onQuestion = question
      ? await stampOpenQuestion(question.id, "pendingRelay", pendingRelay)
      : false;
    // The one interrupt a relay raises: the agent is stopped until the person
    // taps, and they may be nowhere near the pod.
    await notifySessionNeedsYou({
      sessionId: session.id,
      byAgent: true,
      reason: { kind: "relay", slot: { ...slot, pendingRelay } },
    });
    return {
      status: "awaiting_tap",
      stakes: "commitment",
      questionId: onQuestion ? question!.id : null,
      expectedLabel: slot.label,
      pendingRelay,
    };
  }

  const answered = await answerExpectedOutput({
    sessionId: session.id,
    userId: p.userId,
    expectedLabel: slot.label,
    text,
    messageId: question?.id ?? null,
    ...(question ? { question: question.content } : {}),
    ...(resolved.value ? { value: resolved.value } : {}),
    askFingerprint: seenAsk,
    provenance,
    requireOpenAsk: true,
    now,
  });
  // `no_pending_relay` answers a Confirm (`confirmsRelayAt`), which a relay
  // never sends; should it appear, the slot is no longer open to a relay.
  if (answered.status === "no_pending_relay") return { status: "not_open" };
  if (answered.status !== "answered") return answered;
  let questionId: string | null = null;
  if (question) {
    const claimed = await claimQuestionAnswered(question.id, {
      messageId: question.id,
      answeredBy: p.userId,
      answeredAt: answered.answer.answeredAt,
      text,
      ...provenance,
    });
    if (claimed) questionId = question.id;
  }
  return {
    status: "relayed",
    stakes: "routine",
    questionId,
    expectedLabel: answered.expectedLabel,
    answer: answered.answer,
    handedBack: answered.handedBack,
    ...(answered.decision ? { decision: answered.decision } : {}),
  };
}

/**
 * A slot a relay may speak to: owed to the person, unanswered, with no relay
 * already waiting for their tap. Pure.
 */
function isOpenAsk(slot: ExpectedOutput): boolean {
  return slot.owner === "human" && !slot.answer && !slot.pendingRelay;
}

/** WITHDRAWN — close the agent's own question; hand its slot back; record why. */
async function withdrawRelayedQuestion(p: {
  sessionId: string;
  userId: string;
  agentUserId: string;
  note?: string;
  now: Date;
  question: OpenQuestion | null;
  slot: ExpectedOutput | null;
  facts: RelayPodFacts;
}): Promise<RelaySessionAnswerResult> {
  const note = p.note?.trim().slice(0, ASK_LIMITS.promptMaxChars);
  if (!note) return { status: "note_required" };
  const owed = p.slot?.owner === "human";
  if (!p.question && !owed) return { status: "not_open" };
  if (
    withdrawKeepsPersonsStep({
      slot: owed ? p.slot : null,
      question: p.question,
      facts: p.facts,
    })
  ) {
    return { status: "persons_step" };
  }

  let questionId: string | null = null;
  if (p.question) {
    const closed: QuestionClosed = {
      reason: "withdrawn",
      at: p.now.toISOString(),
      by: p.agentUserId,
      note,
    };
    if (!(await stampOpenQuestion(p.question.id, "closed", closed))) {
      return { status: "not_open" };
    }
    questionId = p.question.id;
  }
  // The agent's need is gone, so the person's turn on the slot is too: the
  // ONE hand-back (`stampUnblocked`) — never `retiredAt`, the deliverable is
  // still owed, now by the agent.
  let handedBack = false;
  if (owed && p.slot) {
    const label = p.slot.label;
    handedBack = await updateExpectedOutputsLocked(p.sessionId, (current) => {
      const again = selectSlotToAnswer(current, label);
      if ("refused" in again || current[again.index]!.owner !== "human") {
        return null;
      }
      return stampUnblocked(current, current[again.index]!.label);
    });
  }
  if (!questionId && !handedBack) return { status: "not_open" };

  const expectedLabel = p.slot?.label ?? null;
  try {
    await logEvent(
      p.userId,
      FOCUS_SESSION_QUESTION_WITHDRAWN_EVENT_TYPE,
      {
        sessionId: p.sessionId,
        expectedLabel,
        questionId,
        withdrawnBy: p.agentUserId,
        note,
        handedBack,
        withdrawnAt: p.now.toISOString(),
      },
      {
        subjectId: p.sessionId,
        subjectType: FOCUS_SESSION_SUBJECT_TYPE,
        source: "api",
      }
    );
  } catch (err) {
    logger.warn(
      { err, sessionId: p.sessionId },
      "relay withdraw: the history row failed — the withdraw stands"
    );
  }
  return {
    status: "withdrawn",
    questionId,
    expectedLabel,
    handedBack,
  };
}

// ── The person's "Not what I said" ──────────────────────────────────────────

export type CorrectRelayedAnswerResult =
  | { status: "not_found" | "unknown_label" | "already_done" | "retired" }
  /** Nothing relayed to correct: no pending relay, no unconfirmed relay. */
  | { status: "no_relayed_answer" }
  /** The session ended: its questions are closed and stay closed. */
  | { status: "session_ended" }
  | {
      status: "corrected";
      /** What was dropped: a relay waiting for the tap, or a relayed answer. */
      dropped: "pending" | "answer";
      expectedLabel: string | null;
      questionId: string | null;
      relayedBy: string;
      /** The question is the person's again (the slot is owed to them). */
      reopened: boolean;
      /**
       * The decision the dropped answer had decided, back to `proposed` with
       * the relay's words and the pick removed. `failed` is said, never
       * hidden: the correction stands, the decision still reads decided.
       */
      decision?:
        | { status: "reopened"; decisionId: string }
        | { status: "failed"; decisionId: string; reason: string };
    };

/**
 * Drop the waiting relay from EVERY open question of the room about `label`
 * — not only the newest: a later question about the same slot must not leave
 * the stamped one carrying a relay nobody can confirm. Returns the ids
 * touched.
 */
export async function dropPendingRelayStamps(
  channelId: string,
  label: string
): Promise<string[]> {
  const rows = await db
    .select({ id: messages.id, metadata: messages.metadata })
    .from(messages)
    .where(
      and(
        eq(messages.channelId, channelId),
        eq(messages.authorType, MessageAuthorType.AI_AGENT),
        drizzleSql`(${messages.metadata}->${ROOM_POST_META_KEY}) ? 'pendingRelay'`
      )
    );
  const wanted = normalizeExpectedLabel(label);
  const ids = rows
    .filter(
      (r) => normalizeExpectedLabel(readRoomPostMeta(r.metadata)?.slotLabel) === wanted
    )
    .map((r) => r.id);
  const dropped: string[] = [];
  for (const id of ids) {
    if (await dropRelayedQuestionStamp(id, "pendingRelay")) dropped.push(id);
  }
  return dropped;
}

/**
 * The ask a relayed answer was given to, rebuilt from its snapshot, to pose
 * it again. A confirm and a choose come back whole (minus `allowOther`); a
 * form / provide / act snapshot does not keep its fields, so the slot is
 * re-asked in words. Pure.
 */
export function askFromSnapshot(
  snapshot: SlotAskSnapshot | undefined
): SlotAsk | null {
  if (!snapshot) return null;
  const lookedAt = snapshot.lookedAt?.length
    ? { lookedAt: snapshot.lookedAt.map((r) => ({ ...r })) }
    : {};
  if (snapshot.mode === "confirm") {
    return {
      mode: "confirm",
      ...(snapshot.prompt ? { prompt: snapshot.prompt } : {}),
      ...lookedAt,
    };
  }
  if (snapshot.mode === "choose" && snapshot.options?.length) {
    return {
      mode: "choose",
      options: snapshot.options.map((o) => ({ ...o })),
      ...lookedAt,
    };
  }
  return null;
}

/**
 * "NOT WHAT I SAID" — the person's correction of an answer an agent relayed.
 * Reached from the person's answer doors (`rejectRelayed`), addressing the
 * slot (`expectedLabel`) or a slotless room question (`questionId`).
 *
 *   - a relay WAITING for the tap (`pendingRelay`) is dropped from the slot
 *     and its question; the slot was never handed back and stays owed;
 *   - a ROUTINE relay already recorded (`via: 'relayed'`, never confirmed) is
 *     undone: the slot's answer is archived to `answerHistory` and the slot is
 *     the person's again with its ask re-posed (`stampBlocked`, the one
 *     re-ask); the room question's answer stamp is dropped, so it is open.
 *     The decision the relay decided goes back to `proposed`, its pick and
 *     the relay's words removed; the next answer decides it (the slot keeps
 *     `decisionId`).
 * A tap — including a confirmed relay — is never undone here, and an ENDED
 * session is never re-asked (`session_ended`).
 *
 * ONE event, `focus_session.relay_corrected.completed`, naming the relaying
 * agent (`relayedBy`): the count a scorecard reads.
 */
export async function correctRelayedAnswer(p: {
  sessionId: string;
  /** Owner floor AND the correcting person. */
  userId: string;
  expectedLabel?: string;
  questionId?: string;
  now?: Date;
}): Promise<CorrectRelayedAnswerResult> {
  const session = await db.query.focusSessions.findFirst({
    where: and(
      eq(focusSessions.id, p.sessionId),
      eq(focusSessions.userId, p.userId)
    ),
    columns: {
      id: true,
      channelId: true,
      expectedOutputs: true,
      workspaceId: true,
      status: true,
    },
  });
  if (!session) return { status: "not_found" };
  // The close stamped its questions closed and retired its asks; re-asking
  // one now would make an ended session ask again, with nobody to go on.
  if (isTerminalSessionStatus(session.status)) {
    return { status: "session_ended" };
  }
  const now = p.now ?? new Date();

  let result: CorrectRelayedAnswerResult = { status: "no_relayed_answer" };
  let reopenDecisionId: string | null = null;
  if (p.expectedLabel?.trim()) {
    const outputs: ExpectedOutput[] = Array.isArray(session.expectedOutputs)
      ? (session.expectedOutputs as ExpectedOutput[])
      : [];
    const chosen = selectSlotToAnswer(outputs, p.expectedLabel);
    if ("refused" in chosen) return { status: chosen.refused };
    const label = outputs[chosen.index]!.label;
    const lock: {
      dropped?: {
        kind: "pending" | "answer";
        relayedBy: string;
        questionId: string | null;
        decisionId?: string;
      };
    } = {};
    await updateExpectedOutputsLocked(session.id, (current) => {
      const again = selectSlotToAnswer(current, label);
      if ("refused" in again) return null;
      const live = current[again.index]!;
      if (live.pendingRelay) {
        lock.dropped = {
          kind: "pending",
          relayedBy: live.pendingRelay.relayedBy,
          questionId: null,
        };
        const { pendingRelay: _dropped, ...rest } = live;
        return current.map((o, i) => (i === again.index ? rest : o));
      }
      const answer = live.answer;
      if (answer?.via === "relayed" && answer.relayedBy && !answer.confirmedAt) {
        lock.dropped = {
          kind: "answer",
          relayedBy: answer.relayedBy,
          questionId: answer.messageId,
          ...(live.decisionId ? { decisionId: live.decisionId } : {}),
        };
        // The one re-ask: archives the answer, hands the slot to the person.
        // No push: they are the one who just said "Not what I said".
        return stampBlocked(
          current,
          live.label,
          live.blockedReason ?? "decision",
          answer.question ?? live.why ?? null,
          now,
          undefined,
          live.ask ?? askFromSnapshot(answer.askSnapshot)
        );
      }
      return null;
    });
    const hit = lock.dropped;
    if (!hit) return { status: "no_relayed_answer" };
    // The room half of the same stamp.
    let questionId: string | null = null;
    if (session.channelId) {
      if (hit.kind === "pending") {
        questionId =
          (await dropPendingRelayStamps(session.channelId, label))[0] ?? null;
      } else if (
        hit.questionId &&
        (await dropRelayedQuestionStamp(hit.questionId, "answer"))
      ) {
        questionId = hit.questionId;
      }
    }
    reopenDecisionId = hit.decisionId ?? null;
    result = {
      status: "corrected",
      dropped: hit.kind,
      expectedLabel: label,
      questionId,
      relayedBy: hit.relayedBy,
      reopened: true,
    };
  } else if (p.questionId && session.channelId) {
    const found = await findRoomQuestion(session.channelId, p.questionId);
    const answer = found?.meta.answer;
    if (
      !found ||
      found.slotLabel ||
      answer?.via !== "relayed" ||
      !answer.relayedBy ||
      answer.confirmedAt
    ) {
      // A question that names a slot is corrected through its slot.
      return found?.slotLabel
        ? correctRelayedAnswer({ ...p, expectedLabel: found.slotLabel })
        : { status: "no_relayed_answer" };
    }
    if (!(await dropRelayedQuestionStamp(found.id, "answer"))) {
      return { status: "no_relayed_answer" };
    }
    result = {
      status: "corrected",
      dropped: "answer",
      expectedLabel: null,
      questionId: found.id,
      relayedBy: answer.relayedBy,
      reopened: true,
    };
  }
  if (result.status !== "corrected") return result;

  // The relay decided the slot's decision; the person said it did not. Back
  // to undecided, through the decision door, until their own answer decides it.
  if (reopenDecisionId) {
    try {
      const { updateDecisionEntity } =
        await import("../decisions/decision-entity-door.js");
      const { decisionReopenedFromRelay } =
        await import("../decisions/decision-from-answer.js");
      const reopen = decisionReopenedFromRelay();
      await updateDecisionEntity(
        {
          userId: p.userId,
          workspaceId: session.workspaceId ?? null,
          sessionId: session.id,
        },
        reopenDecisionId,
        reopen.properties,
        reopen.deleteProperties
      );
      result = {
        ...result,
        decision: { status: "reopened", decisionId: reopenDecisionId },
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error(
        { err, sessionId: session.id, decisionId: reopenDecisionId },
        "relay correction: re-opening the decision the relay decided FAILED — it still reads decided"
      );
      result = {
        ...result,
        decision: { status: "failed", decisionId: reopenDecisionId, reason },
      };
    }
  }

  const data = {
    sessionId: session.id,
    expectedLabel: result.expectedLabel,
    questionId: result.questionId,
    dropped: result.dropped,
    relayedBy: result.relayedBy,
    correctedAt: now.toISOString(),
  };
  try {
    await logEvent(p.userId, FOCUS_SESSION_RELAY_CORRECTED_EVENT_TYPE, data, {
      subjectId: session.id,
      subjectType: FOCUS_SESSION_SUBJECT_TYPE,
      source: "api",
    });
    await emitSideEffects({
      subjectType: FOCUS_SESSION_SUBJECT_TYPE,
      action: FOCUS_SESSION_RELAY_CORRECT_ACTION,
      subjectId: session.id,
      userId: p.userId,
      workspaceId: session.workspaceId ?? undefined,
      sessionId: session.id,
      data,
    });
  } catch (err) {
    logger.warn(
      { err, sessionId: session.id },
      "relay correction: the history row / reactor hop failed — the correction stands"
    );
  }
  return result;
}

/**
 * The ONE wording of a relay refusal, for both relay doors (MCP
 * `synap_relay_answer`, Hub `POST /focus-sessions/:id/answers/relay`). Each
 * sentence tells the agent what to do instead.
 */
export function describeRelayRefusal(
  result: Exclude<
    RelaySessionAnswerResult,
    { status: "relayed" | "awaiting_tap" | "withdrawn" }
  >,
  p: { sessionId: string; slotLabel?: string | null }
): { code: "NOT_FOUND" | "BAD_REQUEST" | "CONFLICT" | "FORBIDDEN"; message: string } {
  switch (result.status) {
    case "address_required":
      return {
        code: "BAD_REQUEST",
        message:
          "Name the question you relay: `messageId` (your room question) or `slotLabel`.",
      };
    case "no_such_question":
      return {
        code: "NOT_FOUND",
        message: "No agent question with that `messageId` in this session's room.",
      };
    case "not_open":
      return {
        code: "CONFLICT",
        message:
          "That question is no longer open: it was answered, withdrawn, closed, or already waits for the person's tap.",
      };
    case "label_mismatch":
      return {
        code: "BAD_REQUEST",
        message: "`slotLabel` is not the slot that question is about.",
      };
    case "not_yours":
      return {
        code: "FORBIDDEN",
        message:
          "Only the agent that asked a question may relay its answer (a slot with no room question: an agent on the session).",
      };
    case "quote_required":
      return {
        code: "BAD_REQUEST",
        message:
          "`quote` is required: the person's own words, verbatim — never a paraphrase.",
      };
    case "note_required":
      return {
        code: "BAD_REQUEST",
        message: "`note` is required: one line saying why the question is withdrawn.",
      };
    case "forbidden":
      return { code: "FORBIDDEN", message: result.reason };
    case "persons_step":
      return {
        code: "CONFLICT",
        message:
          "This question is a step only the person may take (a commitment, an approval, a grade or a secret), so it cannot be withdrawn. Leave it with them; if your work no longer needs it, say so in the room.",
      };
    default:
      return describeAnswerRefusal(result, p.slotLabel ?? "", p.sessionId);
  }
}
