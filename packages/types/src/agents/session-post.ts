/**
 * A COORDINATION POST — one agent's typed message to ANOTHER session (plan
 * "Agents working together" §1, A1). The pod stamps it on the message under
 * `messages.metadata[SESSION_POST_META_KEY]`; every reader (the change feed's
 * `session_message`, the continuation packet's `inbox`, a room renderer) reads
 * it back through {@link readSessionPost}, never by hand.
 *
 * SERVER-OWNED. Only the pod writes it, from the verified agent principal and
 * the sender session it derived itself; every client-metadata door strips a
 * copy a caller sent. It is separate from `roomPost.kind` (question/update),
 * which is about the PERSON: a coordination post is addressed to another
 * session's agent and never pushes the person's phone.
 *
 * A message is the NOTE, never the state: "blocked" is a `blocked_by` edge,
 * "done" is the session's close, a handoff is a slot delegation or an agent
 * attach. `refs` points at that object. A message never approves anything and
 * never writes a status.
 *
 * Pure and dependency-free: loaded by Node, Electron and React Native alike.
 */

/** What the sender wants the other session to know. */
export const SESSION_POST_INTENTS = [
  "blocked_on_you",
  "handoff",
  "done",
  "fyi",
] as const;
export type SessionPostIntent = (typeof SESSION_POST_INTENTS)[number];

/**
 * The intents that may WAKE the target's agent. `done` and `fyi` are
 * delivered (feed, inbox) but never wake anyone.
 */
export const WAKE_WORTHY_SESSION_POST_INTENTS = [
  "blocked_on_you",
  "handoff",
] as const satisfies ReadonlyArray<SessionPostIntent>;

export function isWakeWorthySessionPostIntent(
  intent: string | null | undefined
): boolean {
  return (WAKE_WORTHY_SESSION_POST_INTENTS as readonly string[]).includes(
    intent ?? ""
  );
}

export function isSessionPostIntent(
  value: unknown
): value is SessionPostIntent {
  return (
    typeof value === "string" &&
    (SESSION_POST_INTENTS as readonly string[]).includes(value)
  );
}

/** WHERE the stamp lives on a message's metadata. */
export const SESSION_POST_META_KEY = "sessionPost" as const;

/** What a `refs` entry may point at — the STATE behind the message. */
export const SESSION_POST_REF_KINDS = [
  "session",
  "slot",
  "proposal",
  "blocked_by",
] as const;
export type SessionPostRefKind = (typeof SESSION_POST_REF_KINDS)[number];

export interface SessionPostRef {
  kind: SessionPostRefKind;
  /** A session or proposal id; for `slot`, the session that declares it. */
  id: string;
  /** For `slot`: the slot's declared label. */
  label?: string;
}

/** Why the pod delivered a wake-worthy post WITHOUT waking anyone. */
export type SessionPostWakeHold = "hop_limit" | "rate_limited";

export interface SessionPostMeta {
  intent: SessionPostIntent;
  from: {
    /** The sender's own session; `null` = it is bound to none. */
    sessionId: string | null;
    agentUserId: string;
    /** `claude-code`, `codex`… when the client named its conversation. */
    harness: string | null;
    conversationId: string | null;
  };
  to: { sessionId: string };
  refs?: SessionPostRef[];
  /**
   * The coordination post whose delivery started the turn this post was made
   * in (its message id = the feed event id). Absent = not a reply to a wake.
   */
  cause?: string;
  /** Wake turns since an unprompted post: 0 without a cause, cause's hop + 1. */
  hop: number;
  /** Decided once, at the post: may this delivery wake the target's agent? */
  wake: boolean;
  /** Set when a wake-worthy intent was delivered with `wake: false`. */
  wakeHeld?: SessionPostWakeHold;
  /** Stamped once, by the target's agent reading it (the read receipt). */
  readAt?: string;
  readBy?: string;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

/**
 * Read the stamp off a message's metadata. Anything malformed reads as `null`
 * (not a coordination post) — a half-written stamp must never address a
 * session or wake one.
 */
export function readSessionPost(metadata: unknown): SessionPostMeta | null {
  if (!metadata || typeof metadata !== "object") return null;
  const raw = (metadata as Record<string, unknown>)[SESSION_POST_META_KEY];
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!isSessionPostIntent(r.intent)) return null;
  const from = r.from as Record<string, unknown> | undefined;
  const to = r.to as Record<string, unknown> | undefined;
  const agentUserId = str(from?.agentUserId);
  const toSessionId = str(to?.sessionId);
  if (!from || !agentUserId || !toSessionId) return null;
  const refs = Array.isArray(r.refs)
    ? r.refs.flatMap((x): SessionPostRef[] => {
        const ref = x as Record<string, unknown> | null;
        const id = str(ref?.id);
        if (
          !ref ||
          !id ||
          !(SESSION_POST_REF_KINDS as readonly unknown[]).includes(ref.kind)
        ) {
          return [];
        }
        const label = str(ref.label);
        return [
          {
            kind: ref.kind as SessionPostRefKind,
            id,
            ...(label ? { label } : {}),
          },
        ];
      })
    : [];
  const cause = str(r.cause);
  const readAt = str(r.readAt);
  const readBy = str(r.readBy);
  const hold = r.wakeHeld;
  return {
    intent: r.intent,
    from: {
      sessionId: str(from.sessionId),
      agentUserId,
      harness: str(from.harness),
      conversationId: str(from.conversationId),
    },
    to: { sessionId: toSessionId },
    ...(refs.length ? { refs } : {}),
    ...(cause ? { cause } : {}),
    hop: typeof r.hop === "number" && r.hop >= 0 ? Math.floor(r.hop) : 0,
    wake: r.wake === true,
    ...(hold === "hop_limit" || hold === "rate_limited"
      ? { wakeHeld: hold }
      : {}),
    ...(readAt ? { readAt } : {}),
    ...(readBy ? { readBy } : {}),
  };
}

/**
 * Client-supplied metadata with the server-owned stamp removed — a caller's
 * `metadata.sessionPost` must never land as a forged sender, target or wake.
 */
export function withoutSessionPostMeta(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!metadata || !(SESSION_POST_META_KEY in metadata)) return metadata;
  const { [SESSION_POST_META_KEY]: _dropped, ...rest } = metadata;
  return rest;
}
