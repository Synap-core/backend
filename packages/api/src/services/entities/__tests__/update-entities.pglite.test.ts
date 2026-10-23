/**
 * R1 BATCH WRITES — `updateEntities` and its approval half `entity/update_pack`,
 * driven through the real doors on a real Postgres (PGlite):
 *
 *   service → the real `entities.update` procedure (the ONE update door) for
 *   execute-class items; ONE `entity/update_pack` proposal for the rest;
 *   approval → the real `proposals.rejectItem` door → the real registered
 *   `entity/update_pack` executor → the shared `entity/update` body.
 *
 * MOCKED: the governance ladder itself (`previewPermissionDecision` /
 * `checkPermissionOrPropose`) — it has its own suites. The fake answers per
 * entity id and, like the real gate, INSERTS the row it reports (a pending row
 * for a proposal, an AUTO_APPROVED receipt spreading the gate data flat), so
 * "one pending row" is counted on the table, not on a mock call log. The daily
 * write ceiling's two reads are mocked to a chosen budget.
 *
 * NOT covered (NEEDS-DOGFOOD): the real rung reasons, a pack whose items span
 * spaces, and the review surfaces (UI lane).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const holder = vi.hoisted(() => ({
  db: undefined as unknown,
  client: undefined as unknown,
  verdicts: new Map<string, "execute" | "propose" | "deny">(),
  ceiling: { limit: 500, used: 0 },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = {
    ...actual,
    registerIdentitySignals: async () => undefined,
    getDb: async () => holder.db,
    eventRepository: { append: async () => undefined },
  };
  Object.defineProperty(mocked, "db", {
    get: () => holder.db,
    enumerable: true,
  });
  return mocked;
});
vi.mock("@synap/database/agent-governance", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveDailyWriteCeiling: vi.fn(async () => holder.ceiling.limit),
  countAgentWritesTodayUtc: vi.fn(async () => holder.ceiling.used),
}));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
  getBoss: () => ({ send: async () => null }),
}));

/** The destructive floor's sentence, as the real ladder would report it. */
const DESTRUCTIVE_REASON =
  "Deleting or archiving needs a person's approval (destructive floor).";

