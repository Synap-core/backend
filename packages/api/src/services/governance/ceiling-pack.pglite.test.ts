/**
 * W-B1 — past its daily write ceiling (rung 2.56) an agent's writes are HELD
 * on ONE pack per (agent, UTC day), not filed one proposal each; the pending
 * cap counts that pack once; approving it replays each kept write.
 *
 * Real, on PGlite: the gate (`checkPermissionOrPropose` → `createProposal` →
 * `joinTodaysHeldWrites` / the pending cap / `fileHeldWrites`), the
 * `agent/held_writes` executor and the replay engine (`replayDeferredWrites`).
 *
 * Stubbed, and why:
 *   - `resolveAgentGovernanceDecision` → the ladder's answer for an agent over
 *     its ceiling (`propose`, `DAILY_WRITE_CEILING`). The rung itself, and its
 *     lift during an approved replay, are pinned in
 *     `resolve-agent-governance-decision.test.ts` (@synap/database).
 *   - `createEventBackedProposal` → a plain proposals insert of the SAME row
 *     fields (the event spine and notifications have their own suites).
 *   - the four replay DOORS → recorders, as in `deferred-writes.pglite.test.ts`:
 *     they capture the acting agent, the space each write replays in, and
 *     whether the replay runs inside the approved held-writes scope.
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
    workspaceId: unknown;
    heldWritesApprovedBy: string | undefined;
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
      workspaceMembers: actual.workspaceMembers as never,
      focusSessions: actual.focusSessions as never,
    },
  });
  return { ...actual, db: h.db, getDb: async () => h.db };
});

vi.mock("@synap/database/agent-governance", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveAgentGovernanceDecision: async () => ({
    decision: "propose",
    reason:
      "This agent used up today's automatic writes, so the rest wait for you.",
    reasonCode: "DAILY_WRITE_CEILING",
  }),
}));

vi.mock("../../utils/event-backed-proposal.js", () => ({
  createEventBackedProposal: async (input: Record<string, unknown>) => {
    const id = randomUUID();
    await h.client!.query(
      `insert into proposals (id, status, proposal_type, target_type, target_id, workspace_id, agent_user_id, created_by, session_id, governance_reason, data, created_at, updated_at)
       values ($1, 'pending', $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, now(), now())`,
      [
        id,
        input.proposalType,
        input.targetType,
        input.targetId,
        input.workspaceId ?? null,
        input.agentUserId,
        input.createdBy,
        input.sessionId ?? null,
        input.governanceReason ?? null,
        JSON.stringify(input.data),
      ]
    );
    return { proposal: { id } };
  },
}));

async function recordDoor(
  door: string,
  workspaceId: unknown,
  input: Record<string, unknown>
): Promise<unknown> {
  const { getActingAgentUserId, getHeldWritesApprovedBy } =
    await import("@synap/database");
  h.doorCalls.push({
    door,
    input,
    actingAgent: getActingAgentUserId(),
    workspaceId,
    heldWritesApprovedBy: getHeldWritesApprovedBy(),
  });
  return { status: "created", id: randomUUID() };
}

vi.mock("../../routers/entities.js", () => ({
  entitiesRouter: {
    createCaller: (ctx: Record<string, unknown>) => ({
      create: (input: Record<string, unknown>) =>
        recordDoor("entity/create", ctx.workspaceId, input),
      update: (input: Record<string, unknown>) =>
        recordDoor("entity/update", ctx.workspaceId, input),
    }),
  },
}));

vi.mock("../../routers/hub-protocol/documents.js", () => ({
  documentsRouter: {
    createCaller: (ctx: Record<string, unknown>) => ({
      createDocument: (input: Record<string, unknown>) =>
        recordDoor("document/create", ctx.workspaceId, input),
    }),
  },
}));

vi.mock("../focus-sessions/create-session.js", () => ({
  createFocusSession: (params: Record<string, unknown>) =>
    recordDoor("focus_session/create", params.workspaceId, params),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  proposals,
  users,
  workspaces,
  workspaceMembers,
  focusSessions,
  entities,
  governanceCeilings,
} from "@synap/database";
import {
  checkPermissionOrPropose,
  AGENT_PENDING_PROPOSAL_CAP,
} from "../../utils/permission-check.js";
import { proposalExecRegistry } from "../../routers/proposals/execution-registry.js";
import { registerAgentExecutors } from "../../routers/proposals/executors/agent.js";

const HUMAN = randomUUID();
const AGENT = randomUUID();
const WS = randomUUID();
const WS2 = randomUUID();
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
    entities,
    governanceCeilings,
  ])
    await h.client!.exec(ddlFor(t as PgTable));
  await q(
    `insert into users (id, email, name, user_type) values ($1, 'h@x', 'Human', 'human'), ($2, 'a@x', 'Scout', 'agent')`,
    [HUMAN, AGENT]
  );
  await q(
    `insert into workspaces (id, name, archived_at) values ($1, 'Sales', null), ($2, 'Brand', null)`,
    [WS, WS2]
  );
  await q(
    `insert into workspace_members (workspace_id, user_id, role) values ($1, $3, 'editor'), ($2, $3, 'editor')`,
    [WS, WS2, AGENT]
  );
  registerAgentExecutors();
});

beforeEach(async () => {
  await q(`delete from proposals`);
  h.doorCalls.length = 0;
});

/** One agent write through the real gate, with the ladder over the ceiling. */
function agentWrite(
  subjectType: string,
  action: string,
  data: Record<string, unknown>,
  workspaceId: string = WS
) {
  return checkPermissionOrPropose({
    userId: HUMAN,
    agentUserId: AGENT,
    workspaceId,
    subjectType,
    action,
    data,
    sessionId: SESSION,
    reasoning: "retitling the pipeline",
  } as Parameters<typeof checkPermissionOrPropose>[0]);
}

