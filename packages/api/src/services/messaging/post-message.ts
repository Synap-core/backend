/**
 * postChannelMessage — shared service behind the MCP `synap_post_message` tool.
 *
 * Inserts a single message into a channel and, when `triggerAI` is set, emits a
 * CHAT_MESSAGE realtime event flagged to trigger an AI reply. Extracted verbatim
 * from the MCP adapter so the tool handler does ZERO direct DB work. (The Hub
 * REST `POST /threads/:id/messages` path uses a different hash input + pg-boss
 * autoRespond trigger, so it is intentionally NOT unified here.)
 *
 * ACKNOWLEDGMENT INTEGRITY (C1): a client-perceived failure while the insert LANDED
 * makes an agent re-emit the same post → a duplicate line, and — worse — a SECOND
 * agent turn. Two idempotency modes close this (see `write-door-idempotency.ts`):
 *   - EXPLICIT `idempotencyKey` → the message id is derived from it, so a retry
 *     collapses on the PRIMARY KEY (`ON CONFLICT DO NOTHING`). Caller-owned,
 *     window-less.
 *   - NO key → a short-window CONTENT-equality lookup ((channel, role, content,
 *     user) within `MESSAGE_DEDUP_WINDOW_MS`) catches the fast retry. Deliberately
 *     NARROW: identical message TEXT is a legitimate recurring event (an agent may
 *     honestly post "Done." twice), so this is a tight-window retry guard, NOT a
 *     forever content-hash. The window is why a legit repeat next hour is untouched.
 * On a duplicate hit the AI turn is NOT re-triggered (at-most-once external effect).
 * Both lookups are best-effort — a lookup hiccup degrades to a normal insert.
 *
 * TRIGGER-AI EXEMPTION: a post that TURNS THE AI ON (`triggerAI`) SKIPS the no-key
 * content lookup. Content-dedup cannot tell a landed-but-un-acked retry from a
 * genuinely-distinct turn (two "yes" answers to two agent questions inside the
 * window), and silently dropping a real turn is the worse, un-mitigable harm. Retry
 * safety for a triggering post therefore lives ONLY on the explicit `idempotencyKey`
 * path — a caller that needs at-most-once turn semantics passes a key.
 */

