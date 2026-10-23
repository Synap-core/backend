/**
 * resolveSessionPost — the ONE codec behind a COORDINATION POST: one agent's
 * typed message to another session (`intent`: blocked_on_you | handoff | done
 * | fyi). Every write door that takes `intent` (MCP `synap_post_message`, Hub
 * `POST /threads/:id/messages`) calls this and hands the result to the insert;
 * no door builds the stamp itself. The stamp's shape and its reader live in
 * `@synap-core/types/agents` (session-post), so the readers (the change feed's
 * `session_message`, the continuation packet's `inbox`) cannot drift from it.
 *
 * What it decides, server-side only:
 *   - THE TARGET: `toSessionId` (owner-floored, like every session read) → its
 *     room (`ensureSessionChannel`), or the session whose room `channelId` is
 *     (`resolveRoomSession`). Both given ⇒ they must agree. A teammate's
 *     session is NOT_FOUND: v1 reaches the owner's own sessions only.
 *   - THE SENDER: an explicit `fromSessionId` the caller owns (one it does not
 *     own is REFUSED, never dropped), else the session bound to the request's
 *     client (`findClientSession` on the request client key). Never the
 *     "single unclaimed session" guess: a reply address that is a guess is
 *     worse than none. Never read from the body otherwise. Harness and
 *     conversation come from the client key the door verified.
 *   - THE WAKE (plan §2 guards), stamped ONCE here so every reader agrees:
 *       · only `blocked_on_you` and `handoff` may wake (`done`/`fyi` never);
 *       · LOOP GUARD — a post made in a turn a coordination post started
 *         names it as `cause`; `hop` = the cause's hop + 1, and a post past
 *         {@link SESSION_POST_MAX_WAKE_HOP} is delivered with `wake: false`
 *         (`wakeHeld: hop_limit`). So A→B wakes B, B's reply to A may wake A,
 *         and A's reply to that never wakes B;
 *       · RATE GUARD — at most {@link SESSION_POST_WAKE_LIMIT} waking posts
 *         per (sender session, target session) per
 *         {@link SESSION_POST_WAKE_WINDOW_MINUTES} minutes; the next is
 *         delivered with `wake: false` (`wakeHeld: rate_limited`) and the
 *         sender's reply says so. Stated limit: two posts racing inside one
 *         millisecond can both see the count below the cap — the guard bounds
 *         loops, which are sequential, not a burst of parallel calls.
 *   A held wake is still DELIVERED: the post lands in the room, the feed and
 *   the inbox. Only the doorbell is off.
 *
 * A message is the NOTE, never the state, and never pushes the person's phone
 * (`notify-room-post.ts`) nor starts a pod-agent turn (it is never `triggerAI`).
 */

import { TRPCError } from "@trpc/server";
import {
  db,
  channels,
  focusSessions,
  messages,
  and,
  eq,
  inArray,
  isNull,
  drizzleSql,
  findClientSession,
  getRequestClientKey,
} from "@synap/database";
import { isLikelyUUID } from "@synap-core/types/proposals";
import {
  SESSION_POST_INTENTS,
  SESSION_POST_META_KEY,
  SESSION_POST_REF_KINDS,
  SESSION_POST_REFS_MAX,
  isSessionPostIntent,
  isWakeWorthySessionPostIntent,
  readSessionPost,
  type SessionPostIntent,
  type SessionPostMeta,
  type SessionPostRef,
  type SessionPostRefKind,
} from "@synap-core/types/agents";
import { sessionReadableWhere } from "../../access/session-visibility.js";
import { channelVisibilityWhere } from "../../utils/channel-visibility.js";
import { ensureSessionChannel } from "../focus-sessions/ensure-session-channel.js";
import { requestClientKey } from "../focus-sessions/resolve-work-session.js";
import { parseRunnerClientKey } from "../focus-sessions/session-runners.js";
import { resolveRoomSession } from "./room-session.js";

/** Waking posts per (sender, target) session pair inside the window. */
export const SESSION_POST_WAKE_LIMIT = 3;
export const SESSION_POST_WAKE_WINDOW_MINUTES = 10;
/** The deepest wake chain: a reply to a wake may wake, a reply to that may not. */
export const SESSION_POST_MAX_WAKE_HOP = 1;

export interface SessionPostInput {
  /** The authenticated owner (an agent key's operator). */
  userId: string;
  /** The verified agent principal; a coordination post is an agent's. */
  agentUserId: string | undefined;
  intent: unknown;
  toSessionId?: unknown;
  /** The room the door was asked to post into, when it was. */
  channelId?: unknown;
  fromSessionId?: unknown;
  refs?: unknown;
  cause?: unknown;
}

