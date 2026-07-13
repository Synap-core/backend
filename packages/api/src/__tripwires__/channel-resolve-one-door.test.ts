import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join, relative } from "path";

/**
 * TRIPWIRE — the one-per-user channels (FEED, PERSONAL) have ONE resolve door.
 *
 * A FEED (proactive) and the active PERSONAL conversation (per-agent) have one
 * resolve door: exactly one active row per user (per user×agent for personal).
 * PERSONAL history may contain many archived rows. Active-row uniqueness is
 * enforced by the partial indexes cut in migration 0182
 * (channels_user_feed_uniq, channels_user_agent_personal_uniq). BEFORE 0182 the
 * indexes keyed on the retired `thread_kind` column and enforced nothing, so six
 * hand-rolled `findFirst → insert` copies across api + jobs silently duplicated
 * these channels — the "proactive AI makes a new channel every time / posts
 * scatter" bug.
 *
 * The fix is convergence: EVERY producer resolves FEED/PERSONAL through the
 * canonical race-safe resolvers, which upsert against those indexes:
 *   - personal-channel.ts          (api: ensureAgentThread / ensureProactiveFeedChannel / ensureWorkspaceGroupChannel)
 *   - channel-repository.ts        (database: ensurePersonalChannel / ensureProactiveFeedChannel / ensureUserPersonalChannel)
 * Jobs call the ChannelRepository methods; the api dispatcher (resolveOrCreateChannel)
 * calls the personal-channel resolvers. A NEW raw `.insert(channels)` that sets
 * `channelType: ChannelType.FEED` or `.PERSONAL` reopens the duplication vector.
 *
 * If this fails: resolve the channel through the door instead —
 *   jobs  → new ChannelRepository(db).ensureProactiveFeedChannel(userId) / .ensureUserPersonalChannel(userId)
 *   api   → ensureProactiveFeedChannel(userId) / ensureAgentThread(userId, agentId)
 * Do NOT add your file to the allowlist unless it IS a canonical resolver.
 *
 * SCOPE: THREAD / EXTERNAL / SUB_THREAD / AGENT_COLLAB inserts are exempt — those
 * kinds legitimately create many rows (per-subject threads, per-run rooms,
 * branches, external channels keyed by their own unique index / ensureExternalChannel).
 * Only the singleton kinds are guarded here.
 */

// The ONLY files permitted to raw-insert a FEED or PERSONAL channel — the
// canonical resolvers themselves.
const ALLOWLIST_SUFFIXES = [
  join("utils", "personal-channel.ts"),
  join("repositories", "channel-repository.ts"),
  // Legacy, MANUALLY-run "Unified Feeds Migration" tooling (not cron-invoked) that
  // provisioned per-type feed channels BEFORE the unified one-feed-per-user model
  // the resolvers now enforce. Superseded, not a live duplication vector; the
  // channels_user_feed_uniq index converges them if re-run. Retire in Wave 5.
  join("migrations", "migrate-morning-briefing.ts"),
  join("migrations", "migrate-weekly-digest.ts"),
];

// A Drizzle INSERT that materialises a singleton channel:
// `.insert(channels)` … `channelType: ChannelType.FEED|PERSONAL` in the values.
const BANNED =
  /\.insert\(\s*channels\s*\)[\s\S]{0,600}?channelType:\s*ChannelType\.(FEED|PERSONAL)/;

function tsFiles(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      tsFiles(p, acc);
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      acc.push(p);
    }
  }
  return acc;
}

describe("tripwire: FEED/PERSONAL channels have one resolve door", () => {
  it("no source file raw-inserts a FEED or PERSONAL channel outside the canonical resolvers", () => {
    const roots = [
      join(process.cwd(), "src"), // api/src
      join(process.cwd(), "..", "database", "src"), // @synap/database
      join(process.cwd(), "..", "jobs", "src"), // @synap/jobs
    ];
    const offenders: string[] = [];
    for (const root of roots) {
      for (const f of tsFiles(root)) {
        if (ALLOWLIST_SUFFIXES.some((s) => f.endsWith(s))) continue;
        if (BANNED.test(readFileSync(f, "utf8"))) {
          offenders.push(relative(join(process.cwd(), ".."), f));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
