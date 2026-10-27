/**
 * A room post's persisted marker (`messages.metadata.roomPost`) and its ONE
 * reader — here, not in the api, so every surface reads a room question's
 * state (`questionDisposition`) off the same shape the pod stamps. The api's
 * `services/messaging/room-post-kind.ts` re-exports these and keeps the
 * writers (stamp, strip). Type-only imports from `./index.js`: no ESM cycle.
 */
import type {
  AnswerProvenance,
  PendingRelayedAnswer,
  QuestionClosed,
} from "./index.js";

/**
 * What an agent's room post IS — the `kind` param on MCP `synap_post_message`
 * and Hub REST `POST /threads/:id/messages`. Pure (no I/O) so the tool schema
 * and the Hub codec can derive their enums from it.
 *
 * `question` — the person is needed; in a session room it pushes once per
 * session window (`session.needs_you`). `update` (default) — progress and
 * results; NO notification at all (founder decision F, 2026-09-25) — it
 * lives only in the room and the session's state mark.
 *
 * Its sibling, for a message to ANOTHER SESSION's agent rather than the
 * person, is the coordination post's `intent` (`metadata.sessionPost`,
 * `@synap-core/types/agents` session-post, built by `session-post.ts`). Such
 * a post is always an `update` here and never notifies anyone.
 */
export const ROOM_POST_KINDS = ["question", "update"] as const;
export type RoomPostKind = (typeof ROOM_POST_KINDS)[number];

/**
 * WHERE an agent post's kind is PERSISTED — `messages.metadata[ROOM_POST_META_KEY]`.
 *
 * The kind used to route the notification and then vanish, so nothing could
 * later ask "which message was a question, and has it been answered?" — the
 * foundation the answer loop (`services/focus-sessions/session-answer.ts`)
 * stands on. SERVER-OWNED: stamped only for an AGENT's post (the door's
 * verified `agentUserId`), and stripped from any client-supplied metadata, so
 * a caller can neither forge a question nor forge its answer.
 */
export const ROOM_POST_META_KEY = "roomPost" as const;

/** Bound on a slot label carried by a question post (matches the slot doors). */
export const ROOM_POST_SLOT_LABEL_MAX = 500;

export interface RoomPostMeta {
  kind: RoomPostKind;
  /** The owed slot a `question` is about — its declared label. */
  slotLabel?: string;
  /**
   * The provider tool call a dispatched agent is blocked on (e.g. a Managed
   * Agents `always_ask` push) — the event id its binding's `status` verb
   * reported. Set ONLY by the pod's status poll on the approval card it posts;
   * a typed approve / reject of THAT card is the only answer that settles the
   * call (`wakeExternalAgent` → the binding's `send`). Free words never do.
   */
  confirmationId?: string;
  /**
   * Stamped once, atomically, when the session OWNER's reply answered this
   * question. Its presence is what makes a question no longer open.
   */
  answer?: {
    messageId: string;
    answeredBy: string;
    answeredAt: string;
    text: string;
  } & AnswerProvenance;
  /**
   * A relayed answer to a `commitment` question, waiting for the owner's tap
   * (`PendingRelayedAnswer`, `@synap-core/types/ask`, says why it is not
   * `answer`). Its presence leaves the question OPEN.
   */
  pendingRelay?: PendingRelayedAnswer;
  /**
   * Stamped once when the question stopped being open WITHOUT an answer: its
   * session ended or its agent withdrew it. Never deleted.
   */
  closed?: QuestionClosed;
}

/** Read the marker back off a message's metadata. Pure; `null` when absent. */
export function readRoomPostMeta(metadata: unknown): RoomPostMeta | null {
  if (!metadata || typeof metadata !== "object") return null;
  const raw = (metadata as Record<string, unknown>)[ROOM_POST_META_KEY];
  if (!raw || typeof raw !== "object") return null;
  const kind = (raw as { kind?: unknown }).kind;
  if (kind !== "question" && kind !== "update") return null;
  return raw as RoomPostMeta;
}
