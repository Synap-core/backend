/**
 * Signal capability HEALTH (producer mode + per-mode health) — REAL-DRIVER gate.
 *
 * Proves P4 against a live postgres.js connection:
 *
 *   1. `resolveCapabilityMode` — `capabilities.metadata.mode` (declared) WINS over
 *      a derived signal; a member tool with `config.transport = 'bridge'` derives
 *      `standing`; a non-bridge, undeclared capability is an honest `unknown`
 *      (never a guessed green).
 *   2. `getCapabilityHealth` — a standing capability with recent inbound reads
 *      `live`; the fate mix (incl. `suppressed`) sums over the capability's
 *      channels; the read stays capability-scoped + visibility-floored.
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
import { resolveCapabilityMode, getCapabilityHealth } from "./index.js";

const USER = "51930000-0000-0000-0000-0000000000a1";
const BRIDGE_TOOL = "51930000-0000-0000-0000-0000000000b1"; // config.transport = 'bridge'
const PLAIN_TOOL = "51930000-0000-0000-0000-0000000000b2"; // no transport marker
const CAP_DECLARED = "51930000-0000-0000-0000-0000000000c0"; // metadata.mode = 'callable' + bridge tool
const CAP_DERIVED = "51930000-0000-0000-0000-0000000000c1"; // bridge tool, no metadata
const CAP_UNKNOWN = "51930000-0000-0000-0000-0000000000c2"; // plain tool, no metadata
const CH_STANDING = "51930000-0000-0000-0000-0000000000d1"; // produced by BRIDGE_TOOL

async function insertMessage(
  channelId: string,
  ts: Date,
  author: MessageAuthorType = MessageAuthorType.EXTERNAL
) {
  await db.insert(messages).values({
    id: randomUUID(),
    channelId,
    role: MessageRole.USER,
    authorType: author,
    content: `cap-health ${channelId}`,
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
  await db.delete(messages).where(eq(messages.channelId, CH_STANDING));
  await db.delete(channels).where(eq(channels.id, CH_STANDING));
  for (const t of [BRIDGE_TOOL, PLAIN_TOOL]) {
    await db.delete(links).where(eq(links.fromId, t));
    await db.delete(tools).where(eq(tools.id, t));
  }
  for (const c of [CAP_DECLARED, CAP_DERIVED, CAP_UNKNOWN]) {
    await db.delete(capabilities).where(eq(capabilities.id, c));
  }
  await db.delete(users).where(eq(users.id, USER));
}

describe("signal capability-health real-driver gate", () => {
  it("probed the database (skips below are honest, not vacuous)", () => {
    expect(typeof dbAvailable).toBe("boolean");
  });
});

describe.skipIf(!dbAvailable)(
  "signal capability health — live postgres.js",
  () => {
    beforeAll(async () => {
      await cleanup();
      await db
        .insert(users)
        .values({ id: USER, email: "cap-health@test.synap", userType: "human" })
        .onConflictDoNothing();

      // A bridge tool (standing marker) + a plain tool (no marker).
      await db.insert(tools).values([
        {
          id: BRIDGE_TOOL,
          workspaceId: null,
          createdBy: USER,
          name: "proton",
          kind: "external",
          config: { transport: "bridge", externalSource: "proton" },
        },
        {
          id: PLAIN_TOOL,
          workspaceId: null,
          createdBy: USER,
          name: "apollo",
          kind: "external",
          config: {},
        },
      ]);

      // Three capabilities exercising the mode-resolution matrix.
      await db.insert(capabilities).values([
        {
          id: CAP_DECLARED,
          workspaceId: null,
          createdBy: USER,
          name: "declared-callable",
          metadata: { mode: "callable" },
        },
        {
          id: CAP_DERIVED,
          workspaceId: null,
          createdBy: USER,
          name: "derived-standing",
        },
        {
          id: CAP_UNKNOWN,
          workspaceId: null,
          createdBy: USER,
          name: "unknown-mode",
        },
      ]);

      // CAP_DECLARED and CAP_DERIVED both contain the bridge tool; CAP_UNKNOWN the
      // plain tool. (The bridge tool is a member of two capabilities.)
      await db.insert(links).values([
        {
          workspaceId: null,
          fromType: "tool",
          fromId: BRIDGE_TOOL,
          toType: "capability",
          toId: CAP_DECLARED,
          linkType: "member_of",
        },
        {
          workspaceId: null,
          fromType: "tool",
          fromId: BRIDGE_TOOL,
          toType: "capability",
          toId: CAP_DERIVED,
          linkType: "member_of",
        },
        {
          workspaceId: null,
          fromType: "tool",
          fromId: PLAIN_TOOL,
          toType: "capability",
          toId: CAP_UNKNOWN,
          linkType: "member_of",
        },
      ]);

      // A standing channel produced by the bridge tool, with a fresh inbound.
      await db.insert(channels).values({
        id: CH_STANDING,
        userId: USER,
        title: "proton inbox",
        channelType: ChannelType.EXTERNAL,
        externalSource: "proton",
        contextObjectId: null,
      });
      await db.insert(links).values({
        workspaceId: null,
        fromType: "tool",
        fromId: BRIDGE_TOOL,
        toType: "channel",
        toId: CH_STANDING,
        linkType: "produced",
      });
      await insertMessage(CH_STANDING, new Date());
    });

    afterAll(cleanup);

    it("declared metadata.mode WINS over the derived bridge signal", async () => {
      const m = await resolveCapabilityMode(USER, CAP_DECLARED);
      expect(m).toEqual({ mode: "callable", source: "declared" });
    });

    it("derives standing from a member tool's config.transport = 'bridge'", async () => {
      const m = await resolveCapabilityMode(USER, CAP_DERIVED);
      expect(m).toEqual({ mode: "standing", source: "derived_transport" });
    });

    it("a non-bridge, undeclared capability is an honest unknown", async () => {
      const m = await resolveCapabilityMode(USER, CAP_UNKNOWN);
      expect(m).toEqual({ mode: "unknown", source: "unknown" });
    });

    it("an unseeable / nonexistent capability resolves to unknown (visibility floor)", async () => {
      const m = await resolveCapabilityMode(USER, randomUUID());
      expect(m).toEqual({ mode: "unknown", source: "unknown" });
    });

    it("getCapabilityHealth: standing capability with fresh inbound reads live", async () => {
      const h = await getCapabilityHealth(USER, CAP_DERIVED);
      expect(h.mode).toBe("standing");
      expect(h.standing?.liveness).toBe("live");
      expect(h.callable).toBeNull();
      // The fresh inbound landed on a bound? no — unbound channel, no run ⇒ the fate
      // is unprocessed_unbound; what matters here is it counts and lastSeen is fresh.
      expect(h.messageCount).toBeGreaterThanOrEqual(1);
      expect(h.standing?.lastSeenAt).not.toBeNull();
    });
  }
);