vi.mock("../../../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const verdictFor = (data: Record<string, unknown> | undefined) =>
    holder.verdicts.get(String(data?.id)) ?? "execute";
  const insert = async (
    status: string,
    proposalType: string,
    targetId: string,
    data: unknown
  ) => {
    const id = randomUUID();
    await (
      holder.client as { query: (q: string, p: unknown[]) => Promise<unknown> }
    ).query(
      `insert into proposals (id, status, proposal_type, target_type, target_id, data, created_by, subject_user_id)
       values ($1, $2, $3, 'entity', $4, $5::jsonb, 'agent-1', 'user-1')`,
      [id, status, proposalType, targetId, JSON.stringify(data)]
    );
    return id;
  };
  return {
    ...actual,
    previewPermissionDecision: vi.fn(
      async (opts: { data?: Record<string, unknown> }) => {
        const v = verdictFor(opts.data);
        return v === "deny"
          ? { decision: "deny", reason: DESTRUCTIVE_REASON }
          : { decision: v };
      }
    ),
    checkPermissionOrPropose: vi.fn(
      async (opts: {
        action: string;
        agentUserId?: string;
        forcePropose?: boolean;
        data?: Record<string, unknown>;
      }) => {
        const data = opts.data ?? {};
        // The approver's replay (a person, no agent): the real gate grants it.
        if (!opts.agentUserId) return { granted: true };
        if (opts.action === "update_pack") {
          const proposalId = await insert(
            "pending",
            "update_pack",
            String(data.id),
            { changeType: "update_pack", targetType: "entity", data }
          );
          return {
            granted: false,
            proposalId,
            proposalType: "entity.update_pack",
            summary: "Update pack",
            reasoning: "",
            reviewPath: `/open/${proposalId}`,
            reviewUrl: `https://pod.test/open/${proposalId}`,
          };
        }
        const v = verdictFor(data);
        if (v === "deny") return { denied: true, reason: DESTRUCTIVE_REASON };
        if (v === "propose") {
          const proposalId = await insert(
            "pending",
            "update",
            String(data.id),
            {
              changeType: "update",
              targetType: "entity",
              data,
            }
          );
          return {
            granted: false,
            proposalId,
            proposalType: "entity.update",
            summary: "Update",
            reasoning: "",
            reviewPath: `/open/${proposalId}`,
            reviewUrl: `https://pod.test/open/${proposalId}`,
          };
        }
        const receiptId = await insert(
          "auto_approved",
          "entity.update",
          String(data.id),
          { ...data, _autoApprove: {} }
        );
        return { granted: true, autoApprovedProposalId: receiptId };
      }
    ),
  };
});
vi.mock(
  "../../../routers/proposals/review-authority.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    computeCanReviewApproval: vi.fn(async () => ({ allowed: true })),
    // Who may review is its own suite; this file tests what the item door writes.
    assertCanReviewProposal: vi.fn(async () => undefined),
  })
);
vi.mock("../../../lib/event-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  logEvent: vi.fn(async () => undefined),
}));
vi.mock("../../../utils/domain-event-bridge.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitHubRealtimeEvent: vi.fn(),
}));
vi.mock("../../../utils/audit-log.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  auditLog: vi.fn(async () => undefined),
}));
vi.mock("../../../utils/domain-mutation.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recordDomainMutation: vi.fn(async () => null),
}));
vi.mock("../../../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: vi.fn(async () => false),
  getSyncGenerationState: vi.fn(async () => ({
    role: "primary",
    splitBrainDetected: false,
    generation: 1,
    lastPeerGeneration: 0,
    lastPeerContact: null,
  })),
}));
vi.mock("../../../utils/property-relation-sync.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  syncRelationToPropertyOnDelete: vi.fn(async () => undefined),
  syncPropertyToRelations: vi.fn(async () => undefined),
}));

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  entities,
  relations,
  entityFacets,
  links,
  proposals,
  workspaces,
  workspaceMembers,
  projectMembers,
  podMembers,
  users,
  type db as DatabaseHandle,
} from "@synap/database";
import type { Context } from "../../../context.js";
import { updateEntities } from "../update-entities.js";
import { checkPermissionOrPropose } from "../../../utils/permission-check.js";
import { registerEntityExecutors } from "../../../routers/proposals/executors/entity.js";
import { proposalExecRegistry } from "../../../routers/proposals/execution-registry.js";
import { proposalsRouter } from "../../../routers/proposals.js";

const USER = "user-1";
const AGENT = "11111111-1111-4111-8111-111111111111";
type Database = typeof DatabaseHandle;

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

async function freshDb() {
  const client = new PGlite();
  for (const table of [
    entities,
    relations,
    entityFacets,
    links,
    proposals,
    workspaces,
    workspaceMembers,
    projectMembers,
    podMembers,
    users,
  ]) {
    await client.exec(ddlFor(table as unknown as PgTable));
  }
  await client.exec(
    `insert into users (id, email) values ('${USER}', '${USER}@example.test')`
  );
  const database = drizzle(client, {
    schema: { entities, proposals, workspaces, workspaceMembers },
  }) as unknown as Database;
  holder.db = database;
  holder.client = client;
  return { client, database };
}

async function insertEntity(
  client: PGlite,
  title: string,
  verdict: "execute" | "propose" | "deny" = "execute"
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `insert into entities (id, user_id, type, title, preview, properties)
     values ($1, $2, 'note', $3, 'desc', $4::jsonb)`,
    [id, USER, title, JSON.stringify({ stage: "lead" })]
  );
  holder.verdicts.set(id, verdict);
  return id;
}

const ctx = (database: Database) =>
  ({
    db: database,
    authenticated: true,
    userId: USER,
    workspaceId: null,
  }) as unknown as Context;

async function titleOf(client: PGlite, id: string) {
  return (
    await client.query<{ title: string }>(
      `select title from entities where id = $1`,
      [id]
    )
  ).rows[0]!.title;
}

