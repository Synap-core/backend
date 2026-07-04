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
