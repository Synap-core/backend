/**
 * #6 — writes into a space the agent has not joined are KEPT on the join, and
 * replayed as the agent once the join is approved.
 *
 * Real, on PGlite: the gate (`checkPermissionOrPropose` → the join branch →
 * `appendDeferredWrite`), the `workspace/join` executor (membership in the
 * approval transaction), and the replay engine (`replayDeferredWrites`).
 *
 * Stubbed, and why:
 *   - `createEventBackedProposal` → a plain proposals insert of the SAME row
 *     fields: the event spine and notification fan-out have their own suites,
 *     and what this file asserts is the `data` the gate hands it.
 *   - the four replay DOORS (`entities.create/update`, hub `createDocument`,
 *     `createFocusSession`) → recorders. They capture what a door would see —
 *     the acting agent, the session, whether the membership row exists at that
 *     moment — and answer as the ladder could (applied / proposed / refused).
 *     NOT covered here: the doors' own gate running the full ladder on replay
 *     (NEEDS-DOGFOOD).
 *   - `auditLog` → returns an id (the `.validated` event has its own tests).
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
    sessionId: unknown;
    isMember: boolean;
  }>,
  /** Per-door scripted answer. */
  answers: {} as Record<string, () => unknown>,
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
      workspaceMembers: actual.workspaceMembers as never,
      focusSessions: actual.focusSessions as never,
    },
  });
  return { ...actual, db: h.db, getDb: async () => h.db };
});

vi.mock("../../utils/event-backed-proposal.js", () => ({
  createEventBackedProposal: async (input: Record<string, unknown>) => {
    const id = randomUUID();
    await h.client!.query(
      `insert into proposals (id, status, proposal_type, target_type, target_id, workspace_id, agent_user_id, created_by, session_id, data, created_at, updated_at)
       values ($1, 'pending', $2, $3, $4, $5, $6, $7, $8, $9::jsonb, now(), now())`,
      [
        id,
        input.proposalType,
        input.targetType,
        input.targetId,
        input.workspaceId,
        input.agentUserId,
        input.createdBy,
        input.sessionId ?? null,
        JSON.stringify(input.data),
      ]
    );
    return { proposal: { id } };
  },
}));

vi.mock("../../utils/audit-log.js", () => ({
  auditLog: async () => ({ id: randomUUID() }),
}));

async function recordDoor(
  door: string,
  ctx: Record<string, unknown> | null,
  input: Record<string, unknown>,
  workspaceId: string,
  agentUserId: string
): Promise<unknown> {
  const { getActingAgentUserId } = await import("@synap/database");
  const { rows } = await h.client!.query<{ n: number }>(
    `select count(*)::int as n from workspace_members where workspace_id = $1 and user_id = $2`,
    [workspaceId, agentUserId]
  );
  h.doorCalls.push({
    door,
    input,
    actingAgent: getActingAgentUserId(),
    sessionId: ctx?.sessionId ?? null,
    isMember: rows[0]!.n > 0,
  });
  const answer = h.answers[door];
  return answer ? answer() : { status: "created", id: randomUUID() };
}

vi.mock("../../routers/entities.js", () => ({
  entitiesRouter: {
    createCaller: (ctx: Record<string, unknown>) => ({
      create: (input: Record<string, unknown>) =>
        recordDoor(
          "entity/create",
          ctx,
          input,
          String(ctx.workspaceId),
          String(ctx.agentUserId)
        ),
      update: (input: Record<string, unknown>) =>
        recordDoor(
          "entity/update",
          ctx,
          input,
          String(ctx.workspaceId),
          String(ctx.agentUserId)
        ),
    }),
  },
}));

vi.mock("../../routers/hub-protocol/documents.js", () => ({
  documentsRouter: {
    createCaller: (ctx: Record<string, unknown>) => ({
      createDocument: (input: Record<string, unknown>) =>
        recordDoor(
          "document/create",
          ctx,
          input,
          String(ctx.workspaceId),
          String(ctx.agentUserId)
        ),
    }),
  },
}));

