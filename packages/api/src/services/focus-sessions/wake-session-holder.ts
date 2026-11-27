/**
 * wakeSessionHolder — THE door that wakes whatever agent holds a session, for
 * a reason the pod knows. Generic: it knows sessions, agents and rooms, never
 * what the session works on. Its first caller is a hold that ASKED to wake on
 * its resume (`hold.wake`, `hold-resume-follow-up.ts`); any door that must
 * hand a session back to its agent calls it the same way.
 *
 * WHO holds the session: the rule the owner's free message already uses
 * (`session-answer.ts`): the first agent on the roster the pod can reach
 * (`resolveWakeTarget`), else the session's live Synap AI run
 * (`liveRunWakeTarget`). Then, by reach:
 *   - `pod`: one IS turn at the note (`wake` → `triggerAutoRespond`, the ONE
 *     turn door, with the live run's turn context);
 *   - `dispatch`: its binding's `send` (`wakeExternalAgent`, the ONE loop-back
 *     door), the note's words as a `message`;
 *   - an agent on a computer (`pull`): the note in its room IS its doorbell
 *     (its worker resumes a conversation on a room follow-up; its feed reads
 *     the room). Nothing else is sent.
 * Nobody: the session is not found, not `active` (closed, or paused again),
 * or no agent works it. Said back (`nobody` + why); nothing is posted.
 *
 * WHAT it is told: one note in the room, written by the pod. `reason` is the
 * pod's own line (what moved); `context` is what a person or an agent wrote
 * when it paused, passed FENCED as data (`fenceUntrustedData`), never as
 * instructions.
 *
 * AT MOST ONCE per operation: the note is posted under `idempotencyKey` (its
 * id derives from the key, `postedMessageIdFor`); a note already there means
 * this wake already happened (`already`), and nothing is woken twice.
 * BOUNDED: at most {@link SESSION_POST_WAKE_LIMIT} wakes of one session per
 * {@link SESSION_POST_WAKE_WINDOW_MINUTES} minutes (the cap coordination posts
 * use), taken atomically with the "still active" check
 * (`HOLDER_WAKE_META_KEY`); past it the wake is `held: rate_limited` and
 * nothing is posted, so two sessions that wait on each other cannot ping-pong
 * agent turns.
 *
 * A FAILED wake is a fact, never an empty result: `failed` with its message,
 * logged as an error (the dispatch door also says it in the room). It undoes
 * nothing: whatever woke the session (a resume) already stands.
 */

import {
  db,
  eq,
  and,
  inArray,
  drizzleSql,
  focusSessions,
  messages,
  users,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import {
  postChannelMessage,
  postedMessageIdFor,
} from "../messaging/post-message.js";
import {
  SESSION_POST_WAKE_LIMIT,
  SESSION_POST_WAKE_WINDOW_MINUTES,
} from "../messaging/session-post.js";
import { fenceUntrustedData } from "../agent-dispatch/binding-call.js";
import { wakeExternalAgent } from "../agent-dispatch/wake-external-agent.js";
import { ensureSessionChannel } from "./ensure-session-channel.js";
import {
  liveRunWakeTarget,
  resolveWakeTarget,
  wake,
  type WakeTarget,
} from "./session-answer.js";
import { HOLDER_WAKE_META_KEY } from "./session-metadata.js";

const logger = createLogger({ module: "wake-session-holder" });

export interface WakeSessionHolderInput {
  sessionId: string;
  /** Why it is woken: one line the POD wrote (e.g. what moved). */
  reason: string;
  /**
   * What a person or an agent wrote when the work stopped (what it waited on,
   * why). Passed fenced, as data; omitted when there is none.
   */
  context?: string | null;
  /** One operation: the same key never wakes twice. */
  idempotencyKey: string;
}

export type WakeSessionHolderResult =
  | {
      status: "woken";
      /** How the holder was reached: an IS turn, its binding, or its room. */
      reach: "pod" | "dispatch" | "pull";
      messageId: string;
    }
  /** This operation already woke it (a replay): nothing was sent again. */
  | { status: "already"; messageId: string }
  /** The dispatch send waits for a person's approval (governance). */
  | { status: "proposed"; messageId: string; reviewUrl: string }
  | {
      status: "nobody";
      why:
        | "session_not_found"
        | "session_not_active"
        | "no_agent"
        /** A dispatch agent with no live task in this session to send to. */
        | "no_live_task";
      messageId?: string;
    }
  | { status: "held"; why: "rate_limited" }
  | { status: "failed"; message: string; messageId?: string };

/**
 * Take one wake from the session's window, atomically, only while it is
 * `active`. `taken`, else why not (`not_active` | `rate_limited`).
 */
async function takeHolderWake(
  sessionId: string,
  now: Date
): Promise<"taken" | "not_active" | "rate_limited"> {
  const cutoff = new Date(
    now.getTime() - SESSION_POST_WAKE_WINDOW_MINUTES * 60_000
  ).toISOString();
  const since = drizzleSql`(${focusSessions.metadata} -> ${HOLDER_WAKE_META_KEY} ->> 'since')`;
  const count = drizzleSql`COALESCE((${focusSessions.metadata} -> ${HOLDER_WAKE_META_KEY} ->> 'count')::int, 0)`;
  const windowOpen = drizzleSql`(${since} IS NOT NULL AND ${since}::timestamptz > ${cutoff}::timestamptz)`;
  const rows = await db
    .update(focusSessions)
    .set({
      metadata: drizzleSql`COALESCE(${focusSessions.metadata}, '{}'::jsonb) || jsonb_build_object(${HOLDER_WAKE_META_KEY}::text, CASE WHEN ${windowOpen} THEN jsonb_build_object('since', ${since}, 'count', ${count} + 1) ELSE jsonb_build_object('since', ${now.toISOString()}::text, 'count', 1) END)`,
    })
    .where(
      and(
        eq(focusSessions.id, sessionId),
        eq(focusSessions.status, "active"),
        drizzleSql`(NOT ${windowOpen} OR ${count} < ${SESSION_POST_WAKE_LIMIT})`
      )
    )
    .returning({ id: focusSessions.id });
  if (rows.length > 0) return "taken";
  const [row] = await db
    .select({ status: focusSessions.status })
    .from(focusSessions)
    .where(eq(focusSessions.id, sessionId))
    .limit(1);
  return row?.status === "active" ? "rate_limited" : "not_active";
}

/** Any agent on the roster at all: a `pull` one is woken by the room note. */
async function hasRosterAgent(agentIds: readonly string[]): Promise<boolean> {
  if (agentIds.length === 0) return false;
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, [...agentIds]), eq(users.userType, "agent")))
    .limit(1);
  return Boolean(row);
}