async function rows(client: PGlite, status: string) {
  return (
    await client.query<{
      id: string;
      proposal_type: string;
      target_id: string;
      data: Record<string, any>;
    }>(
      `select id, proposal_type, target_id, data from proposals where status = $1`,
      [status]
    )
  ).rows;
}

async function approvePack(client: PGlite, proposalId: string) {
  const row = (
    await client.query<{
      id: string;
      target_type: string;
      target_id: string;
      proposal_type: string;
      data: Record<string, unknown>;
    }>(
      `select id, target_type, target_id, proposal_type, data from proposals where id = $1`,
      [proposalId]
    )
  ).rows[0]!;
  const executor = proposalExecRegistry.resolveExact(
    `${row.target_type}/${row.proposal_type}`
  );
  if (!executor) throw new Error("entity/update_pack executor not registered");
  return executor.execute({
    proposal: {
      id: row.id,
      targetType: row.target_type,
      targetId: row.target_id,
      proposalType: row.proposal_type,
      workspaceId: null,
      agentUserId: AGENT,
      data: row.data,
    },
    payload: row.data,
    userId: USER,
    input: { proposalId },
    deps: { emitProposalReviewed: vi.fn(), reportProposalOutcome: vi.fn() },
  } as never);
}

registerEntityExecutors();

beforeEach(() => {
  holder.verdicts.clear();
  holder.ceiling = { limit: 500, used: 0 };
});

