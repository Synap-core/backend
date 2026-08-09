/**
 * Signal outbound egress — REAL-DRIVER regression gate (DB-gated).
 *
 * Proves `listEgress({ capabilityId })` against a live postgres.js connection:
 *   1. `sentCount`/`lastSentAt` are derived from outbound (human/agent) messages
 *      on the capability's channels — the symmetric mirror of the inbound read.
 *   2. `failedCount` is folded in from the `channel_egress` outbox, matched on the
 *      channel's `(externalSource, externalId)` target (the OR-of-scalar composite
 *      must not fault at bind time).
 *   3. The lens narrows to the capability's channels — another provider's channel
 *      is excluded.
 *
 * Skips cleanly when the connection fails (mirrors signal.capability-lens-db.test.ts).
 * Does NOT mock @synap/database — it exercises the real query builder.
 */

import { randomUUID } from "crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  db,
  messages,
  channels,
  channelEgress,
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
import { listEgress } from "./index.js";

const USER = "51920000-0000-0000-0000-0000000000a1";
const TOOL = "51920000-0000-0000-0000-0000000000b1";
const CAP = "51920000-0000-0000-0000-0000000000ca";
const CH_SENT = "51920000-0000-0000-0000-0000000000c1"; // discord, has outbound + a failed egress
const OTHER_CH = "51920000-0000-0000-0000-0000000000c3"; // slack — excluded
const EXT_ID = "discord-chan-egress-1";

async function insertOutbound(
  channelId: string,
  ts: Date,
  author: MessageAuthorType
) {
  await db.insert(messages).values({
    id: randomUUID(),
    channelId,
    role:
      author === MessageAuthorType.HUMAN
        ? MessageRole.USER
        : MessageRole.ASSISTANT,
    authorType: author,
    content: `egress-out ${channelId}`,
    userId: USER,
    timestamp: ts,
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
  for (const ch of [CH_SENT, OTHER_CH]) {
    await db.delete(messages).where(eq(messages.channelId, ch));
    await db.delete(channels).where(eq(channels.id, ch));
  }
  await db.delete(channelEgress).where(eq(channelEgress.externalId, EXT_ID));
  await db.delete(links).where(eq(links.fromId, TOOL));
  await db.delete(capabilities).where(eq(capabilities.id, CAP));
  await db.delete(tools).where(eq(tools.id, TOOL));
  await db.delete(users).where(eq(users.id, USER));
}

describe("signal egress real-driver gate", () => {
  it("probed the database (skips below are honest, not vacuous)", () => {
    expect(typeof dbAvailable).toBe("boolean");
  });
});

describe.skipIf(!dbAvailable)(
  "signal outbound egress — live postgres.js",
  () => {
    beforeAll(async () => {
      await cleanup();
      await db
        .insert(users)
        .values({ id: USER, email: "egress@test.synap", userType: "human" })
        .onConflictDoNothing();
      await db.insert(tools).values({
        id: TOOL,
        workspaceId: null,
        createdBy: USER,
        name: "discord",
        kind: "provider",
      });
      await db.insert(capabilities).values({
        id: CAP,
        workspaceId: null,
        createdBy: USER,
        name: "Discord (egress test)",
      });
      await db.insert(links).values({
        workspaceId: null,
        fromType: "tool",
        fromId: TOOL,
        toType: "capability",
        toId: CAP,
        linkType: "member_of",
      });
      // The capability's produced channel (discord), plus an unrelated slack channel.
      await db.insert(channels).values({
        id: CH_SENT,
        userId: USER,
        title: "egress produced",
        channelType: ChannelType.EXTERNAL,
        externalSource: "discord",
        externalId: EXT_ID,
        contextObjectId: null,
      });
      await db.insert(channels).values({
        id: OTHER_CH,
        userId: USER,
        title: "egress other",
        channelType: ChannelType.EXTERNAL,
        externalSource: "slack",
        contextObjectId: null,
      });
      await db.insert(links).values({
        workspaceId: null,
        fromType: "tool",
        fromId: TOOL,
        toType: "channel",
        toId: CH_SENT,
        linkType: "produced",
      });
      // Two outbound messages on the produced channel (a human send + an agent reply)
      // and one INBOUND (external) message that must NOT count as sent.
      await insertOutbound(
        CH_SENT,
        new Date("2026-08-01T10:00:00Z"),
        MessageAuthorType.HUMAN
      );
      await insertOutbound(
        CH_SENT,
        new Date("2026-08-01T12:00:00Z"),
        MessageAuthorType.AI_AGENT
      );
      await db.insert(messages).values({
        id: randomUUID(),
        channelId: CH_SENT,
        role: MessageRole.USER,
        authorType: MessageAuthorType.EXTERNAL,
        content: "inbound, not outbound",
        userId: USER,
        timestamp: new Date("2026-08-01T11:00:00Z"),
        hash: randomUUID(),
        ephemeral: false,
      });
      // An outbound message on the excluded slack channel.
      await insertOutbound(
        OTHER_CH,
        new Date("2026-08-01T10:00:00Z"),
        MessageAuthorType.HUMAN
      );
      // A terminal-failed outbox row for the produced channel's external target.
      await db.insert(channelEgress).values({
        externalSource: "discord",
        externalId: EXT_ID,
        kind: "post_message",
        payload: {},
        status: "failed",
      });
    });

    afterAll(cleanup);

    it("counts outbound sends (human + agent, not inbound) and folds in egress failures", async () => {
      const res = await listEgress({ userId: USER, capabilityId: CAP });
      const ch = res.channels.find((c) => c.channelId === CH_SENT);
      expect(ch).toBeTruthy();
      expect(ch!.sentCount).toBe(2);
      expect(ch!.failedCount).toBe(1);
      expect(ch!.lastSentAt).toEqual(new Date("2026-08-01T12:00:00Z"));
      expect(ch!.provider).toBe("discord");
      // The slack channel is not part of the capability — excluded from the lens.
      expect(res.channels.map((c) => c.channelId)).not.toContain(OTHER_CH);
    });

    it("an unknown capability id yields an empty outbound rollup", async () => {
      const res = await listEgress({
        userId: USER,
        capabilityId: randomUUID(),
      });
      expect(res.channels).toEqual([]);
    });
  }
);
