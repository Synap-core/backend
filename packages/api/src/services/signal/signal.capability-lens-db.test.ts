/**
 * Signal capability lens — REAL-DRIVER regression gate (DB-gated).
 *
 * Proves the P2 `capabilityId` scope against a live postgres.js connection:
 *
 *   1. `resolveCapabilityChannelIds` derives a capability's channels via the
 *      graph path (capability <--member_of-- tool --produced--> channel) UNIONed
 *      with the legacy fallback (channels whose `externalSource` == the tool's
 *      provider slug), and EXCLUDES a channel of a different provider.
 *   2. `listChannels({ capabilityId })` narrows the rollup to exactly those.
 *   3. `getSignalSummary(userId, capabilityId)` EXECUTES — the run-scope filter
 *      is an OR of scalar `=` params (never a PG array literal), so the summary
 *      must not fault at bind time, and `messages24h` counts only the
 *      capability's channels.
 *
 * Skips cleanly when the connection fails (mirrors signal.pipeline-db.test.ts).
 * Does NOT mock @synap/database — it exercises the real query builder.
 */

import { randomUUID } from "crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  db,
  messages,
  channels,
  users,
  tools,
  capabilities,
  links,
  eq,
  drizzleSql,
  ChannelType,
  MessageRole,
  MessageAuthorType,
} from "@synap/database";
import {
  resolveCapabilityChannelIds,
  listChannels,
  getSignalSummary,
} from "./index.js";

const USER = "51910000-0000-0000-0000-0000000000a1";
const TOOL = "51910000-0000-0000-0000-0000000000b1";
const CAP = "51910000-0000-0000-0000-0000000000ca";
const PRODUCED_CH = "51910000-0000-0000-0000-0000000000c1"; // discord, produced-edge
const LEGACY_CH = "51910000-0000-0000-0000-0000000000c2"; // discord, slug fallback
const OTHER_CH = "51910000-0000-0000-0000-0000000000c3"; // slack — excluded

async function insertMessage(channelId: string) {
  await db.insert(messages).values({
    id: randomUUID(),
    channelId,
    role: MessageRole.USER,
    authorType: MessageAuthorType.EXTERNAL,
    content: `cap-lens ${channelId}`,
    userId: USER,
    timestamp: new Date(),
    hash: randomUUID(),
    ephemeral: false,
  });
}

async function checkDb(): Promise<boolean> {
  try {
    await db
      .select({ one: drizzleSql`1` })
      .from(users)
      .limit(1);
    return true;
  } catch {
    return false;
  }
}

const dbAvailable = await checkDb();

async function cleanup() {
  for (const ch of [PRODUCED_CH, LEGACY_CH, OTHER_CH]) {
    await db.delete(messages).where(eq(messages.channelId, ch));
    await db.delete(channels).where(eq(channels.id, ch));
  }
  await db.delete(links).where(eq(links.fromId, TOOL));
  await db.delete(capabilities).where(eq(capabilities.id, CAP));
  await db.delete(tools).where(eq(tools.id, TOOL));
  await db.delete(users).where(eq(users.id, USER));
}

describe("signal capability-lens real-driver gate", () => {
  it("probed the database (skips below are honest, not vacuous)", () => {
    expect(typeof dbAvailable).toBe("boolean");
  });
});

describe.skipIf(!dbAvailable)(
  "signal capability lens — live postgres.js",
  () => {
    beforeAll(async () => {
      await cleanup();
      await db
        .insert(users)
        .values({ id: USER, email: "cap-lens@test.synap", userType: "human" })
        .onConflictDoNothing();
      // Pod-wide provider tool named for the provider slug.
      await db.insert(tools).values({
        id: TOOL,
        workspaceId: null,
        createdBy: USER,
        name: "discord",
        kind: "provider",
      });
      // Pod-wide capability container, with the tool as a member part.
      await db.insert(capabilities).values({
        id: CAP,
        workspaceId: null,
        createdBy: USER,
        name: "Discord (cap-lens test)",
      });
      await db.insert(links).values({
        workspaceId: null,
        fromType: "tool",
        fromId: TOOL,
        toType: "capability",
        toId: CAP,
        linkType: "member_of",
      });
      // Three owned external channels (visible via channelVisibilityWhere branch 1).
      for (const [id, source] of [
        [PRODUCED_CH, "discord"],
        [LEGACY_CH, "discord"],
        [OTHER_CH, "slack"],
      ] as const) {
        await db.insert(channels).values({
          id,
          userId: USER,
          title: `cap-lens ${id}`,
          channelType: ChannelType.EXTERNAL,
          externalSource: source,
          contextObjectId: null,
        });
      }
      // Only PRODUCED_CH carries a produced edge to the tool; LEGACY_CH relies on
      // the externalSource slug fallback.
      await db.insert(links).values({
        workspaceId: null,
        fromType: "tool",
        fromId: TOOL,
        toType: "channel",
        toId: PRODUCED_CH,
        linkType: "produced",
      });
      for (const ch of [PRODUCED_CH, LEGACY_CH, OTHER_CH])
        await insertMessage(ch);
    });

    afterAll(cleanup);

    it("resolves the capability's channels (produced edge ∪ slug fallback), excludes other providers", async () => {
      const ids = await resolveCapabilityChannelIds(USER, CAP);
      expect(new Set(ids)).toEqual(new Set([PRODUCED_CH, LEGACY_CH]));
      expect(ids).not.toContain(OTHER_CH);
    });

    it("listChannels narrows the rollup to the capability's channels", async () => {
      const res = await listChannels({ userId: USER, capabilityId: CAP });
      expect(new Set(res.channels.map((c) => c.channelId))).toEqual(
        new Set([PRODUCED_CH, LEGACY_CH])
      );
    });

    it("getSignalSummary executes with the capability scope (run-scope OR of scalars) and counts only its channels", async () => {
      const scoped = await getSignalSummary(USER, CAP);
      // Two discord messages in-window, the slack one excluded.
      expect(scoped.messages24h).toBe(2);
      // The pod-wide summary sees all three — the scope is a real narrowing.
      const podWide = await getSignalSummary(USER);
      expect(podWide.messages24h).toBeGreaterThanOrEqual(3);
    });

    it("an unknown capability id yields an empty lens (no channels produced)", async () => {
      const ids = await resolveCapabilityChannelIds(USER, randomUUID());
      expect(ids).toEqual([]);
      const res = await listChannels({
        userId: USER,
        capabilityId: randomUUID(),
      });
      expect(res.channels).toEqual([]);
    });
  }
);