describe("updateEntities — one call, one review", () => {
  it("a mixed batch writes the auto items now, files ONE pending pack, and reports denials and floor misses", async () => {
    const { client, database } = await freshDb();
    const auto = await insertEntity(client, "A");
    const review1 = await insertEntity(client, "B", "propose");
    const review2 = await insertEntity(client, "C", "propose");
    const denied = await insertEntity(client, "D", "deny");
    const missing = randomUUID();

    const result = await updateEntities({
      ctx: ctx(database),
      agentUserId: AGENT,
      source: "intelligence",
      items: [auto, review1, review2, denied, missing].map((id) => ({
        id,
        patch: { title: `new ${id.slice(0, 4)}` },
      })),
    });

    expect(result.applied).toEqual([auto]);
    expect(result.proposed).toMatchObject({
      count: 2,
      ids: [review1, review2],
    });
    expect(result.denied).toEqual([{ id: denied, reason: DESTRUCTIVE_REASON }]);
    expect(result.skipped).toEqual([
      { id: missing, reason: "Not found or not writable by you" },
    ]);
    expect(result.items.map((i) => i.verdict)).toEqual([
      "execute",
      "propose",
      "propose",
      "deny",
      "skip",
    ]);

    // ONE pending row for the whole call, holding both items.
    const pending = await rows(client, "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.proposal_type).toBe("update_pack");
    expect(pending[0]!.id).toBe(result.proposed!.proposalId);
    expect(
      pending[0]!.data.data.items.map((i: { ref: string }) => i.ref)
    ).toEqual([review1, review2]);
    expect(pending[0]!.data.data.items[0].before).toEqual({ title: "B" });

    // The auto write went through `entities.update` and its receipt carries the batch.
    expect(await titleOf(client, auto)).toBe(`new ${auto.slice(0, 4)}`);
    expect(await titleOf(client, review1)).toBe("B");
    expect(await titleOf(client, denied)).toBe("D");
    const receipts = await rows(client, "auto_approved");
    expect(receipts.map((r) => [r.target_id, r.data.batchId])).toEqual([
      [auto, result.batchId],
    ]);
  });

  it("execute-class items past the agent's daily ceiling join the pack, never single proposals", async () => {
    const { client, database } = await freshDb();
    holder.ceiling = { limit: 5, used: 4 };
    const ids = [
      await insertEntity(client, "A1"),
      await insertEntity(client, "A2"),
      await insertEntity(client, "A3"),
    ];

    const result = await updateEntities({
      ctx: ctx(database),
      agentUserId: AGENT,
      items: ids.map((id) => ({ id, patch: { title: "x" } })),
    });

    expect(result.applied).toEqual([ids[0]]);
    expect(result.proposed).toMatchObject({ count: 2, ids: ids.slice(1) });
    expect(await rows(client, "pending")).toHaveLength(1);
    expect(result.items[1]!.reason).toMatch(/daily write limit \(5\)/);
  });

  it("validate: true returns each verdict and writes nothing", async () => {
    const { client, database } = await freshDb();
    const a = await insertEntity(client, "A");
    const b = await insertEntity(client, "B", "propose");

    const result = await updateEntities({
      ctx: ctx(database),
      agentUserId: AGENT,
      validate: true,
      items: [a, b].map((id) => ({ id, patch: { title: "x" } })),
    });

    expect(result.validated).toBe(true);
    expect(result.items.map((i) => i.verdict)).toEqual(["execute", "propose"]);
    expect(result.applied).toEqual([]);
    expect(result.proposed).toBeNull();
    expect(await titleOf(client, a)).toBe("A");
    expect((await client.query(`select id from proposals`)).rows).toHaveLength(
      0
    );
  });

  it("an idempotent replay returns the same receipt and writes nothing twice", async () => {
    const { client, database } = await freshDb();
    const a = await insertEntity(client, "A");
    const b = await insertEntity(client, "B", "propose");
    const call = () =>
      updateEntities({
        ctx: ctx(database),
        agentUserId: AGENT,
        idempotencyKey: `replay-${a}`,
        items: [a, b].map((id) => ({ id, patch: { title: "x" } })),
      });

    const first = await call();
    const second = await call();

    expect(second).toEqual({ ...first, replayed: true });
    expect(await rows(client, "pending")).toHaveLength(1);
    expect(await rows(client, "auto_approved")).toHaveLength(1);
  });
});

describe("updateEntities — one record needing review is not a pack (F1)", () => {
  it("the lone review item goes through the single update door, never forced, as the call's one review", async () => {
    const { client, database } = await freshDb();
    const auto = await insertEntity(client, "A");
    const review = await insertEntity(client, "B", "propose");
    const gate = vi.mocked(checkPermissionOrPropose);
    gate.mockClear();

    const result = await updateEntities({
      ctx: ctx(database),
      agentUserId: AGENT,
      source: "intelligence",
      items: [auto, review].map((id) => ({ id, patch: { title: "Done" } })),
    });

    // Gated as a single write: its own action, no forced proposal — so the
    // ordinary decision (and a rule naming the action) applies to it.
    const calls = gate.mock.calls.map(([opts]) => opts);
    expect(calls.map((o) => o.action)).toEqual(["update", "update"]);
    expect(calls.some((o) => o.forcePropose === true)).toBe(false);
    const pending = await rows(client, "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.proposal_type).toBe("update");
    expect(pending[0]!.target_id).toBe(review);
    expect(result.proposed).toEqual({
      proposalId: pending[0]!.id,
      count: 1,
      ids: [review],
      reviewUrl: `https://pod.test/open/${pending[0]!.id}`,
    });
    expect(result.applied).toEqual([auto]);
    expect(result.skipped).toEqual([]);
    expect(await titleOf(client, review)).toBe("B");
  });

  it("a one-item call whose gate allows it is written, not filed", async () => {
    const { client, database } = await freshDb();
    // The preview said review; the door's own decision (e.g. a rule naming
    // the action) allows it — the receipt says what landed.
    const id = await insertEntity(client, "B", "propose");
    const gate = vi.mocked(checkPermissionOrPropose);
    gate.mockImplementationOnce(async () => ({ granted: true }));

    const result = await updateEntities({
      ctx: ctx(database),
      agentUserId: AGENT,
      items: [{ id, patch: { title: "Done" } }],
    });

    expect(result.items[0]!.verdict).toBe("propose");
    expect(result.applied).toEqual([id]);
    expect(result.proposed).toBeNull();
    expect(await titleOf(client, id)).toBe("Done");
    expect(await rows(client, "pending")).toHaveLength(0);
  });
});

describe("updateEntities — an agent's XML-escaped title is decoded at the door", () => {
  it("the pack a reviewer approves and the write both hold `&`", async () => {
    const { client, database } = await freshDb();
    const auto = await insertEntity(client, "A");
    const review = await insertEntity(client, "B", "propose");
    const review2 = await insertEntity(client, "C", "propose");

    const result = await updateEntities({
      ctx: ctx(database),
      agentUserId: AGENT,
      source: "intelligence",
      items: [auto, review, review2].map((id) => ({
        id,
        patch: { title: "Doors &amp; Spec" },
      })),
    });

    // Written through the update door: stored decoded.
    expect(result.applied).toEqual([auto]);
    expect(await titleOf(client, auto)).toBe("Doors & Spec");
    // Filed for review: the pack item holds the decoded title — approving
    // it later must not store `&amp;`.
    const [pack] = await rows(client, "pending");
    expect(pack!.data.data.items[0].ref).toBe(review);
    expect(pack!.data.data.items[0].patch.title).toBe("Doors & Spec");
  });
});

describe("entity/update_pack — the approval half", () => {
  async function filePack(client: PGlite, database: Database, n: number) {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      ids.push(await insertEntity(client, `T${i}`, "propose"));
    }
    const result = await updateEntities({
      ctx: ctx(database),
      agentUserId: AGENT,
      items: ids.map((id, i) => ({ id, patch: { title: `Renamed ${i}` } })),
    });
    return { ids, proposalId: result.proposed!.proposalId };
  }

  it("approving with 2 items rejected applies the other N−2 and records every outcome", async () => {
    const { client, database } = await freshDb();
    const { ids, proposalId } = await filePack(client, database, 4);

    const reviewer = proposalsRouter.createCaller({
      db: database,
      authenticated: true,
      userId: USER,
    } as Parameters<typeof proposalsRouter.createCaller>[0]);
    await reviewer.rejectItem({ proposalId, itemRef: ids[1]! });
    await reviewer.rejectItem({ proposalId, itemRef: ids[3]! });
    // The ref check reads the update pack's items: a typo is refused.
    await expect(
      reviewer.rejectItem({ proposalId, itemRef: "not-an-item" })
    ).rejects.toThrow(/No item "not-an-item"/);

    const result = await approvePack(client, proposalId);

    expect(result).toMatchObject({
      success: true,
      effect: { applied: "verified", rows: 2, ids: [ids[0], ids[2]] },
    });
    expect(await titleOf(client, ids[0]!)).toBe("Renamed 0");
    expect(await titleOf(client, ids[1]!)).toBe("T1");
    expect(await titleOf(client, ids[2]!)).toBe("Renamed 2");
    expect(await titleOf(client, ids[3]!)).toBe("T3");
    const row = (
      await client.query<{ status: string; data: Record<string, any> }>(
        `select status, data from proposals where id = $1`,
        [proposalId]
      )
    ).rows[0]!;
    expect(row.status).toBe("approved");
    expect(
      Object.fromEntries(
        Object.entries(row.data.outcomes).map(([ref, o]) => [
          ref,
          (o as { outcome: string }).outcome,
        ])
      )
    ).toEqual({
      [ids[0]!]: "applied",
      [ids[1]!]: "skipped_by_reviewer",
      [ids[2]!]: "applied",
      [ids[3]!]: "skipped_by_reviewer",
    });
  });

  it("an item edited since filing is refused (stale before), its sibling still applies", async () => {
    const { client, database } = await freshDb();
    const { ids, proposalId } = await filePack(client, database, 2);
    await client.query(`update entities set title = 'Edited' where id = $1`, [
      ids[0],
    ]);

    const result = await approvePack(client, proposalId);

    expect(await titleOf(client, ids[0]!)).toBe("Edited");
    expect(await titleOf(client, ids[1]!)).toBe("Renamed 1");
    expect(result).toMatchObject({
      effect: { applied: "verified", ids: [ids[1]] },
    });
    expect((result as { refusals: string[] }).refusals).toEqual([
      "T0: Changed since this pack was filed (title) — not overwritten",
    ]);
  });
});