/** The note the holder is woken with: the pod's reason, then the fenced context. */
export function holderWakeNote(
  reason: string,
  context?: string | null
): string {
  const said = context?.trim();
  return said
    ? `${reason.trim()}\n\n${fenceUntrustedData(said, "what was said when the work stopped")}`
    : reason.trim();
}

export async function wakeSessionHolder(
  input: WakeSessionHolderInput
): Promise<WakeSessionHolderResult> {
  const [session] = await db
    .select({
      id: focusSessions.id,
      userId: focusSessions.userId,
      status: focusSessions.status,
      agentIds: focusSessions.agentIds,
      metadata: focusSessions.metadata,
      workspaceId: focusSessions.workspaceId,
      goal: focusSessions.goal,
    })
    .from(focusSessions)
    .where(eq(focusSessions.id, input.sessionId))
    .limit(1);
  if (!session) return { status: "nobody", why: "session_not_found" };
  if (session.status !== "active") {
    return { status: "nobody", why: "session_not_active" };
  }

  const agentIds = session.agentIds ?? [];
  const target: WakeTarget | null =
    (await resolveWakeTarget({ agentIds })) ??
    (await liveRunWakeTarget(session.id, session.metadata));
  const reach = target?.reach ?? "pull";
  if (!target && !(await hasRosterAgent(agentIds))) {
    return { status: "nobody", why: "no_agent" };
  }

  const channelId = await ensureSessionChannel({
    sessionId: session.id,
    userId: session.userId,
    workspaceId: session.workspaceId,
    goal: session.goal,
  });
  if (!channelId) {
    return {
      status: "failed",
      message: `session ${session.id} has no room to wake its agent in`,
    };
  }

  // A replay of this operation: the note is there, the wake happened.
  const messageId = postedMessageIdFor(channelId, input.idempotencyKey);
  const [prior] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);
  if (prior) return { status: "already", messageId };

  const taken = await takeHolderWake(session.id, new Date());
  if (taken === "not_active") {
    return { status: "nobody", why: "session_not_active" };
  }
  if (taken === "rate_limited") {
    logger.info(
      { sessionId: session.id, idempotencyKey: input.idempotencyKey },
      `holder not woken: ${SESSION_POST_WAKE_LIMIT} wakes already in the last ${SESSION_POST_WAKE_WINDOW_MINUTES} minutes`
    );
    return { status: "held", why: "rate_limited" };
  }

  const content = holderWakeNote(input.reason, input.context);
  const posted = await postChannelMessage({
    channelId,
    content,
    userId: session.userId,
    role: "system",
    idempotencyKey: input.idempotencyKey,
  });
  // Two deliveries racing past the read above: the one that inserted wakes.
  if (posted.ackState !== "applied") {
    return { status: "already", messageId: posted.messageId };
  }

  const failed = (message: string): WakeSessionHolderResult => {
    logger.error(
      { sessionId: session.id, reach, messageId: posted.messageId, message },
      "wakeSessionHolder: the agent holding the session was NOT woken"
    );
    return { status: "failed", message, messageId: posted.messageId };
  };

  if (!target) {
    // An agent on a computer: the note in its room is what wakes it.
    return { status: "woken", reach: "pull", messageId: posted.messageId };
  }
  if (target.reach === "dispatch") {
    const sent = await wakeExternalAgent({
      sessionId: session.id,
      agentUserId: target.agentUserId,
      kind: "message",
      text: content,
      idempotencyKey: `holder-wake:${input.idempotencyKey}`,
    });
    switch (sent.status) {
      case "sent":
        return {
          status: "woken",
          reach: "dispatch",
          messageId: posted.messageId,
        };
      case "proposed":
        return {
          status: "proposed",
          messageId: posted.messageId,
          reviewUrl: sent.reviewUrl,
        };
      case "not_dispatch":
        return {
          status: "nobody",
          why: "no_live_task",
          messageId: posted.messageId,
        };
      case "failed":
        return failed(sent.message);
    }
  }
  const queued = await wake({
    channelId,
    messageId: posted.messageId,
    content,
    ownerId: session.userId,
    sessionId: session.id,
    target,
    freeMessage: true,
  });
  return queued
    ? { status: "woken", reach: "pod", messageId: posted.messageId }
    : failed(
        `the ${target.agentType} turn could not be queued (room not eligible, or the Intelligence Service could not be resolved)`
      );
}
