/**
 * Writes held past an agent's daily ceiling are replayed, once the person
 * approves the pack, each through ITS OWN DOOR as the agent
 * (`replayDeferredWrites`).
 *
 * Real, on PGlite: the replay engine and the outcome records. Stubbed: the
 * replay DOORS (`entities.create/update/moveToWorkspace`, hub
 * `createDocument`, `createFocusSession`) → recorders of what a door would
 * see (the acting agent, the caller, the session, the input). NOT covered
 * here: the doors' own gate running the full ladder on replay
 * (NEEDS-DOGFOOD); the gate filing the pack (`ceiling-pack.pglite.test.ts`).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  doorCalls: [] as Array<{
    door: string;
    input: Record<string, unknown>;
    actingAgent: string | undefined;
    /** `ctx.userId` of the door's caller: who the written row belongs to. */
    callerUserId: unknown;
    sessionId: unknown;
  }>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, {
    schema: {
      proposals: actual.proposals as never,
      users: actual.users as never,
      workspaces: actual.workspaces as never,
      focusSessions: actual.focusSessions as never,
    },
  });
  return { ...actual, db: h.db, getDb: async () => h.db };
});

vi.mock("../../utils/audit-log.js", () => ({
  auditLog: async () => ({ id: randomUUID() }),
}));

async function recordDoor(
  door: string,
  ctx: Record<string, unknown> | null,
  input: Record<string, unknown>
): Promise<unknown> {
  const { getActingAgentUserId } = await import("@synap/database");
  h.doorCalls.push({
    door,
    input,
    actingAgent: getActingAgentUserId(),
    callerUserId: ctx?.userId ?? null,
    sessionId: ctx?.sessionId ?? null,
  });
  return { status: "created", id: randomUUID() };
}

vi.mock("../../routers/entities.js", () => ({
  entitiesRouter: {
    createCaller: (ctx: Record<string, unknown>) => ({
      create: (input: Record<string, unknown>) =>
        recordDoor("entity/create", ctx, input),
      update: (input: Record<string, unknown>) =>
        recordDoor("entity/update", ctx, input),
      moveToWorkspace: async (input: Record<string, unknown>) => {
        await recordDoor("entity/move", ctx, input);
        return {
          moved: input.entityIds as string[],
          proposed: [],
          errors: [],
        };
      },
    }),
  },
}));

vi.mock("../../routers/hub-protocol/documents.js", () => ({
  documentsRouter: {
    createCaller: (ctx: Record<string, unknown>) => ({
      createDocument: (input: Record<string, unknown>) =>
        recordDoor("document/create", ctx, input),
    }),
  },
}));

