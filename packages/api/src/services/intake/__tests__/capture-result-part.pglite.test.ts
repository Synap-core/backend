/**
 * CAPTURE RESULT PART — the structure result is persisted into the session's
 * room and is readable back, on a real Postgres (PGlite).
 *
 * Driven through the real `persistCaptureResult` → `ensureSessionChannel` →
 * `recordCapturePartMessage`, and the real `dismissCaptureResultRow`. Every
 * assertion reads the ROW back through the contract's own `readCapturePart`,
 * so a part that does not satisfy `CaptureResultPartSchema` fails here.
 *
 * Stubbed: `emitChatEvent` (realtime fan-out).
 *
 * NOT covered here (NEEDS-DOGFOOD): `capture.structure` / `capture.answerFollowUp`
 * end to end — they need the IS. That the terminal (post-dedup) return is the
 * ONE call site is pinned statically by `capture-result-one-writer.tripwire.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const holder = vi.hoisted(() => ({
  db: undefined as unknown,
  emitted: [] as Array<{ event: string; data: unknown }>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = { ...actual };
  Object.defineProperty(mocked, "db", {
    get: () => holder.db,
    enumerable: true,
  });
  return mocked;
});
vi.mock("../../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: (o: { event: string; data: unknown }) => {
    holder.emitted.push(o);
  },
}));

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { TRPCError } from "@trpc/server";
import {
  focusSessions,
  channels,
  channelMembers,
  messages,
  users,
} from "@synap/database";
import {
  CAPTURE_RESULT_LIMITS,
  readCapturePart,
  type CaptureResultPart,
} from "@synap-core/types/capture";
import {
  DEDUP_SKIPPED_NOTICE,
  dismissCaptureResultRow,
  persistCaptureResult,
  projectCaptureResultRows,
} from "../capture-result-part.js";
import { persistCaptureQuestion } from "../capture-clarification.js";

const USER = "user-1";
const OTHER = "user-2";

/** CREATE TABLE from the drizzle definition (same helper as the sibling suites). */
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const columns = cfg.columns.map((c) => {
    let type = c.getSQLType();
    if (/vector/.test(type) || c.columnType === "PgEnumColumn") type = "text";
    let def = "";
    const d = c.default as unknown;
    if (d !== undefined && !(d instanceof SQL)) {
      if (typeof d === "string") def = ` default '${d.replace(/'/g, "''")}'`;
      else if (typeof d === "number" || typeof d === "boolean")
        def = ` default ${d}`;
      else if (type.endsWith("[]")) def = ` default '{}'`;
      else def = ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
    } else if (type.startsWith("timestamp") && c.hasDefault) {
      def = " default now()";
    } else if (c.primary && type === "uuid") {
      def = " default gen_random_uuid()";
    }
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${columns.join(", ")});`;
}

let client: PGlite;
const q = async <T>(sql: string, params?: unknown[]) =>
  (await client.query<T>(sql, params)).rows;

beforeEach(async () => {
  client = new PGlite();
  // channel_members + users: the session room is a GROUP whose roster is
  // seeded at mint (owner, agents, the owner's "@ai" orchestrator).
  for (const t of [focusSessions, channels, messages, channelMembers, users]) {
    await client.exec(ddlFor(t as unknown as PgTable));
  }
  await client.exec(
    `create unique index on channel_members (channel_id, member_id);`
  );
  holder.db = drizzle(client, {
    schema: { focusSessions, channels, messages, channelMembers, users },
  });
  holder.emitted.length = 0;
});

async function seedSession(userId = USER): Promise<string> {
  const [row] = await q<{ id: string }>(
    `insert into focus_sessions (user_id, goal, status, metadata)
     values ($1, 'Capture · Lunch with Alice', 'active', $2::jsonb) returning id`,
    [
      userId,
      JSON.stringify({ intake: { door: "capture", correlationKey: "k1" } }),
    ]
  );
  return row!.id;
}

/** Read the part back off the stored row, through the contract's reader. */
async function resultPartOf(messageId: string): Promise<CaptureResultPart> {
  const [row] = await q<{ metadata: unknown }>(
    `select metadata from messages where id = $1`,
    [messageId]
  );
  const part = readCapturePart(row?.metadata);
  if (part?.kind !== "capture_result") {
    throw new Error(`no capture_result part on ${messageId}`);
  }
  return part;
}

const PROPOSALS = [
  { tempId: "t1", profileSlug: "contact", title: "Alice Martin" },
  { tempId: "t2", profileSlug: "task", title: "Follow up with Alice" },
];

describe("persistCaptureResult — the rows reach the room and read back", () => {
  it("writes a part whose rows carry tempId, slug, title, why=null and updatesExisting from the pod's own dedup", async () => {
    const sessionId = await seedSession();
    const { messageId, channelId, round } = await persistCaptureResult({
      sessionId,
      userId: USER,
      proposals: PROPOSALS,
      dedupCandidates: { t2: [{ entityId: "e-9" }] },
      dedupSkipped: false,
    });

    expect(round).toBe(1);
    const part = await resultPartOf(messageId);
    expect(part).toMatchObject({
      kind: "capture_result",
      v: 1,
      sessionId,
      round: 1,
      truncated: false,
      notice: null,
    });
    expect(part.rows).toEqual([
      {
        tempId: "t1",
        profileSlug: "contact",
        title: "Alice Martin",
        why: null,
        updatesExisting: false,
        dismissed: false,
      },
      {
        tempId: "t2",
        profileSlug: "task",
        title: "Follow up with Alice",
        why: null,
        updatesExisting: true,
        dismissed: false,
      },
    ]);

    // It landed in THE session's room, and the room is live.
    const [session] = await q<{ channel_id: string }>(
      `select channel_id from focus_sessions where id = $1`,
      [sessionId]
    );
    expect(session!.channel_id).toBe(channelId);
    expect(holder.emitted.map((e) => e.event)).toContain("chat:message");
  });

  it("round MATCHES the question's round for the same run", async () => {
    const sessionId = await seedSession();
    const asked = await persistCaptureQuestion({
      sessionId,
      userId: USER,
      followUp: "Which Alice?",
      partialCount: 1,
      refine: { text: "Lunch with Alice" },
    });
    expect(asked.status === "persisted" && asked.round).toBe(1);

    const { messageId } = await persistCaptureResult({
      sessionId,
      userId: USER,
      proposals: PROPOSALS,
      dedupCandidates: {},
      dedupSkipped: false,
    });
    expect((await resultPartOf(messageId)).round).toBe(1);
  });

  it("past the row bound it REPORTS truncation instead of dropping rows in silence", async () => {
    const sessionId = await seedSession();
    const many = Array.from(
      { length: CAPTURE_RESULT_LIMITS.rowsMax + 3 },
      (_, i) => ({ tempId: `t${i}`, profileSlug: "note", title: `Note ${i}` })
    );
    const { messageId } = await persistCaptureResult({
      sessionId,
      userId: USER,
      proposals: many,
      dedupCandidates: {},
      dedupSkipped: false,
    });
    const part = await resultPartOf(messageId);
    expect(part.rows).toHaveLength(CAPTURE_RESULT_LIMITS.rowsMax);
    expect(part.truncated).toBe(true);
  });

  it("a SKIPPED dedup is not an empty one: notice says so and nothing claims a match", async () => {
    const sessionId = await seedSession();
    const { messageId } = await persistCaptureResult({
      sessionId,
      userId: USER,
      proposals: PROPOSALS,
      // Candidates present but the search threw for at least one entity.
      dedupCandidates: { t2: [{ entityId: "e-9" }] },
      dedupSkipped: true,
    });
    const part = await resultPartOf(messageId);
    expect(part.notice).toBe(DEDUP_SKIPPED_NOTICE);
    expect(part.rows.map((r) => r.updatesExisting)).toEqual([false, false]);
  });

  it("an identical re-run inserts nothing; a CHANGED re-run appends a newest part and CARRIES dismissals forward", async () => {
    const sessionId = await seedSession();
    const first = await persistCaptureResult({
      sessionId,
      userId: USER,
      proposals: PROPOSALS,
      dedupCandidates: {},
      dedupSkipped: false,
    });
    const again = await persistCaptureResult({
      sessionId,
      userId: USER,
      proposals: PROPOSALS,
      dedupCandidates: {},
      dedupSkipped: false,
    });
    expect(again.messageId).toBe(first.messageId);
    expect(await countResults()).toBe(1);

    await dismissCaptureResultRow({
      userId: USER,
      sessionId,
      tempId: "t1",
      dismissed: true,
    });

    const refined = await persistCaptureResult({
      sessionId,
      userId: USER,
      proposals: [
        ...PROPOSALS,
        { tempId: "t3", profileSlug: "note", title: "Sushi place" },
      ],
      dedupCandidates: {},
      dedupSkipped: false,
    });
    expect(refined.messageId).not.toBe(first.messageId);
    expect(await countResults()).toBe(2);
    const part = await resultPartOf(refined.messageId);
    expect(part.rows.map((r) => [r.tempId, r.dismissed])).toEqual([
      ["t1", true],
      ["t2", false],
      ["t3", false],
    ]);
  });

  it("ROUND INCREASES across re-structures, so a superseded verdict never ties with the live one", async () => {
    const sessionId = await seedSession();
    const runs = [
      PROPOSALS,
      [...PROPOSALS, { tempId: "t3", profileSlug: "note", title: "Sushi" }],
      [{ tempId: "t9", profileSlug: "task", title: "Book a table" }],
    ];
    const rounds: number[] = [];
    for (const proposals of runs) {
      const { messageId } = await persistCaptureResult({
        sessionId,
        userId: USER,
        proposals,
        dedupCandidates: {},
        dedupSkipped: false,
      });
      rounds.push((await resultPartOf(messageId)).round);
    }
    expect(rounds).toEqual([1, 2, 3]);

    // The reader's rule — highest round wins — now picks the LIVE verdict.
    const stored = await q<{ round: number; rows: string }>(
      `select (metadata -> 'capturePart' ->> 'round')::int as round,
              metadata -> 'capturePart' ->> 'rows' as rows
         from messages
        where metadata -> 'capturePart' ->> 'kind' = 'capture_result'
        order by round desc limit 1`
    );
    expect(stored[0]!.round).toBe(3);
    expect(stored[0]!.rows).toContain("Book a table");
  });

  it("a re-structure with an UNCHANGED verdict does not burn a round", async () => {
    const sessionId = await seedSession();
    const first = await persistCaptureResult({
      sessionId,
      userId: USER,
      proposals: PROPOSALS,
      dedupCandidates: {},
      dedupSkipped: false,
    });
    const same = await persistCaptureResult({
      sessionId,
      userId: USER,
      proposals: PROPOSALS,
      dedupCandidates: {},
      dedupSkipped: false,
    });
    expect(same).toEqual(first);
    expect(same.round).toBe(1);
    expect(await countResults()).toBe(1);
  });

  it("an ANSWERED follow-up's result still lands on the question's round", async () => {
    const sessionId = await seedSession();
    const asked = await persistCaptureQuestion({
      sessionId,
      userId: USER,
      followUp: "Which Alice?",
      partialCount: 1,
      refine: { text: "Lunch with Alice" },
    });
    expect(asked.status === "persisted" && asked.round).toBe(1);
    // The re-run after the answer is the FIRST result this room ever gets.
    const { messageId } = await persistCaptureResult({
      sessionId,
      userId: USER,
      proposals: PROPOSALS,
      dedupCandidates: {},
      dedupSkipped: false,
    });
    expect((await resultPartOf(messageId)).round).toBe(1);
  });
});

describe("dismissResultRow — one fact, one home", () => {
  it("toggles the newest part's row, is idempotent, and restores", async () => {
    const sessionId = await seedSession();
    const { messageId } = await persistCaptureResult({
      sessionId,
      userId: USER,
      proposals: PROPOSALS,
      dedupCandidates: {},
      dedupSkipped: false,
    });

    const off = await dismissCaptureResultRow({
      userId: USER,
      sessionId,
      tempId: "t2",
      dismissed: true,
    });
    expect(off).toMatchObject({ messageId, round: 1, changed: true });
    expect(
      (await resultPartOf(messageId)).rows.map((r) => r.dismissed)
    ).toEqual([false, true]);

    const repeat = await dismissCaptureResultRow({
      userId: USER,
      sessionId,
      tempId: "t2",
      dismissed: true,
    });
    expect(repeat).toMatchObject({ changed: false, dismissed: true });
    expect(
      (await resultPartOf(messageId)).rows.map((r) => r.dismissed)
    ).toEqual([false, true]);

    await dismissCaptureResultRow({
      userId: USER,
      sessionId,
      tempId: "t2",
      dismissed: false,
    });
    expect(
      (await resultPartOf(messageId)).rows.map((r) => r.dismissed)
    ).toEqual([false, false]);
  });

  it("a session you do not own, and a tempId that is not there, are the SAME NOT_FOUND", async () => {
    const mine = await seedSession();
    await persistCaptureResult({
      sessionId: mine,
      userId: USER,
      proposals: PROPOSALS,
      dedupCandidates: {},
      dedupSkipped: false,
    });
    const theirs = await seedSession(OTHER);

    for (const args of [
      { userId: OTHER, sessionId: mine, tempId: "t1" },
      { userId: USER, sessionId: theirs, tempId: "t1" },
      { userId: USER, sessionId: mine, tempId: "nope" },
    ]) {
      await expect(
        dismissCaptureResultRow({ ...args, dismissed: true })
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    // The owner's rows are untouched by any of that.
    const [row] = await q<{ metadata: unknown }>(
      `select metadata from messages where metadata -> 'capturePart' ->> 'kind' = 'capture_result'`
    );
    const part = readCapturePart(row!.metadata);
    expect(
      part?.kind === "capture_result" && part.rows.every((r) => !r.dismissed)
    ).toBe(true);
  });

  it("a session with no result part at all is NOT_FOUND, not a crash", async () => {
    const sessionId = await seedSession();
    await expect(
      dismissCaptureResultRow({
        userId: USER,
        sessionId,
        tempId: "t1",
        dismissed: true,
      })
    ).rejects.toBeInstanceOf(TRPCError);
  });
});

describe("projectCaptureResultRows — pure projection", () => {
  it("never invents a why, and bounds the title", () => {
    const { rows, truncated } = projectCaptureResultRows({
      proposals: [{ tempId: "t1", profileSlug: null, title: "x".repeat(1000) }],
      matchedTempIds: new Set(),
      dismissedTempIds: new Set(["t1"]),
    });
    expect(truncated).toBe(false);
    expect(rows[0]!.why).toBeNull();
    expect(rows[0]!.title).toHaveLength(CAPTURE_RESULT_LIMITS.titleMaxChars);
    expect(rows[0]!.profileSlug).toBe("item");
    expect(rows[0]!.dismissed).toBe(true);
  });
});

async function countResults(): Promise<number> {
  const [row] = await q<{ n: number }>(
    `select count(*)::int as n from messages where metadata -> 'capturePart' ->> 'kind' = 'capture_result'`
  );
  return row!.n;
}
