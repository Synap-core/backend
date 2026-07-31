import { createHash } from "crypto";

/**
 * computeMessageHash — the ONE definition of the channel-message tamper-evidence
 * hash. A message row's `hash` is `sha256(id + content + previousHash)`, where
 * `previousHash` chains it to the prior message ("" for a standalone/first post).
 *
 * This is an integrity scheme, so the formula must live in exactly one place —
 * every message writer (persistAssistantReply, the proactive-post feed/chat
 * writers, …) derives its `hash` from here so the chain can never silently drift
 * between producers.
 *
 * Dual-use of `messages.hash` (D5 / migration 0218):
 * - Tamper writers use this function (UUID id is in the preimage → unique per row).
 * - Inbound-recorder stores sha256(provider:idempotencySeed) for delivery dedup.
 * Global UNIQUE(hash) is intentional for both: concurrent inbound claims
 * ON CONFLICT DO NOTHING; cross-domain collision is 2^-256.
 */
export function computeMessageHash(
  id: string,
  content: string,
  previousHash = ""
): string {
  return createHash("sha256")
    .update(`${id}${content}${previousHash}`)
    .digest("hex");
}
