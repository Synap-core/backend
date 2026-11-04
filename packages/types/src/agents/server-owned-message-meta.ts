/**
 * The keys of `messages.metadata` that only the pod writes. Each one makes a
 * message MEAN something to the pod or to every surface:
 *   - `roomPost`    — an agent's question/update, its answer and provenance
 *                     (`../ask/room-post.ts`);
 *   - `sessionPost` — a coordination post's sender, target and wake
 *                     (`./session-post.ts`);
 *   - `routeChoice` — the "who should answer?" chip, which starts a turn on
 *                     the message it names when tapped (`./route-choice.ts`).
 * A caller that could send one could forge a question, a sender or a chip.
 */
import { ROOM_POST_META_KEY } from "../ask/room-post.js";
import { ROUTE_CHOICE_META_KEY } from "./route-choice.js";
import { SESSION_POST_META_KEY } from "./session-post.js";

export const SERVER_OWNED_MESSAGE_META_KEYS = [
  ROOM_POST_META_KEY,
  SESSION_POST_META_KEY,
  ROUTE_CHOICE_META_KEY,
] as const;

/**
 * Message metadata from a caller with every server-owned key removed. The ONE
 * helper every door that accepts message metadata from outside runs before it
 * writes (Hub REST threads, Hub tRPC channels, tRPC narrate and process seeds,
 * `insertChannelMessage`). The WHOLE key goes, so every stamp under it is
 * server-owned by construction. Metadata without one is returned as it was.
 * Pure.
 */
export function withoutServerOwnedMessageMeta<
  T extends Record<string, unknown> | null | undefined,
>(metadata: T): T {
  if (!metadata) return metadata;
  if (!SERVER_OWNED_MESSAGE_META_KEYS.some((k) => k in metadata)) {
    return metadata;
  }
  const rest: Record<string, unknown> = { ...metadata };
  for (const k of SERVER_OWNED_MESSAGE_META_KEYS) delete rest[k];
  return rest as T;
}