export interface ResolvedSessionPost {
  /** Where the post goes: the target session's room. */
  channelId: string;
  meta: SessionPostMeta;
}

const bad = (message: string) =>
  new TRPCError({ code: "BAD_REQUEST", message });

function optionalUuid(raw: unknown, field: string): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string" || !isLikelyUUID(raw.trim())) {
    throw bad(
      field === "cause"
        ? "cause must be a message id (the feed event id)."
        : `${field} must be an id (UUID).`
    );
  }
  return raw.trim();
}

function parseRefs(raw: unknown): SessionPostRef[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw bad("refs must be a list of {kind, id, label?}.");
  }
  if (raw.length > SESSION_POST_REFS_MAX) {
    throw bad(`refs takes at most ${SESSION_POST_REFS_MAX} entries.`);
  }
  return raw.map((r, i) => {
    const ref = (r ?? {}) as Record<string, unknown>;
    if (!(SESSION_POST_REF_KINDS as readonly unknown[]).includes(ref.kind)) {
      throw bad(
        `refs[${i}].kind must be one of ${SESSION_POST_REF_KINDS.join(", ")}.`
      );
    }
    if (typeof ref.id !== "string" || !isLikelyUUID(ref.id.trim())) {
      throw bad(`refs[${i}].id must be an id (UUID).`);
    }
    const label =
      typeof ref.label === "string" && ref.label.trim()
        ? ref.label.trim().slice(0, 500)
        : undefined;
    return {
      kind: ref.kind as SessionPostRefKind,
      id: ref.id.trim(),
      ...(label ? { label } : {}),
    };
  });
}

/** The target session + its room, under the owner floor. */
async function resolveTarget(
  userId: string,
  toSessionId: string | undefined,
  channelId: string | undefined
): Promise<{ sessionId: string; channelId: string }> {
  if (toSessionId) {
    const [target] = await db
      .select({
        id: focusSessions.id,
        workspaceId: focusSessions.workspaceId,
        goal: focusSessions.goal,
      })
      .from(focusSessions)
      .where(
        and(eq(focusSessions.id, toSessionId), sessionReadableWhere({ userId }))
      )
      .limit(1);
    if (!target) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `Session ${toSessionId} not found.`,
      });
    }
    const room = await ensureSessionChannel({
      sessionId: target.id,
      userId,
      workspaceId: target.workspaceId,
      goal: target.goal,
    });
    if (!room) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `Session ${toSessionId} not found.`,
      });
    }
    if (channelId && channelId !== room) {
      throw bad(
        "channelId is not that session's room — pass toSessionId alone."
      );
    }
    return { sessionId: target.id, channelId: room };
  }
  if (!channelId) {
    throw bad("A coordination post needs toSessionId (the session it is for).");
  }
  const room = await resolveRoomSession(channelId);
  if (!room || room.userId !== userId) {
    throw bad(
      "This room belongs to none of your sessions — pass toSessionId (the session the message is for)."
    );
  }
  return { sessionId: room.id, channelId };
}

/** The sender's own session: explicit (owned) › this client's bound one › none. */
async function resolveSender(
  userId: string,
  agentUserId: string,
  fromSessionId: string | undefined
): Promise<string | null> {
  if (fromSessionId) {
    const [owned] = await db
      .select({ id: focusSessions.id })
      .from(focusSessions)
      .where(
        and(
          eq(focusSessions.id, fromSessionId),
          eq(focusSessions.userId, userId)
        )
      )
      .limit(1);
    if (!owned) {
      throw bad(
        `fromSessionId ${fromSessionId} is not one of your sessions — pass the session you are working in, or omit it.`
      );
    }
    return owned.id;
  }
  const clientKey = requestClientKey(agentUserId);
  if (!clientKey) return null;
  // A failed lookup THROWS (the post fails, the caller retries): "this client
  // has no session" and "could not look" are different facts.
  const bound = await findClientSession(userId, clientKey);
  return bound?.id ?? null;
}

/** The coordination post the sender is replying to, and its hop. */
async function readCause(
  userId: string,
  cause: string,
  fromSessionId: string | null
): Promise<number> {
  const [row] = await db
    .select({ metadata: messages.metadata })
    .from(messages)
    .where(
      and(
        eq(messages.id, cause),
        isNull(messages.deletedAt),
        inArray(
          messages.channelId,
          db
            .select({ id: channels.id })
            .from(channels)
            .where(channelVisibilityWhere(userId))
        )
      )
    )
    .limit(1);
  const meta = row ? readSessionPost(row.metadata) : null;
  if (!meta) {
    throw bad(
      "cause must be the id of a session_message you received (the feed event id)."
    );
  }
  if (fromSessionId && meta.to.sessionId !== fromSessionId) {
    throw bad("cause was not addressed to your session.");
  }
  return meta.hop + 1;
}

