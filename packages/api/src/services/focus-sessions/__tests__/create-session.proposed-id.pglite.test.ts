/**
 * A held session start lands under the id its proposal names.
 *
 * Live (2026-10-27): held-writes pack f151958b kept a session start as
 * `data.id` 4f824834; on approval the replay called `createFocusSession`,
 * which minted a new id, and the session landed as 8ba020af. The id the
 * proposal (and the agent that read it) named opened as "not found".
 *
 * The replay now passes the held id back as `proposedSessionId` (asserted in
 * `deferred-writes.pglite.test.ts`). This file holds the door's side of the
 * contract, the same as `proposedEntityId` / `proposedDocumentId` (#381):
 *   - a free id is the id the row lands under, and the one the gate is given;
 *   - the caller's own row already at that id is returned (a replay run
 *     twice), never a second row;
 *   - anyone else's row at that id is left alone, and a fresh id is minted.
 *
 * Real: `createFocusSession` on PGlite. Stubbed: governance (records what it
 * was handed), room, realtime, project placement (same harness as
 * create-session.derived-title).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  permData: [] as Array<Record<string, unknown>>,
  permResult: { granted: true } as Record<string, unknown>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return {
    ...actual,
    db: drizzle(client, { schema }),
    recordSessionSpawn: async () => ({
      linked: false,
      suspendedIntentRecorded: false,
    }),
    resolveSessionProjectPlacement: async () => ({ projectId: null }),
  };
});
vi.mock("../../../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    checkPermissionOrPropose: async (args: {
      data: Record<string, unknown>;
    }) => {
      h.permData.push(args.data);
      return h.permResult;
    },
  };
});
vi.mock("../ensure-session-channel.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, ensureSessionChannel: async () => null };
});
vi.mock("../../../utils/domain-event-bridge.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, emitHubRealtimeEvent: () => undefined };
});

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { createFocusSession } from "../create-session.js";

const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = t.endsWith("[]") ? t : BASIC.test(t) ? t : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const rowsAt = async (id: string) =>
  (
    await h.client!.query<{ user_id: string; goal: string }>(
      `select user_id, goal from focus_sessions where id = $1`,
      [id]
    )
  ).rows;

const countGoal = async (goal: string) =>
  (
    await h.client!.query<{ n: number }>(
      `select count(*)::int as n from focus_sessions where goal = $1`,
      [goal]
    )
  ).rows[0]!.n;

/** The start a held-writes replay makes: the person, the agent, the held id. */
const replayStart = (proposedSessionId: string, goal: string) =>
  createFocusSession({
    userId: USER,
    agentUserId: AGENT,
    goal,
    proposedSessionId,
    matchTemplate: false,
    // So the per-goal twin check cannot hide the id check: a replay of a
    // template run skips that check the same way.
    forceCreate: true,
  });

beforeAll(async () => {
  for (const t of Object.values(schema)) {
    if (is(t, PgTable)) await h.client!.exec(ddlFor(t));
  }
  await h.client!.query(
    `insert into users (id, email, name, user_type) values
      ($1, 'a@x.test', 'Antoine', 'human'),
      ($2, 'g@x.test', 'Agent', 'agent'),
      ($3, 'o@x.test', 'Someone else', 'human')`,
    [USER, AGENT, OTHER]
  );
}, 120_000);

beforeEach(() => {
  h.permData.length = 0;
  h.permResult = { granted: true };
});

describe("createFocusSession — a held start keeps the id it was handed", () => {
  it("the session lands under the held id, and the gate is handed that id", async () => {
    const handed = randomUUID();
    const goal = `Land under the held id ${handed}`;

    const res = await replayStart(handed, goal);

    expect(res.status).toBe("created");
    if (res.status === "created") expect(res.session.id).toBe(handed);
    expect(await rowsAt(handed)).toEqual([{ user_id: USER, goal }]);
    expect(h.permData[0]!.id).toBe(handed);
  });

  it("a replay run twice returns the first row, never a second one", async () => {
    const handed = randomUUID();
    const goal = `Replayed twice ${handed}`;

    await replayStart(handed, goal);
    const again = await replayStart(handed, goal);

    expect(again.status).toBe("created");
    if (again.status === "created") expect(again.session.id).toBe(handed);
    expect(await countGoal(goal)).toBe(1);
    // The second call wrote nothing: it never reached the gate.
    expect(h.permData).toHaveLength(1);
  });

  it("an id that is someone else's row is not reused: a fresh id, their row untouched", async () => {
    const theirs = randomUUID();
    await h.client!.query(
      `insert into focus_sessions (id, user_id, goal, status) values ($1, $2, 'Their own work', 'active')`,
      [theirs, OTHER]
    );
    const goal = `Not on their id ${theirs}`;

    const res = await replayStart(theirs, goal);

    expect(res.status).toBe("created");
    if (res.status !== "created") return;
    expect(res.session.id).not.toBe(theirs);
    expect(res.session.userId).toBe(USER);
    expect(await rowsAt(theirs)).toEqual([
      { user_id: OTHER, goal: "Their own work" },
    ]);
    expect(h.permData[0]!.id).toBe(res.session.id);
  });

  it("a replay the ladder files as a proposal carries the held id as its prospective id", async () => {
    h.permResult = {
      proposalId: randomUUID(),
      proposalType: "focus_session.create",
    };
    const handed = randomUUID();

    const res = await replayStart(handed, `Needs review again ${handed}`);

    expect(res.status).toBe("proposed");
    expect(h.permData[0]!.id).toBe(handed);
    expect(await rowsAt(handed)).toEqual([]);
  });
});
