/**
 * Signal pipeline — REAL-DRIVER regression gate (DB-gated).
 *
 * The mocked `signal.test.ts` stubs `drizzleSql` to a no-op, so it can NEVER
 * catch a bind-time driver fault. Two faults can only be seen against a live
 * postgres.js connection, so they live here:
 *
 *   1. The run read used `->>'channelId' = ANY(${channelIds})`. Binding a JS
 *      array into the SQL template serializes it as a Postgres array literal,
 *      which the pod image's postgres.js driver FAULTS on at bind time —
 *      `listPipeline` threw on every non-empty pod. The fix is an OR of scalar
 *      `=` params; this test proves the run read now EXECUTES (any inbound
 *      message makes `channelIds` non-empty, which triggers the run read).
 *
 *   2. `messages.timestamp` is not unique (bulk imports share a millisecond).
 *      A strict `lt(timestamp, before)` cursor with no tie-breaker dropped every
 *      row at the boundary ts / duplicated rows across pages. The composite
 *      `(timestamp, id)` keyset must page ≥3 equal-timestamp rows across a
 *      boundary with each row seen exactly once.
 *
 * Requires a running Postgres (DATABASE_URL from vitest config). Skips cleanly
 * when the connection fails (mirrors graph-relations-visibility.test.ts). This
 * file does NOT mock @synap/database — it exercises the real query builder.
 */

import { randomUUID } from "crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  db,
  messages,
  channels,
  users,
  eq,
  drizzleSql,
  ChannelType,
  MessageRole,
  MessageAuthorType,
} from "@synap/database";
import { listPipeline } from "./index.js";

const USER = "51900000-0000-0000-0000-0000000000a1";
const CHANNEL = "51900000-0000-0000-0000-0000000000c1";
// Three messages that share ONE millisecond, straddling a limit-2 page boundary.
const EQ_TS = new Date("2026-01-01T00:00:00.000Z");
const M_EQ = [
  "51900000-0000-0000-0000-0000000000e1",
  "51900000-0000-0000-0000-0000000000e2",
  "51900000-0000-0000-0000-0000000000e3",
] as const;

async function insertMessage(id: string, ts: Date) {
  await db.insert(messages).values({
    id,
    channelId: CHANNEL,
    role: MessageRole.USER,
    authorType: MessageAuthorType.EXTERNAL,
    content: `signal ${id}`,
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
  await db.delete(messages).where(eq(messages.channelId, CHANNEL));
  await db.delete(channels).where(eq(channels.id, CHANNEL));
  await db.delete(users).where(eq(users.id, USER));
}

// Anti-skip sanity — NEVER gated. When PG is down the suite below is reported
// SKIPPED, never PASSED, so a green run without a database can't masquerade as
// having proven the driver fix.
describe("signal pipeline real-driver gate", () => {
  it("probed the database (skips below are honest, not vacuous)", () => {
    expect(typeof dbAvailable).toBe("boolean");
  });
});

describe.skipIf(!dbAvailable)("signal.listPipeline — live postgres.js", () => {
  beforeAll(async () => {
    await cleanup();
    await db
      .insert(users)
      .values({ id: USER, email: "signal-db@test.synap", userType: "human" })
      .onConflictDoNothing();
    // Owned external channel → visible via channelVisibilityWhere branch 1.
    await db.insert(channels).values({
      id: CHANNEL,
      userId: USER,
      title: "Signal DB Test",
      channelType: ChannelType.EXTERNAL,
      externalSource: "discord",
      contextObjectId: null, // unbound
    });
    for (const id of M_EQ) await insertMessage(id, EQ_TS);
  });

  afterAll(cleanup);

  it("run read no longer faults on the postgres.js driver (was `= ANY(array)`)", async () => {
    // Before the fix this THREW at bind time (array→PG-array-literal). The mere
    // fact that a page comes back — with the run read executed — is the proof.
    const page = await listPipeline({ userId: USER, limit: 100 });
    expect(page.units.length).toBe(M_EQ.length);
    // Unbound channel, no run → the structural-gap fate.
    for (const u of page.units) expect(u.fate).toBe("unprocessed_unbound");
  });

  it("composite (timestamp,id) cursor pages equal-timestamp rows with no drops/dupes", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    // limit 2 across 3 equal-ts rows → the boundary lands mid-block.
    for (let guard = 0; guard < 5; guard++) {
      const page: Awaited<ReturnType<typeof listPipeline>> = await listPipeline(
        {
          userId: USER,
          limit: 2,
          before: cursor ? new Date(cursor.split("|")[0]) : undefined,
          beforeId: cursor ? cursor.split("|")[1] : undefined,
        }
      );
      seen.push(...page.units.map((u) => u.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    // All three distinct ids, each exactly once — none dropped, none duplicated.
    expect(seen.slice().sort()).toEqual([...M_EQ].slice().sort());
    expect(new Set(seen).size).toBe(M_EQ.length);
  });
});
