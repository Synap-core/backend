import { createHash } from "node:crypto";

/**
 * Deterministic UUID from an arbitrary seed (e.g. Discord
 * `${channelId}:${messageId}`). `chat_turns.request_id` is a UUID column; non-
 * UUID client seeds (snowflakes) still need a stable idempotency key.
 *
 * Kept out of `chat-turn-store.ts` so that file's messages insert does not
 * trip the message-hash-one-formula scan (createHash here is UUID shaping,
 * not messages.hash).
 */
export function stableUuidFromSeed(seed: string): string {
  const h = createHash("sha256").update(seed).digest();
  // RFC 4122 version-5 style nibble + variant so Postgres uuid accepts it.
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const hex = Buffer.from(h.subarray(0, 16)).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