vi.mock("../focus-sessions/create-session.js", () => ({
  createFocusSession: (params: Record<string, unknown>) =>
    recordDoor(
      "focus_session/create",
      null,
      params,
      String(params.workspaceId),
      String(params.agentUserId)
    ),
}));

import { TRPCError } from "@trpc/server";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  proposals,
  users,
  workspaces,
  workspaceMembers,
  focusSessions,
} from "@synap/database";
import { DEFERRED_WRITES_MAX } from "@synap-core/types/proposals/deferred-writes";
import { checkPermissionOrPropose } from "../../utils/permission-check.js";
import { proposalExecRegistry } from "../../routers/proposals/execution-registry.js";
import { registerWorkspaceExecutors } from "../../routers/proposals/executors/workspace.js";
import { recordRejectedDeferredWrites } from "./deferred-writes.js";

const HUMAN = randomUUID();
const AGENT = randomUUID();
const WS = randomUUID();
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
  for (const t of [
    proposals,
    users,
    workspaces,
    workspaceMembers,
    focusSessions,
  ])
    await h.client!.exec(ddlFor(t as PgTable));
  await h.client!.exec(
    `create unique index on workspace_members (workspace_id, user_id);`
  );
  await q(
    `insert into users (id, email, name, user_type) values ($1, 'h@x', 'Human', 'human'), ($2, 'a@x', 'Scout', 'agent')`,
    [HUMAN, AGENT]
  );
  await q(`insert into workspaces (id, name) values ($1, 'Sales')`, [WS]);
  registerWorkspaceExecutors();
});

beforeEach(async () => {
  await q(`delete from proposals`);
  await q(`delete from workspace_members`);
  h.doorCalls.length = 0;
  h.answers = {};
});

/** One agent write into WS through the real gate. */
function agentWrite(
  subjectType: string,
  action: string,
  data: Record<string, unknown>,
  sessionId?: string
) {
  return checkPermissionOrPropose({
    userId: HUMAN,
    agentUserId: AGENT,
    workspaceId: WS,
    subjectType,
    action,
    data,
    sessionId,
    reasoning: "keeping the pipeline tidy",
  } as Parameters<typeof checkPermissionOrPropose>[0]);
}

async function joinRows() {
  const { rows } = await q<{
    id: string;
    status: string;
    data: Record<string, unknown>;
  }>(
    `select id, status, data from proposals where target_type = 'workspace' and proposal_type = 'join'`
  );
  return rows;
}

async function approveJoin(proposalId: string) {
  const [row] = (
    await q<{ data: unknown }>(`select data from proposals where id = $1`, [
      proposalId,
    ])
  ).rows;
  return proposalExecRegistry.resolveExact("workspace/join")!.execute({
    proposal: {
      id: proposalId,
      targetType: "workspace",
      targetId: WS,
      proposalType: "join",
      workspaceId: WS,
      sessionId: null,
      projectId: null,
      agentUserId: AGENT,
      sourceMessageId: null,
      data: row!.data,
    },
    payload: null,
    userId: HUMAN,
    input: { proposalId },
    ctx: {} as never,
    deps: {
      emitProposalReviewed: () => undefined,
      reportProposalOutcome: () => undefined,
    } as never,
  });
}

/** The five writes of the ticket: one files the join, four ride its dedupe. */
async function fiveWrites() {
  const entityId = randomUUID();
  const results = [
    await agentWrite(
      "entity",
      "create",
      { id: randomUUID(), profileSlug: "note", title: "Call notes" },
      SESSION
    ),
    await agentWrite("entity", "update", { id: entityId, title: "Renamed" }),
    await agentWrite("focus_session", "create", {
      id: randomUUID(),
      goal: "Qualify the inbound leads",
    }),
    await agentWrite("document", "create", {
      id: randomUUID(),
      title: "Brief",
      type: "markdown",
      content: "# Brief",
      workspaceId: WS,
      userId: HUMAN,
    }),
    await agentWrite("entity", "create", {
      id: randomUUID(),
      profileSlug: "note",
      title: "Second note",
    }),
  ];
  return { results, entityId };
}

