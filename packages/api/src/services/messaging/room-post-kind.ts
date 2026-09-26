/**
 * What an agent's room post IS — the `kind` param on MCP `synap_post_message`
 * and Hub REST `POST /threads/:id/messages`. Pure (no I/O) so the tool schema
 * and the Hub codec can derive their enums from it.
 *
 * `question` — the person is needed; in a session room it pushes once per
 * session window (`session.needs_you`). `update` (default) — progress and
 * results; NO notification at all (founder decision F, 2026-09-25) — it
 * lives only in the room and the session's state mark.
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
   * Stamped once, atomically, when the session OWNER's reply answered this
   * question. Its presence is what makes a question no longer open.
   */
  answer?: {
    messageId: string;
    answeredBy: string;
    answeredAt: string;
    text: string;
  };
}

/** The persisted marker for an agent post. Pure. */
export function roomPostMeta(
  kind: RoomPostKind | undefined,
  slotLabel?: string | null
): RoomPostMeta {
  const label = typeof slotLabel === "string" ? slotLabel.trim() : "";
  return {
    kind: kind ?? "update",
    ...(kind === "question" && label
      ? { slotLabel: label.slice(0, ROOM_POST_SLOT_LABEL_MAX) }
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
 */
export function withoutRoomPostMeta(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!metadata || !(ROOM_POST_META_KEY in metadata)) return metadata;
  const { [ROOM_POST_META_KEY]: _dropped, ...rest } = metadata;
  return rest;
}