import { randomUUID } from "crypto";
import {
  db,
  messages,
  MessageRole,
  MessageAuthorType,
  RoutedSource,
  computeMessageHash,
  emitMessageEvent,
  and,
  eq,
  isNull,
  desc,
  drizzleSql,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import {
  type WriteAckState,
  deterministicUuidFromKey,
  idempotencyWindowSeconds,
} from "../../utils/write-door-idempotency.js";

const logger = createLogger({ module: "post-message" });

/**
 * Retry window for the no-explicit-key content dedup. Short on purpose: a "failed"
 * call is retried within seconds, while a genuinely-repeated identical message
 * arrives much later — so a narrow window catches the retry without collapsing a
 * legitimate repeat.
 */
export const MESSAGE_DEDUP_WINDOW_MS = 90 * 1000; // 90 seconds

export interface PostChannelMessageParams {
  channelId: string;
  content: string;
  /** "user" | "system" | anything else → assistant. */
  role?: string;
  triggerAI?: boolean;
  userId: string;
  /**
   * Optional caller-supplied idempotency key. When present, the message id is
   * derived from it so a retry collapses on the primary key (window-less). When
   * absent, a short-window content-equality dedup guards fast retries.
   */
  idempotencyKey?: string;
  /**
   * The acting AGENT's principal, when an agent key authored this post.
   *
   * `userId` is always the HUMAN owner — `api-key-auth.ts` remaps an agent key
   * to its owner — so without this, two agents posting into one channel produce
   * byte-identical rows and a reader cannot attribute either. Mirrors the
   * established door `rest/entities.ts:1027`. Absent ⇒ a human wrote it.
   */
  agentUserId?: string;
  /**
   * ⚠️ NOT written to `messages.sessionId`. That column FKs to `sessions` (the
   * channel-scoped conversation-memory session), whereas `X-Session-Id` carries
   * a FOCUS session id — writing one into the other violates the FK and 500s the
   * post. A focus session owns its channel (`focus_sessions.channelId`), so the
   * linkage already exists through the channel. Kept only so callers may pass it
   * without error; it is deliberately unused.
   */
  sessionId?: string | null;
}

export interface PostChannelMessageResult {
  success: true;
  messageId: string;
  channelId: string;
  /** applied = inserted now; duplicate-ignored = idempotent replay of a prior post. */
  ackState: WriteAckState;
  /** Present on a duplicate hit — the prior message id (same as `messageId`). */
  priorMessageId?: string;
}

/** Build a duplicate-ignored receipt for a prior message id (pure — no I/O). */
function duplicateReceipt(
  msgId: string,
  channelId: string
): PostChannelMessageResult {
  return {
    success: true,
    messageId: msgId,
    channelId,
    ackState: "duplicate-ignored",
    priorMessageId: msgId,
  };
}

export async function postChannelMessage(
  params: PostChannelMessageParams
): Promise<PostChannelMessageResult> {
  const { channelId, content, userId, agentUserId } = params;
  const role = params.role || "assistant";
  const triggerAI = Boolean(params.triggerAI);
  const roleEnum =
    role === "user"
      ? MessageRole.USER
      : role === "system"
        ? MessageRole.SYSTEM
        : MessageRole.ASSISTANT;

  const explicitKey =
    typeof params.idempotencyKey === "string" && params.idempotencyKey.trim()
      ? params.idempotencyKey.trim()
      : undefined;

  // ── Idempotency: resolve the message id + detect a prior write ──────────────
  // Explicit key → deterministic id (PK-level idempotency). No key → best-effort
  // short-window content lookup. A lookup failure must never block a real insert.
  let msgId: string;
  if (explicitKey) {
    msgId = deterministicUuidFromKey(
      `post_message:${channelId}:${explicitKey}`
    );
  } else if (triggerAI) {
    // An AI-triggering post is a DELIBERATE invocation, not an accidental retry
    // — never suppress it as a content-duplicate (a same-text message that turns
    // the AI on would otherwise be swallowed and the turn dropped). Explicit-key
    // idempotency still applies above; only the content-window guard is skipped.
    msgId = randomUUID();
  } else {
    msgId = randomUUID();
    try {
      const [prior] = await db
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.channelId, channelId),
            eq(messages.userId, userId),
            eq(messages.role, roleEnum),
            eq(messages.content, content),
            isNull(messages.deletedAt),
            // In-DB cutoff — a bound JS Date crashes postgres.js 3.4.8 on the pod
            // image, and this lookup is best-effort so that would silently degrade
            // to a duplicate insert. Compute the window in SQL instead.
            drizzleSql`${messages.timestamp} >= now() - (${idempotencyWindowSeconds(MESSAGE_DEDUP_WINDOW_MS)}::int * interval '1 second')`
          )
        )
        .orderBy(desc(messages.timestamp))
        .limit(1);
      if (prior) return duplicateReceipt(prior.id, channelId);
    } catch (err) {
      // Best-effort — degrade to a normal insert rather than block a real write.
      logger.warn(
        { err, channelId },
        "message dedup lookup failed — inserting"
      );
    }
  }

  const hash = computeMessageHash(msgId, content);

  // Insert. For the explicit-key path, ON CONFLICT DO NOTHING makes the retry a
  // no-op; an empty `returning` means the row already existed → duplicate-ignored.
  const inserted = await db
    .insert(messages)
    .values({
      id: msgId,
      channelId,
      role: roleEnum,
      content,
      userId,
      // See `agentUserId` on the params type: without this an agent post is
      // indistinguishable from its owner's. Hash-safe — `computeMessageHash`
      // covers (id, content, previousHash) only.
      authorType: agentUserId
        ? MessageAuthorType.AI_AGENT
        : MessageAuthorType.HUMAN,
      // `routedSource` must accompany `routedTeammateId` — the UI resolver
      // (`@synap-core/channels` room-adapters/message.ts:92) requires BOTH or it
      // renders no attribution at all. DIRECT = this agent posted on its own
      // behalf (not orchestrator-routed, not mention-summoned).
      ...(agentUserId
        ? {
            routedTeammateId: agentUserId,
            routedSource: RoutedSource.DIRECT,
          }
        : {}),
      hash,
      previousHash: "",
    })
    .onConflictDoNothing({ target: messages.id })
    .returning({ id: messages.id });

  if (inserted.length === 0) {
    // Explicit-key retry (or a concurrent double-insert of the same derived id):
    // the prior write is authoritative, and its AI turn already fired — do NOT
    // re-trigger (at-most-once external effect).
    return duplicateReceipt(msgId, channelId);
  }

  // Keystone fact write: append `message.sent` to the `events` log — reached
  // ONLY when a NEW row landed (the conflict/no-op path returned above). This is
  // the MCP/programmatic post door (`synap_post_message`), so agent/API posts
  // become facts too. No entityId lookup here (honest absence over a per-post
  // query); the channel is the subject.
  await emitMessageEvent({
    type: "message.sent",
    userId,
    channelId,
    messageId: msgId,
    data: { role },
  });

  if (triggerAI) {
    const { emitChatEvent } =
      await import("../../utils/chat-realtime-broadcast.js");
    const { EventNames } = await import("@synap-core/types/events");
    emitChatEvent({
      event: EventNames.CHAT_MESSAGE,
      data: {
        threadId: channelId,
        message: {
          id: msgId,
          threadId: channelId,
          role: roleEnum,
          content,
          userId,
          timestamp: new Date(),
          previousHash: "",
          hash,
        },
        userId,
      },
      workspaceId: null,
      userId,
    });

    // The socket emit above is a UI hint only — no consumer turns it into an IS
    // reply. Fire the canonical one-path kickoff so a real headless turn is
    // produced. The helper gates to THREAD/AGENT_COLLAB channels with a
    // workspaceId (other channel types are a no-op today).
    //
    // ROLE GATE: only a USER message may kick off an agent turn. Mirrors the Hub
    // REST door (`hub-protocol/rest/threads.ts` postMessage: `autoRespond ===
    // true && role === "user"`). Without it, `{ role: "assistant", triggerAI:
    // true }` — reachable straight from the MCP `synap_post_message` tool, which
    // exposes both fields — makes an agent respond to an assistant message, i.e.
    // an agent can trigger a turn on its own (or another agent's) output.
    if (roleEnum === MessageRole.USER) {
      const { triggerAutoRespond } =
        await import("../../utils/trigger-auto-respond.js");
      await triggerAutoRespond({
        channelId,
        userMessageId: msgId,
        content,
        sourceUserId: userId,
      });
    }
  }

  return { success: true, messageId: msgId, channelId, ackState: "applied" };
}
