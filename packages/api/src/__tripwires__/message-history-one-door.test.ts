import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * TRIPWIRE — the message-HISTORY read door owns the full filter triad.
 *
 * `queryChannelMessages` (utils/query-channel-messages.ts) is the ONE door for
 * channel message-history reads. Its whole purpose is that a read physically
 * cannot forget the three filters that keep soft-deleted / ephemeral / cross-
 * user messages out of a (re)loaded history:
 *
 *   1. channelVisibilityWhere(userId)  — the canonical channel-read gate
 *   2. isNull(messages.deletedAt)       — soft-deleted rows never resurface
 *   3. eq(messages.ephemeral, false)    — live-only recaps never restore
 *
 * If any of these disappears from the door, every caller silently regresses at
 * once — this is the single-point-of-failure the consolidation created, so it
 * is the thing worth locking. This test fails if the door stops applying the
 * triad. It does NOT prove behavior; it proves the SSOT still contains its
 * load-bearing filters.
 *
 * DELIBERATELY NOT a "no new bypass" file-scan. Such a scan cannot be made
 * precise here without false positives: the `messages` table is read directly —
 * with the very same `deletedAt` / `ephemeral` tokens — by legitimate NON-history
 * paths that share the same files as history reads (per-channel unread/activity
 * COUNT aggregates and the "has-assistant" flag in channels.ts, the
 * empty-branch-prune existence probe, the proactive rate-limit counters in
 * DeliveryService / proactive.ts, single-row `findFirst`-by-id write-support
 * lookups, and the intentionally-unmigrated divergent readers that lack part of
 * the triad — hub-protocol getMessages, threads REST, routing recentMessages).
 * A token/file scan would either flag those or require allowlisting whole files
 * (including channels.ts, the main history file) — which would then hide a
 * future in-file bypass, defeating the point. Deferred rather than shipped
 * fragile. See the migration report.
 */

const DOOR = "utils/query-channel-messages.ts";

// Substrings that must appear in the door — each is one leg of the triad. Kept
// whitespace-insensitive by stripping spaces before matching so a reformat
// (e.g. Prettier line-wrap) can't false-fail this.
const REQUIRED = [
  "channelVisibilityWhere(userId)",
  "isNull(messages.deletedAt)",
  "eq(messages.ephemeral,false)",
];

describe("tripwire: message-history door owns the filter triad", () => {
  it("queryChannelMessages still applies visibility + deletedAt + ephemeral", () => {
    const src = readFileSync(join(process.cwd(), "src", DOOR), "utf8").replace(
      /\s+/g,
      ""
    );
    const missing = REQUIRED.filter((needle) => !src.includes(needle));
    expect(missing).toEqual([]);
  });
});