vi.mock("../focus-sessions/create-session.js", () => ({
  createFocusSession: (params: Record<string, unknown>) =>
    recordDoor("focus_session/create", null, params),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { proposals, users, workspaces, focusSessions } from "@synap/database";
import type { DeferredWrite } from "@synap-core/types/proposals/deferred-writes";
import {
  recordRejectedDeferredWrites,
  replayDeferredWrites,
} from "./deferred-writes.js";

const HUMAN = randomUUID();
const AGENT = randomUUID();
const WS = randomUUID();
const OTHER_WS = randomUUID();
const SESSION = randomUUID();
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t : "text";
    const def = c.name.endsWith("_at") ? " default now()" : "";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

beforeAll(async () => {
  for (const t of [proposals, users, workspaces, focusSessions])
    await h.client!.exec(ddlFor(t as PgTable));
  await q(
    `insert into users (id, email, name, user_type) values ($1, 'h@x', 'Human', 'human'), ($2, 'a@x', 'Scout', 'agent')`,
    [HUMAN, AGENT]
  );
});

beforeEach(async () => {
  await q(`delete from proposals`);
  h.doorCalls.length = 0;
});

/** One write as the gate keeps it (`buildDeferredWrite`). */
function kept(
  subjectType: string,
  action: string,
  data: Record<string, unknown>,
  over: Partial<DeferredWrite> = {}
): DeferredWrite {
  return {
    ref: randomUUID(),
    subjectType,
    action,
    data,
    sessionId: SESSION,
    agentUserId: AGENT,
    userId: HUMAN,
    at: new Date().toISOString(),
    fingerprint: randomUUID(),
    workspaceId: WS,
    ...over,
  };
}

/** Today's pack holding `writes`, as the gate files it. */
async function pack(
  writes: DeferredWrite[],
  extra: Record<string, unknown> = {}
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into proposals (id, status, proposal_type, target_type, target_id, agent_user_id, data)
     values ($1, 'approved', 'held_writes', 'agent', $2, $2, $3::jsonb)`,
    [id, AGENT, JSON.stringify({ deferredWrites: writes, ...extra })]
  );
  return id;
}

async function outcomesOf(id: string) {
  const { rows } = await q<{ data: Record<string, unknown> }>(
    `select data from proposals where id = $1`,
    [id]
  );
  return (rows[0]!.data.deferredOutcomes ?? {}) as Record<
    string,
    { outcome: string; id?: string }
  >;
}

describe("replaying an approved held-writes pack", () => {
  it("replays each write through its door, as the agent, in its own space", async () => {
    const note = kept("entity", "create", { id: randomUUID(), title: "Note" });
    const moved = kept(
      "entity",
      "create",
      { id: randomUUID(), title: "Elsewhere" },
      { workspaceId: OTHER_WS }
    );
    const id = await pack([note, moved]);

    await replayDeferredWrites({ proposalId: id });

    expect(h.doorCalls.map((c) => c.door)).toEqual([
      "entity/create",
      "entity/create",
    ]);
    for (const c of h.doorCalls) {
      expect(c).toMatchObject({
        actingAgent: AGENT,
        callerUserId: HUMAN,
        sessionId: SESSION,
      });
    }
    const outcomes = await outcomesOf(id);
    expect(outcomes[note.ref]!.outcome).toBe("applied");
    expect(outcomes[moved.ref]!.outcome).toBe("applied");
  });

  it("a kept document is replayed for its PERSON, not the agent (4a021e44)", async () => {
    // The document door gates as the agent (so the kept `userId` is the
    // agent) and carries its person in data.
    const doc = kept(
      "document",
      "create",
      {
        id: randomUUID(),
        title: "Plan v3",
        type: "markdown",
        content: "# Plan",
        workspaceId: WS,
        userId: HUMAN,
      },
      { userId: AGENT }
    );
    await replayDeferredWrites({ proposalId: await pack([doc]) });

    expect(h.doorCalls.map((c) => c.door)).toEqual(["document/create"]);
    expect(h.doorCalls[0]!.callerUserId).toBe(HUMAN);
    expect(h.doorCalls[0]!.actingAgent).toBe(AGENT);
    expect(h.doorCalls[0]!.input).toMatchObject({
      userId: HUMAN,
      agentUserId: AGENT,
      title: "Plan v3",
    });
  });

  it("a kept document and a session start land under the ids the agent was handed (d50550c2, f151958b)", async () => {
    const docId = randomUUID();
    const sessionId = randomUUID();
    await replayDeferredWrites({
      proposalId: await pack([
        kept("document", "create", {
          id: docId,
          title: "State of the work",
          content: "Five lines.",
          workspaceId: WS,
          userId: HUMAN,
        }),
        kept("focus_session", "create", {
          id: sessionId,
          goal: "No AI request reaches DeepSeek before consent",
        }),
      ]),
    });

    expect(h.doorCalls.map((c) => c.door)).toEqual([
      "document/create",
      "focus_session/create",
    ]);
    expect(h.doorCalls[0]!.input).toMatchObject({ proposedDocumentId: docId });
    expect(h.doorCalls[1]!.input).toMatchObject({
      proposedSessionId: sessionId,
    });
  });

  it("a kept move replays the MOVE, never a field update (cf54ebb0)", async () => {
    const entityId = randomUUID();
    const w = kept("entity", "update", {
      id: entityId,
      toWorkspaceId: OTHER_WS,
    });
    const id = await pack([w]);

    await replayDeferredWrites({ proposalId: id });

    expect(h.doorCalls.map((c) => c.door)).toEqual(["entity/move"]);
    expect(h.doorCalls[0]!.input).toEqual({
      entityIds: [entityId],
      workspaceId: OTHER_WS,
    });
    expect((await outcomesOf(id))[w.ref]).toMatchObject({
      outcome: "applied",
      id: entityId,
    });
  });

  it("a write the reviewer dropped is skipped, and a second replay runs nothing again", async () => {
    const keep = kept("entity", "create", { id: randomUUID(), title: "keep" });
    const drop = kept("entity", "create", { id: randomUUID(), title: "drop" });
    const id = await pack([keep, drop], {
      dispositions: { [drop.ref]: { status: "reject" } },
    });

    await replayDeferredWrites({ proposalId: id });
    await replayDeferredWrites({ proposalId: id });

    expect(h.doorCalls).toHaveLength(1);
    expect(h.doorCalls[0]!.input).toMatchObject({ title: "keep" });
    expect((await outcomesOf(id))[drop.ref]!.outcome).toBe(
      "skipped_by_reviewer"
    );
  });

  it("a rejected pack records `rejected` for every kept write — nothing replays", async () => {
    const writes = [
      kept("entity", "create", { id: randomUUID(), title: "a" }),
      kept("entity", "create", { id: randomUUID(), title: "b" }),
    ];
    const id = await pack(writes);
    await q(`update proposals set status = 'rejected' where id = $1`, [id]);

    await recordRejectedDeferredWrites(id);

    const outcomes = Object.values(await outcomesOf(id));
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => o.outcome === "rejected")).toBe(true);
    expect(h.doorCalls).toHaveLength(0);
  });
});
