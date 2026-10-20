/**
 * Connecting a NEW account to answer a `provide` ask, in Review — the wait
 * between opening the service's sign-in and the slot answering itself.
 *
 * PURE. The console starts the connect session with `answerFor`
 * (`connectors.session`), so the POD answers the slot when the new connection
 * appears, wherever the sign-in finished. The console only opens the
 * sign-in, then waits: each tick it asks the pod to look for new connections
 * (`connectors.connections`, the post-sign-in refetch) and re-reads the slot.
 * The slot leaving the person's list is the answer; the page settles on that
 * outside this state. What is decided here:
 *
 *   - a NEW account appeared but the slot is still open a little later (the
 *     agent re-asked, or another tab answered first): stop waiting and say
 *     so, so the person picks it from the list;
 *   - the pod drops a pending connect after {@link CONNECT_WAIT_MINUTES}; the
 *     wait gives up with it;
 *   - the person can stop waiting at any time.
 */

/** Matches the pod's own life for a pending connect (`provide-connect.ts`). */
export const CONNECT_WAIT_MINUTES = 30;

/** How often the wait asks the pod again. */
export const CONNECT_POLL_MS = 4_000;

/** A new account that has not answered the slot after this long, did not. */
export const CONNECT_ANSWER_GRACE_MS = 10_000;

export type ConnectNote = "connected_unanswered" | "expired";

export type ConnectWait =
  | { phase: "idle"; note: ConnectNote | null }
  | { phase: "starting" }
  | {
      phase: "waiting";
      startedAt: number;
      /** The connections the person could already pick when it started. */
      baseline: readonly string[];
      /** The sign-in page, for a browser that blocked the new tab. */
      link: string;
      blocked: boolean;
      /** When a connection not in `baseline` was first seen. */
      newSeenAt: number | null;
    };

export type ConnectEvent =
  | { type: "start" }
  | {
      type: "started";
      now: number;
      link: string;
      blocked: boolean;
      baseline: readonly string[];
    }
  | { type: "start_failed" }
  /** A re-read that found the slot still open, with these connections. */
  | { type: "tick"; now: number; rowIds: readonly string[] }
  | { type: "cancel" };

export const CONNECT_IDLE: ConnectWait = { phase: "idle", note: null };

export function connectReducer(
  state: ConnectWait,
  event: ConnectEvent
): ConnectWait {
  switch (event.type) {
    case "start":
      return state.phase === "idle" ? { phase: "starting" } : state;
    case "started":
      return state.phase === "starting"
        ? {
            phase: "waiting",
            startedAt: event.now,
            baseline: event.baseline,
            link: event.link,
            blocked: event.blocked,
            newSeenAt: null,
          }
        : state;
    case "start_failed":
      return state.phase === "starting" ? CONNECT_IDLE : state;
    case "cancel":
      return CONNECT_IDLE;
    case "tick": {
      if (state.phase !== "waiting") return state;
      if (event.now - state.startedAt > CONNECT_WAIT_MINUTES * 60_000) {
        return { phase: "idle", note: "expired" };
      }
      const known = new Set(state.baseline);
      if (!event.rowIds.some((id) => !known.has(id))) return state;
      if (state.newSeenAt === null) return { ...state, newSeenAt: event.now };
      return event.now - state.newSeenAt >= CONNECT_ANSWER_GRACE_MS
        ? { phase: "idle", note: "connected_unanswered" }
        : state;
    }
  }
}

/** What an idle sheet says about the last wait, in words. */
export function connectNoteWords(
  note: ConnectNote | null,
  serviceName: string
): string | null {
  switch (note) {
    case null:
      return null;
    case "connected_unanswered":
      return `Your ${serviceName} account is connected, but this question is still open. Choose it below.`;
    case "expired":
      return `The ${serviceName} sign-in did not finish in time. Try again.`;
  }
}

/** The calm line while waiting. */
export function waitingWords(serviceName: string): string {
  return `Waiting for your ${serviceName} connection…`;
}

/** `connectors.session`'s input: pinned to the asked service, answering the slot. */
export function connectSessionCall(p: {
  providerId: string;
  sessionId: string;
  expectedLabel: string;
  askFingerprint: string;
}) {
  return {
    providerId: p.providerId,
    answerFor: {
      sessionId: p.sessionId,
      expectedLabel: p.expectedLabel,
      askFingerprint: p.askFingerprint,
    },
  };
}

/**
 * The sign-in page to open, when it is a web address. Anything else (a
 * script url, a relative path) is never opened.
 */
export function safeConnectLink(link: unknown): string | null {
  if (typeof link !== "string") return null;
  try {
    const url = new URL(link);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}