describe("join deferral — the gate keeps every replayable write", () => {
  it("5 writes → ONE join holding 5 deferred writes, each told it was kept", async () => {
    const { results } = await fiveWrites();
    const joins = await joinRows();
    expect(joins).toHaveLength(1);
    const kept = joins[0]!.data.deferredWrites as Array<
      Record<string, unknown>
    >;
    expect(kept.map((w) => `${w.subjectType}/${w.action}`)).toEqual([
      "entity/create",
      "entity/update",
      "focus_session/create",
      "document/create",
      "entity/create",
    ]);
    for (const [i, r] of results.entries()) {
      expect(r).toMatchObject({
        granted: false,
        proposalId: joins[0]!.id,
        proposalType: "join",
        deferred: true,
        deferredRef: kept[i]!.ref,
      });
    }
    // Provenance the replay needs rides with each write.
    expect(kept[0]).toMatchObject({
      agentUserId: AGENT,
      userId: HUMAN,
      sessionId: SESSION,
      reasoning: "keeping the pipeline tidy",
    });
  });

  it("a resend of the same write is kept once, and answers with the kept ref", async () => {
    const data = { id: randomUUID(), profileSlug: "note", title: "Same" };
    const first = await agentWrite("entity", "create", data);
    const again = await agentWrite("entity", "create", {
      ...data,
      id: randomUUID(),
    });
    const [join] = await joinRows();
    expect((join!.data.deferredWrites as unknown[]).length).toBe(1);
    expect(again).toMatchObject({
      deferred: true,
      deduped: true,
      deferredRef: (first as { deferredRef: string }).deferredRef,
    });
  });

  it("a pair that cannot be replayed is NOT kept (today's join, retry after)", async () => {
    const r = await agentWrite("entity", "delete", { id: randomUUID() });
    const [join] = await joinRows();
    expect(join!.data.deferredWrites).toBeUndefined();
    expect(r).toMatchObject({ proposalType: "join" });
    expect(r).not.toHaveProperty("deferred");
    // …and on the dedupe path too.
    await agentWrite("entity", "create", { id: randomUUID(), title: "kept" });
    const r2 = await agentWrite("view", "delete", { id: randomUUID() });
    expect(r2).not.toHaveProperty("deferred");
    const [after] = await joinRows();
    expect((after!.data.deferredWrites as unknown[]).length).toBe(1);
  });

  it(`refuses, in words, the write past the cap of ${DEFERRED_WRITES_MAX}`, async () => {
    for (let i = 0; i < DEFERRED_WRITES_MAX; i++) {
      const r = await agentWrite("entity", "create", {
        id: randomUUID(),
        profileSlug: "note",
        title: `note ${i}`,
      });
      expect(r).toMatchObject({ deferred: true });
    }
    const over = await agentWrite("entity", "create", {
      id: randomUUID(),
      profileSlug: "note",
      title: "one too many",
    });
    expect(over).toMatchObject({ denied: true });
    expect((over as { reason: string }).reason).toMatch(
      /already holds 50 writes/
    );
    const [join] = await joinRows();
    expect((join!.data.deferredWrites as unknown[]).length).toBe(
      DEFERRED_WRITES_MAX
    );
  });
});