async function heldPacks() {
  const { rows } = await q<{
    id: string;
    status: string;
    governance_reason: string | null;
    data: Record<string, unknown>;
  }>(
    `select id, status, governance_reason, data from proposals where target_type = 'agent' and proposal_type = 'held_writes'`
  );
  return rows;
}

async function pendingForAgent() {
  const { rows } = await q<{ n: number }>(
    `select count(*)::int as n from proposals where agent_user_id = $1 and status = 'pending'`,
    [AGENT]
  );
  return rows[0]!.n;
}

describe("the ceiling pack — one held pack per agent per UTC day", () => {
  it("4 writes past the ceiling → ONE pending pack holding 4 writes, each told it was held", async () => {
    const results = [
      await agentWrite("entity", "update", {
        id: randomUUID(),
        title: "Renamed 1",
      }),
      await agentWrite("entity", "update", {
        id: randomUUID(),
        title: "Renamed 2",
      }),
      await agentWrite(
        "entity",
        "create",
        { id: randomUUID(), profileSlug: "note", title: "Call notes" },
        WS2
      ),
      await agentWrite("entity", "update", {
        id: randomUUID(),
        title: "Renamed 3",
      }),
    ];

    const packs = await heldPacks();
    expect(packs).toHaveLength(1);
    const pack = packs[0]!;
    expect(pack.status).toBe("pending");
    expect(pack.governance_reason).toBe("DAILY_WRITE_CEILING");
    expect(pack.data.day).toBe(new Date().toISOString().slice(0, 10));
    const kept = pack.data.deferredWrites as Array<Record<string, unknown>>;
    expect(kept.map((w) => `${w.subjectType}/${w.action}`)).toEqual([
      "entity/update",
      "entity/update",
      "entity/create",
      "entity/update",
    ]);
    // Each write keeps the space it was made in: the pack spans spaces.
    expect(kept.map((w) => w.workspaceId)).toEqual([WS, WS, WS2, WS]);
    for (const [i, r] of results.entries()) {
      expect(r).toMatchObject({
        granted: false,
        proposalId: pack.id,
        proposalType: "held_writes",
        deferred: true,
        deferredRef: kept[i]!.ref,
      });
    }
    expect(await pendingForAgent()).toBe(1);
  });

  it("the pending cap counts the pack once: a sweep at the cap is held, not refused half-way", async () => {
    // One slot left under the default cap.
    for (let i = 0; i < AGENT_PENDING_PROPOSAL_CAP - 1; i++) {
      await q(
        `insert into proposals (id, status, proposal_type, target_type, target_id, agent_user_id, data)
         values ($1, 'pending', 'update', 'entity', $2, $3, '{}'::jsonb)`,
        [randomUUID(), randomUUID(), AGENT]
      );
    }
    const results = [];
    for (let i = 0; i < 6; i++) {
      results.push(
        await agentWrite("entity", "update", {
          id: randomUUID(),
          title: `Sweep ${i}`,
        })
      );
    }
    for (const r of results) expect(r).toMatchObject({ deferred: true });
    const [pack] = await heldPacks();
    expect((pack!.data.deferredWrites as unknown[]).length).toBe(6);
    expect(await pendingForAgent()).toBe(AGENT_PENDING_PROPOSAL_CAP);
  });

  it("a resend of the same held write is kept once, and answers with the kept ref", async () => {
    const data = { id: randomUUID(), title: "Same" };
    const first = (await agentWrite("entity", "update", data)) as {
      deferredRef: string;
    };
    const again = await agentWrite("entity", "update", data);
    const [pack] = await heldPacks();
    expect((pack!.data.deferredWrites as unknown[]).length).toBe(1);
    expect(again).toMatchObject({
      deferred: true,
      deduped: true,
      deferredRef: first.deferredRef,
    });
  });

  it("yesterday's pending pack is not today's: a new pack is filed", async () => {
    await agentWrite("entity", "update", { id: randomUUID(), title: "a" });
    await q(
      `update proposals set data = jsonb_set(data, '{day}', '"2000-01-01"'::jsonb)`
    );
    await agentWrite("entity", "update", { id: randomUUID(), title: "b" });
    expect(await heldPacks()).toHaveLength(2);
  });
});

