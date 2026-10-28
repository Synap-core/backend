import {
  ROOM_POST_META_KEY,
  ROOM_POST_SLOT_LABEL_MAX,
  type RoomPostKind,
  type RoomPostMeta,
} from "@synap-core/types/ask";

// The marker's shape and its reader live in `@synap-core/types/ask`, so every
// surface reads a room question the way the pod stamps it; the writers stay.
export {
  ROOM_POST_KINDS,
  ROOM_POST_META_KEY,
  ROOM_POST_SLOT_LABEL_MAX,
  readRoomPostMeta,
  type RoomPostKind,
  type RoomPostMeta,
} from "@synap-core/types/ask";

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

/**
 * The dispositions a stored close proposal carries (`data.questionDispositions`,
 * written by the close door), read back for its approval. Anything that is not
 * one is dropped: the close door matches each id against the agent's own open
 * questions anyway. Pure.
 */
export function readCloseQuestionDispositions(
  raw: unknown
): CloseQuestionDisposition[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((d): CloseQuestionDisposition[] => {
    const r = d as Record<string, unknown> | null;
    if (
      !r ||
      typeof r.messageId !== "string" ||
      !(CLOSE_QUESTION_DISPOSITIONS as readonly unknown[]).includes(
        r.disposition
      )
    ) {
      return [];
    }
    return [
      {
        messageId: r.messageId,
        disposition: r.disposition as CloseQuestionDispositionKind,
        ...(typeof r.note === "string" ? { note: r.note } : {}),
      },
    ];
  });
}
