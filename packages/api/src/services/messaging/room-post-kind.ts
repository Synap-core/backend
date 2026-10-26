import type {
  AnswerProvenance,
  PendingRelayedAnswer,
  QuestionClosed,
} from "@synap-core/types/ask";

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
   * session ended (W2) or its agent withdrew it (W1). Never deleted.
   */
  closed?: QuestionClosed;
}

/** The persisted marker for an agent post. Pure. */
export function roomPostMeta(
  kind: RoomPostKind | undefined,
  slotLabel?: string | null,
  confirmationId?: string | null
): RoomPostMeta {
  const label = typeof slotLabel === "string" ? slotLabel.trim() : "";
  const confirmation =
    typeof confirmationId === "string" ? confirmationId.trim() : "";
  return {
    kind: kind ?? "update",
    ...(kind === "question" && label
      ? { slotLabel: label.slice(0, ROOM_POST_SLOT_LABEL_MAX) }
      : {}),
    ...(kind === "question" && label && confirmation
      ? { confirmationId: confirmation.slice(0, 200) }
      : {}),
  };
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

/**
 * Client-supplied metadata with the server-owned marker removed — a Hub
 * caller's `metadata.roomPost` must never land as a forged question/answer.
 * The WHOLE key goes, so every stamp under it (`answer` and its provenance,
 * `pendingRelay`, `closed`) is server-owned by construction.
 */
export function withoutRoomPostMeta(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!metadata || !(ROOM_POST_META_KEY in metadata)) return metadata;
  const { [ROOM_POST_META_KEY]: _dropped, ...rest } = metadata;
  return rest;
}

/**
 * How an agent shows a room question in its own chat: `Q-` + the first 8
 * characters of the message id (`Q-1a2b3c4d`). Pure.
 */
export function questionShortId(messageId: string): string {
  return `Q-${messageId.slice(0, 8)}`;
}

/**
 * What the closing agent does with a question it asked and nobody answered.
 *   `withdrawn`    — overtaken: its work answered it, the plan changed (a
 *                    `note` says why). Stamped `closed: withdrawn`.
 *   `keep_as_owed` — the person still owes the answer after the session: it
 *                    becomes an owed slot of theirs (the question's own slot,
 *                    else a new one), which no exit retires.
 * An answer the person gave in chat is not a disposition: it is relayed
 * (`synap_relay_answer`) before closing (the close door, `complete-session.ts`).
 */
export const CLOSE_QUESTION_DISPOSITIONS = [
  "withdrawn",
  "keep_as_owed",
] as const;
export type CloseQuestionDispositionKind =
  (typeof CLOSE_QUESTION_DISPOSITIONS)[number];

export interface CloseQuestionDisposition {
  /** The room question's message id (the full id, never the `Q-` short form). */
  messageId: string;
  disposition: CloseQuestionDispositionKind;
  note?: string;
}