/** Waking posts already sent on this pair inside the window. */
async function countRecentWakes(p: {
  channelId: string;
  toSessionId: string;
  fromSessionId: string | null;
  agentUserId: string;
}): Promise<number> {
  const post = drizzleSql`${messages.metadata}->${SESSION_POST_META_KEY}`;
  // A sender bound to no session is keyed by its agent principal instead.
  const sender = p.fromSessionId
    ? drizzleSql`${post}->'from'->>'sessionId' = ${p.fromSessionId}`
    : drizzleSql`(${post}->'from'->>'sessionId') IS NULL AND ${post}->'from'->>'agentUserId' = ${p.agentUserId}`;
  const [row] = await db
    .select({ n: drizzleSql<number>`count(*)::int` })
    .from(messages)
    .where(
      and(
        // Every post to the target lands in its room: the (channel, timestamp)
        // index bounds the scan to one room's last ten minutes.
        eq(messages.channelId, p.channelId),
        drizzleSql`${messages.timestamp} > now() - (${SESSION_POST_WAKE_WINDOW_MINUTES}::int * interval '1 minute')`,
        isNull(messages.deletedAt),
        drizzleSql`${post}->'to'->>'sessionId' = ${p.toSessionId}`,
        drizzleSql`(${post}->>'wake')::boolean IS TRUE`,
        sender
      )
    );
  return Number(row?.n ?? 0);
}

export async function resolveSessionPost(
  input: SessionPostInput
): Promise<ResolvedSessionPost> {
  if (!input.agentUserId) {
    throw bad(
      "intent is for an agent's message to another session; a person's post has none."
    );
  }
  if (
    input.intent !== undefined &&
    input.intent !== null &&
    !isSessionPostIntent(input.intent)
  ) {
    throw bad(`intent must be one of ${SESSION_POST_INTENTS.join(", ")}.`);
  }
  const intent: SessionPostIntent = isSessionPostIntent(input.intent)
    ? input.intent
    : "fyi";
  const toSessionId = optionalUuid(input.toSessionId, "toSessionId");
  const channelId = optionalUuid(input.channelId, "channelId");
  const fromSessionIdArg = optionalUuid(input.fromSessionId, "fromSessionId");
  const refs = parseRefs(input.refs);
  const cause = optionalUuid(input.cause, "cause");

  const target = await resolveTarget(input.userId, toSessionId, channelId);
  const fromSessionId = await resolveSender(
    input.userId,
    input.agentUserId,
    fromSessionIdArg
  );
  if (fromSessionId === target.sessionId) {
    throw bad(
      "That is your own session — post to its room with channelId and no intent."
    );
  }
  const hop = cause ? await readCause(input.userId, cause, fromSessionId) : 0;

  let wake = false;
  let wakeHeld: SessionPostMeta["wakeHeld"];
  if (isWakeWorthySessionPostIntent(intent)) {
    if (hop > SESSION_POST_MAX_WAKE_HOP) {
      wakeHeld = "hop_limit";
    } else if (
      (await countRecentWakes({
        channelId: target.channelId,
        toSessionId: target.sessionId,
        fromSessionId,
        agentUserId: input.agentUserId,
      })) >= SESSION_POST_WAKE_LIMIT
    ) {
      wakeHeld = "rate_limited";
    } else {
      wake = true;
    }
  }

  const runner = parseRunnerClientKey(getRequestClientKey());
  return {
    channelId: target.channelId,
    meta: {
      intent,
      from: {
        sessionId: fromSessionId,
        agentUserId: input.agentUserId,
        harness: runner?.harness ?? null,
        conversationId: runner?.conversationId ?? null,
      },
      to: { sessionId: target.sessionId },
      ...(refs.length ? { refs } : {}),
      ...(cause ? { cause } : {}),
      hop,
      wake,
      ...(wakeHeld ? { wakeHeld } : {}),
    },
  };
}

/**
 * The sentence a sender's reply carries when its wake-worthy post was
 * delivered WITHOUT waking anyone — `undefined` when nothing was held.
 */
export function sessionPostDeliveryNote(
  meta: SessionPostMeta
): string | undefined {
  if (meta.wakeHeld === "rate_limited") {
    return `Delivered without waking that session: ${SESSION_POST_WAKE_LIMIT} messages already woke it from yours in the last ${SESSION_POST_WAKE_WINDOW_MINUTES} minutes. It reads this in its inbox at its next turn.`;
  }
  if (meta.wakeHeld === "hop_limit") {
    return "Delivered without waking that session: this answers a message that itself answered a wake, and a reply chain wakes at most once. It reads this in its inbox at its next turn.";
  }
  return undefined;
}