describe("join approval — membership, then replay as the agent", () => {
  it("approve → member in the same step → 5 writes replayed through their doors, outcomes recorded", async () => {
    await fiveWrites();
    const [join] = await joinRows();
    const kept = join!.data.deferredWrites as Array<{ ref: string }>;
    // The ladder's answers on replay: the update now needs review, the
    // document door says no, the rest apply.
    h.answers["entity/update"] = () => ({
      status: "proposed",
      proposalId: "p-update",
      proposalType: "entity.update",
    });
    h.answers["document/create"] = () => {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Documents in Sales need review",
      });
    };
    h.answers["focus_session/create"] = () => ({
      status: "created",
      session: { id: "s-1" },
    });

    const result = await approveJoin(join!.id);

    expect(result).toMatchObject({
      success: true,
      effect: { applied: "verified", rows: 1, subject: "workspace_members" },
    });
    // Every door ran AS THE AGENT, with the membership already there.
    expect(h.doorCalls.map((c) => c.door)).toEqual([
      "entity/create",
      "entity/update",
      "focus_session/create",
      "document/create",
      "entity/create",
    ]);
    for (const c of h.doorCalls) {
      expect(c.actingAgent).toBe(AGENT);
      expect(c.isMember).toBe(true);
    }
    expect(h.doorCalls[0]!.sessionId).toBe(SESSION);
    expect(h.doorCalls[0]!.input).toMatchObject({
      profileSlug: "note",
      title: "Call notes",
      agentUserId: AGENT,
    });
    expect(h.doorCalls[2]!.input).toMatchObject({
      userId: HUMAN,
      agentUserId: AGENT,
      workspaceId: WS,
      goal: "Qualify the inbound leads",
    });

    const [after] = await joinRows();
    expect(after!.status).toBe("approved");
    const outcomes = after!.data.deferredOutcomes as Record<
      string,
      Record<string, unknown>
    >;
    expect(outcomes[kept[0]!.ref]).toMatchObject({ outcome: "applied" });
    expect(outcomes[kept[1]!.ref]).toMatchObject({
      outcome: "proposed",
      proposalId: "p-update",
    });
    expect(outcomes[kept[2]!.ref]).toMatchObject({
      outcome: "applied",
      id: "s-1",
    });
    expect(outcomes[kept[3]!.ref]).toMatchObject({
      outcome: "refused",
      reason: "Documents in Sales need review",
    });
    expect(outcomes[kept[4]!.ref]).toMatchObject({ outcome: "applied" });
    // The writes themselves are still on the row (the approval merged, it did
    // not overwrite).
    expect((after!.data.deferredWrites as unknown[]).length).toBe(5);
    const { rows } = await q<{ role: string }>(
      `select role from workspace_members where workspace_id = $1 and user_id = $2`,
      [WS, AGENT]
    );
    expect(rows).toEqual([{ role: "editor" }]);
  });

  it("a write the reviewer dropped (rejectItem disposition) is skipped, not replayed", async () => {
    await agentWrite("entity", "create", { id: randomUUID(), title: "keep" });
    const r = (await agentWrite("entity", "create", {
      id: randomUUID(),
      title: "drop",
    })) as { deferredRef: string; proposalId: string };
    await q(
      `update proposals set data = jsonb_set(data, '{dispositions}', jsonb_build_object($1::text, '{"status":"reject"}'::jsonb)) where id = $2`,
      [r.deferredRef, r.proposalId]
    );
    await approveJoin(r.proposalId);
    expect(h.doorCalls).toHaveLength(1);
    expect(h.doorCalls[0]!.input).toMatchObject({ title: "keep" });
    const [after] = await joinRows();
    expect(
      (after!.data.deferredOutcomes as Record<string, { outcome: string }>)[
        r.deferredRef
      ]!.outcome
    ).toBe("skipped_by_reviewer");
  });

  it("an agent that is already a member: approval is idempotent (0 rows), writes still replay", async () => {
    const r = (await agentWrite("entity", "create", {
      id: randomUUID(),
      title: "x",
    })) as { proposalId: string };
    await q(
      `insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'editor')`,
      [WS, AGENT]
    );
    const result = await approveJoin(r.proposalId);
    expect(result.effect).toMatchObject({ applied: "verified", rows: 0 });
    expect(h.doorCalls).toHaveLength(1);
  });

  it("a rejected join records `rejected` for every kept write — nothing replays", async () => {
    await fiveWrites();
    const [join] = await joinRows();
    await q(`update proposals set status = 'rejected' where id = $1`, [
      join!.id,
    ]);
    await recordRejectedDeferredWrites(join!.id);
    const [after] = await joinRows();
    const outcomes = Object.values(
      after!.data.deferredOutcomes as Record<string, { outcome: string }>
    );
    expect(outcomes).toHaveLength(5);
    expect(outcomes.every((o) => o.outcome === "rejected")).toBe(true);
    expect(h.doorCalls).toHaveLength(0);
  });
});
