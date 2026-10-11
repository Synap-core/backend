/**
 * CAPTURE FILED PART — what `capture.execute` did with the accepted rows is
 * written into the capture room and read back, on a real Postgres (PGlite).
 *
 * Driven through the real `persistCaptureFiled` → `recordCapturePartMessage`,
 * with the room minted by the real `persistCaptureResult`. Every assertion reads
 * the ROW back through the contract's own `readCapturePart`, so a part that does
 * not satisfy `CaptureFiledPartSchema` fails here.
 *
 * Stubbed: `emitChatEvent` (realtime fan-out).
 *
 * NOT covered here: `capture.execute` end to end (governance, materializer,
 * identity resolution — no harness drives it). That every execute exit writes
 * the receipt, and that `created[].action` comes from the same
 * `captureRowAction`, is pinned against the source by
 * `capture-filed-wiring.tripwire.test.ts`.
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
  type CaptureFiledPart,
} from "@synap-core/types/capture";
import { persistCaptureResult } from "../capture-result-part.js";
import { ensureSessionChannel } from "../../focus-sessions/ensure-session-channel.js";
import {
  buildCaptureFiledRows,
  captureRowAction,
  filedSummary,
  persistCaptureFiled,
} from "../capture-filed-part.js";

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

async function filedParts(channelId: string): Promise<CaptureFiledPart[]> {
  const rows = await q<{ metadata: unknown }>(
    `select metadata from messages where channel_id = $1 order by timestamp`,
    [channelId]
  );
  return rows
    .map((r) => readCapturePart(r.metadata))
    .filter((p): p is CaptureFiledPart => p?.kind === "capture_filed");
}

async function seedCaptureRoom(): Promise<{
  sessionId: string;
  channelId: string;
}> {
  const sessionId = await seedSession();
  const { channelId } = await persistCaptureResult({
    sessionId,
    userId: USER,
    proposals: OPS.map((o) => ({ ...o, profileSlug: "contact" })),
    dedupCandidates: {},
    dedupSkipped: false,
  });
  return { sessionId, channelId };
}

const OPS = [
  { tempId: "t1", title: "Alice Martin" },
  { tempId: "t2", title: "Acme" },
  { tempId: "t3", title: "Bob Lee" },
  { tempId: "t4", title: "Acme — new address" },
  { tempId: "t5", title: "Book the venue" },
];

const APPLIED = {
  kind: "applied" as const,
  created: [
    { tempId: "t1", entityId: "e-1", linked: false },
    { tempId: "t2", entityId: "e-2", linked: true },
    {
      tempId: "t3",
      entityId: "e-3",
      linked: true,
      deduplicated: true as const,
    },
    { tempId: "t4", entityId: "e-4", linked: true },
  ],
  updated: [{ tempId: "t4", entityId: "e-4", status: "applied" as const }],
};

describe("captureRowAction — the one derivation", () => {
  it("names each applied row by what it did", () => {
    expect(captureRowAction({ linked: false })).toBe("created");
    expect(captureRowAction({ linked: true })).toBe("linked");
    expect(captureRowAction({ linked: true, deduplicated: true })).toBe(
      "matched"
    );
    expect(captureRowAction({ linked: true }, { status: "applied" })).toBe(
      "updated"
    );
  });

  it("a patch that did not land leaves the row linked, never updated", () => {
    expect(captureRowAction({ linked: true }, { status: "proposed" })).toBe(
      "linked"
    );
    expect(captureRowAction({ linked: true }, { status: "failed" })).toBe(
      "linked"
    );
  });

  it("execute's action and the filed outcome agree on every applied row", () => {
    const { rows } = buildCaptureFiledRows(OPS, APPLIED);
    const updates = new Map(APPLIED.updated.map((u) => [u.tempId, u]));
    for (const echo of APPLIED.created) {
      const row = rows.find((r) => r.tempId === echo.tempId)!;
      expect(row.outcome).toBe(
        captureRowAction(echo, updates.get(echo.tempId))
      );
    }
  });
});

describe("buildCaptureFiledRows", () => {
  it("one row per accepted op, with the id it became and the title sent", () => {
    const { rows, truncated } = buildCaptureFiledRows(OPS, APPLIED);
    expect(truncated).toBe(false);
    expect(rows).toEqual([
      {
        tempId: "t1",
        title: "Alice Martin",
        entityId: "e-1",
        proposalId: null,
        outcome: "created",
      },
      {
        tempId: "t2",
        title: "Acme",
        entityId: "e-2",
        proposalId: null,
        outcome: "linked",
      },
      {
        tempId: "t3",
        title: "Bob Lee",
        entityId: "e-3",
        proposalId: null,
        outcome: "matched",
      },
      {
        tempId: "t4",
        title: "Acme — new address",
        entityId: "e-4",
        proposalId: null,
        outcome: "updated",
      },
      // Accepted, applied path, but the pod echoed nothing: never assumed filed.
      {
        tempId: "t5",
        title: "Book the venue",
        entityId: null,
        proposalId: null,
        outcome: "failed",
      },
    ]);
  });

  it("a governance hold names its review on every row; a parked patch keeps its target", () => {
    const { rows } = buildCaptureFiledRows(OPS.slice(0, 2), {
      kind: "proposed",
      proposalId: "p-1",
      updated: [
        {
          tempId: "t2",
          entityId: "e-2",
          status: "proposed",
          proposalId: "p-2",
        },
      ],
    });
    expect(rows).toEqual([
      {
        tempId: "t1",
        title: "Alice Martin",
        entityId: null,
        proposalId: "p-1",
        outcome: "proposed",
      },
      {
        tempId: "t2",
        title: "Acme",
        entityId: "e-2",
        proposalId: "p-2",
        outcome: "proposed",
      },
    ]);
  });

  it("bounds the rows and says so", () => {
    const many = Array.from(
      { length: CAPTURE_RESULT_LIMITS.rowsMax + 3 },
      (_, i) => ({ tempId: `t${i}`, title: `Row ${i}` })
    );
    const { rows, truncated } = buildCaptureFiledRows(many, {
      kind: "proposed",
      proposalId: null,
    });
    expect(rows).toHaveLength(CAPTURE_RESULT_LIMITS.rowsMax);
    expect(truncated).toBe(true);
  });

  it("the summary counts what was filed, held and missed", () => {
    expect(filedSummary(buildCaptureFiledRows(OPS, APPLIED).rows)).toBe(
      "Filed 4 · 1 not filed"
    );
    expect(filedSummary([])).toBe("Nothing filed");
  });
});

describe("persistCaptureFiled — the room's receipt", () => {
  it("writes the receipt into the capture room, read back with every value", async () => {
    const { sessionId, channelId } = await seedCaptureRoom();
    const res = await persistCaptureFiled({
      sessionId,
      userId: USER,
      ops: OPS,
      outcome: APPLIED,
      workspaceId: "ws-1",
      projectId: "proj-1",
      idempotencyKey: "accept-1",
    });
    expect(res).toMatchObject({ status: "written", round: 1, inserted: true });

    const parts = await filedParts(channelId);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({
      kind: "capture_filed",
      v: 1,
      sessionId,
      round: 1,
      rows: buildCaptureFiledRows(OPS, APPLIED).rows,
      truncated: false,
      workspaceId: "ws-1",
      projectId: "proj-1",
    });
    expect(parts[0]!.rows.map((r) => r.outcome)).toEqual([
      "created",
      "linked",
      "matched",
      "updated",
      "failed",
    ]);
    const [msg] = await q<{ content: string; role: string }>(
      `select content, role from messages where id = $1`,
      [res.status === "written" ? res.messageId : ""]
    );
    expect(msg).toEqual({
      content: "Filed 4 · 1 not filed",
      role: "assistant",
    });
  });

  it("re-executing the same accept posts nothing new", async () => {
    const { sessionId, channelId } = await seedCaptureRoom();
    const input = {
      sessionId,
      userId: USER,
      ops: OPS,
      outcome: APPLIED,
      workspaceId: null,
      projectId: null,
      idempotencyKey: "accept-1",
    };
    const first = await persistCaptureFiled(input);
    const again = await persistCaptureFiled(input);
    expect(first).toMatchObject({ inserted: true });
    expect(again).toMatchObject({ inserted: false });
    expect(await filedParts(channelId)).toHaveLength(1);
    expect(
      holder.emitted.filter((e) => JSON.stringify(e).includes("capture_filed"))
    ).toHaveLength(1);
  });

  it("without a key, an identical retry is still a no-op; a different accept is a new receipt", async () => {
    const { sessionId, channelId } = await seedCaptureRoom();
    const base = {
      sessionId,
      userId: USER,
      workspaceId: null,
      projectId: null,
    };
    await persistCaptureFiled({ ...base, ops: OPS, outcome: APPLIED });
    await persistCaptureFiled({ ...base, ops: OPS, outcome: APPLIED });
    expect(await filedParts(channelId)).toHaveLength(1);
    await persistCaptureFiled({
      ...base,
      ops: OPS.slice(4),
      outcome: { kind: "proposed", proposalId: "p-9" },
    });
    const parts = await filedParts(channelId);
    expect(parts).toHaveLength(2);
    expect(parts[1]!.rows).toEqual([
      {
        tempId: "t5",
        title: "Book the venue",
        entityId: null,
        proposalId: "p-9",
        outcome: "proposed",
      },
    ]);
  });

  it("records the round the caller names, else the room's newest", async () => {
    const { sessionId, channelId } = await seedCaptureRoom();
    await persistCaptureFiled({
      sessionId,
      userId: USER,
      ops: OPS.slice(0, 1),
      outcome: APPLIED,
      workspaceId: null,
      projectId: null,
      round: 3,
    });
    expect((await filedParts(channelId))[0]!.round).toBe(3);
  });

  it("skips a session with no room", async () => {
    const sessionId = await seedSession();
    const res = await persistCaptureFiled({
      sessionId,
      userId: USER,
      ops: OPS,
      outcome: APPLIED,
      workspaceId: null,
      projectId: null,
    });
    expect(res).toEqual({ status: "skipped", reason: "no_room" });
    expect(await q(`select id from messages`)).toHaveLength(0);
  });

  it("skips a room that holds no capture result — a work session is not a capture thread", async () => {
    const sessionId = await seedSession();
    const channelId = await ensureSessionChannel({ sessionId, userId: USER });
    expect(channelId).toBeTruthy();
    const res = await persistCaptureFiled({
      sessionId,
      userId: USER,
      ops: OPS,
      outcome: APPLIED,
      workspaceId: null,
      projectId: null,
    });
    expect(res).toEqual({ status: "skipped", reason: "not_a_capture_room" });
    expect(await filedParts(channelId!)).toHaveLength(0);
  });

  it("never writes into another person's session", async () => {
    const { sessionId, channelId } = await seedCaptureRoom();
    const res = await persistCaptureFiled({
      sessionId,
      userId: OTHER,
      ops: OPS,
      outcome: APPLIED,
      workspaceId: null,
      projectId: null,
    });
    expect(res).toEqual({ status: "skipped", reason: "no_room" });
    expect(await filedParts(channelId)).toHaveLength(0);
  });
});