describe("approving the ceiling pack — each kept write replays past the lifted ceiling", () => {
  async function approve(packId: string) {
    const [row] = (
      await q<{ data: unknown }>(`select data from proposals where id = $1`, [
        packId,
      ])
    ).rows;
    return proposalExecRegistry.resolveExact("agent/held_writes")!.execute({
      proposal: {
        id: packId,
        targetType: "agent",
        targetId: AGENT,
        proposalType: "held_writes",
        workspaceId: null,
        sessionId: null,
        projectId: null,
        agentUserId: AGENT,
        sourceMessageId: null,
        data: row!.data,
      },
      payload: null,
      userId: HUMAN,
      input: { proposalId: packId },
      ctx: {} as never,
      deps: {
        emitProposalReviewed: () => undefined,
        reportProposalOutcome: () => undefined,
      } as never,
    });
  }

  it("approve → the writes the reviewer kept replay as the agent, each in its own space, inside the approved scope", async () => {
    const createdId = randomUUID();
    await agentWrite("entity", "update", { id: randomUUID(), title: "keep" });
    const dropped = (await agentWrite("entity", "update", {
      id: randomUUID(),
      title: "drop",
    })) as { deferredRef: string; proposalId: string };
    await agentWrite(
      "entity",
      "create",
      { id: createdId, profileSlug: "note", title: "New note" },
      WS2
    );
    await q(
      `update proposals set data = jsonb_set(data, '{dispositions}', jsonb_build_object($1::text, '{"status":"reject"}'::jsonb)) where id = $2`,
      [dropped.deferredRef, dropped.proposalId]
    );

    const result = await approve(dropped.proposalId);

    expect(result).toMatchObject({
      success: true,
      effect: { applied: "verified", rows: 2 },
    });
    expect(h.doorCalls.map((c) => [c.door, c.workspaceId])).toEqual([
      ["entity/update", WS],
      ["entity/create", WS2],
    ]);
    for (const c of h.doorCalls) {
      expect(c.actingAgent).toBe(AGENT);
      expect(c.heldWritesApprovedBy).toBe(dropped.proposalId);
    }
    // The id the gate handed the agent is the id the replay lands under.
    expect(h.doorCalls[1]!.input).toMatchObject({
      proposedEntityId: createdId,
    });
    const [after] = await heldPacks();
    expect(after!.status).toBe("approved");
    const outcomes = after!.data.deferredOutcomes as Record<
      string,
      { outcome: string }
    >;
    expect(outcomes[dropped.deferredRef]!.outcome).toBe("skipped_by_reviewer");
  });

  it("a write held after the pack was approved files a new pack", async () => {
    const first = (await agentWrite("entity", "update", {
      id: randomUUID(),
      title: "a",
    })) as { proposalId: string };
    await approve(first.proposalId);
    const next = (await agentWrite("entity", "update", {
      id: randomUUID(),
      title: "b",
    })) as { proposalId: string };
    expect(next.proposalId).not.toBe(first.proposalId);
    expect(await heldPacks()).toHaveLength(2);
  });
});
