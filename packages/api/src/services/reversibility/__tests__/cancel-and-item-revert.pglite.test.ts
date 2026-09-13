/**
 * CANCEL + SINGLE-ITEM REVERT + SESSION REVERT — driven through the real doors,
 * on a real Postgres.
 *
 *  - `cancelSession`, triage discard and an approved `focus_session/update`
 *    proposal → the ONE close door (`completeFocusSession`) → the stop
 *    (`stopSessionWork`) after the commit → the `pgboss.job` scan, the durable
 *    chat-turn cancel and the `metadata.run.cancel` record — all real SQL.
 *  - `proposalsRouter.revert` — the real tRPC door (with and without `opKey`):
 *    planner, `revertProposalCreations`, `safeRevert`, the `byOp` mark and the
 *    compare-and-set row write.
 *  - `revertSession` with its DEFAULT per-proposal step — the real door, so the
 *    outcome classifier reads real results.
 *
 * ENGINE: PGlite. Every table is created FROM ITS DRIZZLE DEFINITION
 * (`getTableConfig`), never a hand-typed DDL: a hand copy is exactly what broke
 * when a peer added `entity_external_links.url`. Constraints / FKs are dropped —
 * these tests assert what the doors write, not what the schema forbids.
 *
 * Stubbed, and why: the governance gate (its own suites; one test flips it to
 * `proposed`), review authority (two tests use it as the interleave point for a
 * concurrent write), pg-boss's `cancel` (it relabels the row here, as pg-boss
 * does), the pod read-only guard, post-commit event fan-out, the ephemeral
 * sweep, and the relation → property reverse sync (one test makes it bump the
 * source entity exactly as the real one's `UPDATE … updated_at = now()` does).
 *
 * NOT covered (NEEDS-DOGFOOD): a pg-boss job cancelled while a real worker holds
 * it; the in-process abort of a live IS fetch (no fetch runs here, so the abort
 * reports "another server holds it").
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const holder = vi.hoisted(() => ({
  db: undefined as unknown,
  client: undefined as unknown,
  failCancelFor: new Set<string>(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = { ...actual, registerIdentitySignals: async () => undefined };
  Object.defineProperty(mocked, "db", {
    get: () => holder.db,
    enumerable: true,
  });
  return mocked;
});
vi.mock("@synap/jobs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getBoss: () => ({
    cancel: async (_name: string, id: string) => {
      if (holder.failCancelFor.has(id)) throw new Error("boss is down");
      await (
        holder.client as {
          query: (q: string, p: unknown[]) => Promise<unknown>;
        }
      ).query(`update pgboss.job set state = 'cancelled' where id = $1`, [id]);
    },
  }),
}));
vi.mock("../../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: vi.fn(async () => ({ allowed: true })),
}));
vi.mock(
  "../../../routers/proposals/review-authority.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    computeCanReviewApproval: vi.fn(async () => ({ allowed: true })),
  })
);
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
}));
vi.mock("../../../lib/event-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  logEvent: vi.fn(async () => undefined),
}));
vi.mock("../../../utils/domain-event-bridge.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitHubRealtimeEvent: vi.fn(),
}));
vi.mock(
  "../../proposals/expire-lapsed-proposals.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    expireSessionEphemerals: vi.fn(async () => 0),
  })
);
vi.mock("../../../utils/audit-log.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  auditLog: vi.fn(async () => undefined),
}));
vi.mock("../../../utils/domain-mutation.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recordDomainMutation: vi.fn(async () => null),
}));
// The pod read-only guard on every mutation (split-brain) — not under test.
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
  focusSessions,
  chatTurns,
  playbookRuns,
  type db as DatabaseHandle,
} from "@synap/database";
import type { CompositeProposalOperation } from "@synap-core/types/proposals";
import { checkPermissionOrPropose } from "../../../utils/permission-check.js";
import { computeCanReviewApproval } from "../../../routers/proposals/review-authority.js";
import { syncRelationToPropertyOnDelete } from "../../../utils/property-relation-sync.js";
import { materializeCompositeGraph } from "../../../utils/materialize-composite.js";
import {
  buildMaterializedRecord,
  stampMaterialized,
  type CompleteMaterializedRecord,
} from "../../proposals/stamp-materialized.js";
import { cancelSession } from "../../focus-sessions/cancel-session.js";
import {
  revertSession,
  type ProposalRevertOutput,
} from "../../focus-sessions/revert-session.js";

const USER = "user-1";
type Database = typeof DatabaseHandle;
type Client = PGlite;

/** CREATE TABLE from the drizzle definition — columns, types and literal defaults. */
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const columns = cfg.columns.map((c) => {
    let type = c.getSQLType();
    // No pg enum types or pgvector exist in this bare database: store as text.
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
  // `secrets` is read by the idempotency lookup (connection-scoped link keys).
  // Workspace membership backs the Hub acting-context check (REST cancel test).
  const { secrets, workspaces, workspaceMembers } =
    await import("@synap/database");
  for (const table of [
    entities,
    relations,
    entityFacets,
    links,
    proposals,
    focusSessions,
    chatTurns,
    playbookRuns,
    secrets,
    workspaces,
    workspaceMembers,
  ]) {
    await client.exec(ddlFor(table as unknown as PgTable));
  }
  await client.exec(`
    create schema pgboss;
    create table pgboss.job (id uuid primary key, name text not null, state text not null, data jsonb);
  `);
  const database = drizzle(client, {
    schema: { proposals, focusSessions, chatTurns, playbookRuns },
  }) as unknown as Database;
  holder.db = database;
  holder.client = client;
  return { client, database };
}

async function insertSession(
  client: Client,
  opts: {
    channelId?: string | null;
    metadata?: Record<string, unknown>;
    origin?: string;
  } = {}
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `insert into focus_sessions (id, user_id, goal, status, channel_id, metadata, origin)
     values ($1, $2, 'Import the notes', 'active', $3, $4::jsonb, $5)`,
    [
      id,
      USER,
      opts.channelId ?? null,
      JSON.stringify(opts.metadata ?? {}),
      opts.origin ?? null,
    ]
  );
  return id;
}

async function insertJob(
  client: Client,
  opts: { name: string; state: string; data: Record<string, unknown> }
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `insert into pgboss.job (id, name, state, data) values ($1, $2, $3, $4::jsonb)`,
    [id, opts.name, opts.state, JSON.stringify(opts.data)]
  );
  return id;
}

async function jobState(client: Client, id: string): Promise<string> {
  const { rows } = await client.query<{ state: string }>(
    `select state from pgboss.job where id = $1`,
    [id]
  );
  return rows[0]!.state;
}

async function sessionRow(client: Client, id: string) {
  const { rows } = await client.query<{
    status: string;
    metadata: Record<string, any>;
  }>(`select status, metadata from focus_sessions where id = $1`, [id]);
  return rows[0]!;
}

async function insertProposal(
  client: Client,
  opts: {
    id?: string;
    sessionId?: string;
    status?: string;
    data: Record<string, unknown>;
    createdAt?: string;
  }
): Promise<string> {
  const id = opts.id ?? randomUUID();
  await client.query(
    `insert into proposals (id, session_id, status, proposal_type, target_type, target_id, data, created_at)
     values ($1, $2, $3, 'import.graph', 'entity', $4, $5::jsonb, ${opts.createdAt ?? "now()"})`,
    [
      id,
      opts.sessionId ?? null,
      opts.status ?? "approved",
      randomUUID(),
      JSON.stringify(opts.data),
    ]
  );
  return id;
}

beforeEach(() => {
  vi.mocked(checkPermissionOrPropose).mockClear();
  holder.failCancelFor.clear();
});

// ───────────────────────────────────────────────────────────────────────────
describe("cancel is cancel — the close door stops what is still in flight", () => {
  it("cancels queued work bound to the session, names running and unlinked work, lists what already applied, and keeps the run manifest", async () => {
    const { client } = await freshDb();
    const channelId = randomUUID();
    const sessionId = await insertSession(client, {
      channelId,
      metadata: {
        run: { engine: "capture", promptVersion: "v3" },
        prompt: "keep me",
      },
    });

    // Queued work bound to this session, three ways.
    const kickoff = await insertJob(client, {
      name: "a2ai-response-trigger",
      state: "created",
      data: { userId: USER, channelId },
    });
    const corpus = await insertJob(client, {
      name: "import-corpus",
      state: "retry",
      data: { userId: USER, sessionId },
    });
    // Already handed to a worker — no real stop.
    const running = await insertJob(client, {
      name: "a2ai-response-trigger",
      state: "active",
      data: { userId: USER, focusSessionId: sessionId },
    });
    // A corpus import that names no session — reported, never guessed at.
    const unlinked = await insertJob(client, {
      name: "import-corpus",
      state: "created",
      data: { userId: USER },
    });
    // Not this session's, or not this user's — must never be touched.
    const foreignUser = await insertJob(client, {
      name: "import-corpus",
      state: "created",
      data: { userId: "someone-else", sessionId },
    });
    const otherSession = await insertJob(client, {
      name: "import-corpus",
      state: "created",
      data: { userId: USER, sessionId: randomUUID() },
    });

    const turnId = randomUUID();
    await client.query(
      `insert into chat_turns (id, channel_id, user_id, request_id, user_message_id, assistant_message_id, status, cancel_requested)
       values ($1, $2, $3, $4, $5, $6, 'running', false)`,
      [turnId, channelId, USER, randomUUID(), randomUUID(), randomUUID()]
    );

    const applied = await insertProposal(client, {
      sessionId,
      data: { operations: [] },
    });
    await insertProposal(client, {
      sessionId,
      status: "pending",
      data: { operations: [] },
    });

    const result = await cancelSession({
      sessionId,
      userId: USER,
      reason: "wrong file",
    });

    expect(result?.session.status).toBe("cancelled");
    const cancel = result!.cancel!;
    expect(cancel.state).toBe("done");
    expect(cancel.reason).toBe("wrong file");
    expect(cancel.by).toBe(USER);
    expect(cancel.stopped.map((s) => [s.kind, s.id]).sort()).toEqual(
      [
        ["chat_turn", turnId],
        ["job", corpus],
        ["job", kickoff],
      ].sort()
    );
    expect(cancel.notStoppable.map((s) => [s.kind, s.id])).toEqual([
      ["job", running],
    ]);
    expect(cancel.notLinked.map((s) => [s.kind, s.id])).toEqual([
      ["job", unlinked],
    ]);
    expect(cancel.stopFailed).toEqual([]);
    expect(cancel.finished.map((s) => [s.kind, s.id])).toEqual([
      ["proposal", applied],
    ]);
    expect(result!.warnings.join(" ")).toContain("name no session");

    // Database reality.
    expect(await jobState(client, kickoff)).toBe("cancelled");
    expect(await jobState(client, corpus)).toBe("cancelled");
    expect(await jobState(client, running)).toBe("active");
    expect(await jobState(client, unlinked)).toBe("created");
    expect(await jobState(client, foreignUser)).toBe("created");
    expect(await jobState(client, otherSession)).toBe("created");
    const {
      rows: [turn],
    } = await client.query<{ cancel_requested: boolean }>(
      `select cancel_requested from chat_turns where id = $1`,
      [turnId]
    );
    expect(turn!.cancel_requested).toBe(true);

    const row = await sessionRow(client, sessionId);
    expect(row.status).toBe("cancelled");
    // The manifest and the rest of the bag survive; the record sits under run.
    expect(row.metadata.prompt).toBe("keep me");
    expect(row.metadata.run.engine).toBe("capture");
    expect(row.metadata.run.promptVersion).toBe("v3");
    expect(row.metadata.run.cancel.state).toBe("done");
    expect(row.metadata.run.cancel.stopped).toHaveLength(3);
    expect(row.metadata.run.cancel.notStoppable).toHaveLength(1);
  });

  it("a failed stop never blocks the cancel — it is recorded with the reason", async () => {
    const { client } = await freshDb();
    const sessionId = await insertSession(client);
    const stoppable = await insertJob(client, {
      name: "import-corpus",
      state: "created",
      data: { userId: USER, sessionId },
    });
    const broken = await insertJob(client, {
      name: "import-corpus",
      state: "created",
      data: { userId: USER, sessionId },
    });
    holder.failCancelFor.add(broken);

    const result = await cancelSession({ sessionId, userId: USER });

    expect(result?.session.status).toBe("cancelled");
    expect(result!.cancel!.stopped.map((s) => s.id)).toEqual([stoppable]);
    expect(result!.cancel!.stopFailed).toEqual([
      expect.objectContaining({
        kind: "job",
        id: broken,
        detail: expect.stringContaining("boss is down"),
      }),
    ]);
    const row = await sessionRow(client, sessionId);
    expect(row.status).toBe("cancelled");
    expect(row.metadata.run.cancel.stopFailed).toHaveLength(1);
  });

  it("…even when the job queue cannot be read at all: the cancel stands, the reply is still stopped", async () => {
    const { client } = await freshDb();
    const channelId = randomUUID();
    const sessionId = await insertSession(client, { channelId });
    const turnId = randomUUID();
    await client.query(
      `insert into chat_turns (id, channel_id, user_id, request_id, user_message_id, assistant_message_id, status, cancel_requested)
       values ($1, $2, $3, $4, $5, $6, 'running', false)`,
      [turnId, channelId, USER, randomUUID(), randomUUID(), randomUUID()]
    );
    await client.exec(`drop schema pgboss cascade`);

    const result = await cancelSession({ sessionId, userId: USER });

    expect(result?.session.status).toBe("cancelled");
    expect(result!.cancel!.stopFailed.map((s) => [s.kind, s.id])).toEqual([
      ["job", "*"],
    ]);
    expect(result!.cancel!.stopped.map((s) => [s.kind, s.id])).toEqual([
      ["chat_turn", turnId],
    ]);
    expect((await sessionRow(client, sessionId)).status).toBe("cancelled");
  });

  it("an agent's cancel that governance turns into a proposal stops NOTHING", async () => {
    const { client } = await freshDb();
    const sessionId = await insertSession(client);
    const queued = await insertJob(client, {
      name: "import-corpus",
      state: "created",
      data: { userId: USER, sessionId },
    });
    vi.mocked(checkPermissionOrPropose).mockResolvedValueOnce({
      proposalId: "proposal-1",
      proposalType: "focus_session.update",
    } as never);

    await expect(
      cancelSession({ sessionId, userId: USER, agentUserId: "agent-1" })
    ).rejects.toMatchObject({ code: "FORBIDDEN", proposalId: "proposal-1" });

    expect(vi.mocked(checkPermissionOrPropose).mock.calls[0]![0]).toMatchObject(
      {
        agentUserId: "agent-1",
        data: { status: "cancelled" },
      }
    );
    expect(await jobState(client, queued)).toBe("created");
    const row = await sessionRow(client, sessionId);
    expect(row.status).toBe("active");
    expect(row.metadata).toEqual({});
  });

  it("an APPROVED focus_session/update cancel proposal reaches the stop", async () => {
    const { client } = await freshDb();
    const sessionId = await insertSession(client);
    const queued = await insertJob(client, {
      name: "import-corpus",
      state: "created",
      data: { userId: USER, sessionId },
    });
    const proposalId = await insertProposal(client, {
      status: "pending",
      data: {},
    });
    const { registerFocusSessionExecutors } =
      await import("../../../routers/proposals/executors/focus-session.js");
    const { proposalExecRegistry } =
      await import("../../../routers/proposals/execution-registry.js");
    if (!proposalExecRegistry.resolveExact("focus_session/update")) {
      registerFocusSessionExecutors();
    }

    await proposalExecRegistry.resolveExact("focus_session/update")!.execute({
      proposal: {
        id: proposalId,
        targetId: sessionId,
        data: { data: { status: "cancelled" } },
      },
      userId: USER,
      input: { proposalId },
      deps: { reportProposalOutcome: vi.fn(), emitProposalReviewed: vi.fn() },
    } as never);

    expect(await jobState(client, queued)).toBe("cancelled");
    const row = await sessionRow(client, sessionId);
    expect(row.status).toBe("cancelled");
    expect(row.metadata.run.cancel.state).toBe("done");
  });

  it("triage discard reaches the stop", async () => {
    const { client } = await freshDb();
    const sessionId = await insertSession(client, { origin: "agent" });
    const queued = await insertJob(client, {
      name: "import-corpus",
      state: "created",
      data: { userId: USER, sessionId },
    });
    const { discardFromTriage } =
      await import("../../focus-sessions/triage.js");

    const result = await discardFromTriage({
      sessionId,
      userId: USER,
    } as never);

    expect(result).toMatchObject({ ok: true });
    expect(await jobState(client, queued)).toBe("cancelled");
    const row = await sessionRow(client, sessionId);
    expect(row.status).toBe("cancelled");
    expect(row.metadata.run.cancel.stopped).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
const THREE_NOTES_TWO_LINKS = [
  { op: "create_entity", ref: "a", profileSlug: "note", title: "Alpha" },
  { op: "create_entity", ref: "b", profileSlug: "note", title: "Beta" },
  { op: "create_entity", ref: "c", profileSlug: "note", title: "Gamma" },
  { op: "create_relation", sourceRef: "a", targetRef: "b", type: "relates_to" },
  { op: "create_relation", sourceRef: "b", targetRef: "c", type: "relates_to" },
] as CompositeProposalOperation[];

async function materialize(
  client: Client,
  database: Database,
  proposalId: string,
  operations: CompositeProposalOperation[] = THREE_NOTES_TWO_LINKS
) {
  const insertEntity = async (title: string) => {
    const id = randomUUID();
    await client.query(
      `insert into entities (id, user_id, type, title, properties, source_proposal_id)
       values ($1, $2, 'note', $3, '{}'::jsonb, $4)`,
      [id, USER, title, proposalId]
    );
    return id;
  };
  const result = await materializeCompositeGraph(
    operations,
    {
      create: async (input: { title?: string }) => ({
        status: "created",
        id: await insertEntity(input.title ?? "Untitled"),
      }),
    },
    {
      create: async (input: {
        sourceEntityId: string;
        targetEntityId: string;
        type: string;
      }) => {
        const id = randomUUID();
        await client.query(
          `insert into relations (id, user_id, source_entity_id, target_entity_id, type, source_proposal_id)
           values ($1, $2, $3, $4, $5, $6)`,
          [
            id,
            USER,
            input.sourceEntityId,
            input.targetEntityId,
            input.type,
            proposalId,
          ]
        );
        return { status: "created", id };
      },
    }
  );
  await stampMaterialized({
    proposalId,
    record: buildMaterializedRecord(result),
    database,
  });
  return new Map(result.entities.map((e) => [e.ref, e.entityId]));
}

async function revertCaller(database: Database) {
  const { proposalsRouter } = await import("../../../routers/proposals.js");
  return proposalsRouter.createCaller({
    db: database,
    authenticated: true,
    userId: USER,
  } as Parameters<typeof proposalsRouter.createCaller>[0]);
}

async function liveEntityIds(client: Client): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `select id from entities where deleted_at is null order by id`
  );
  return rows.map((r) => r.id);
}

async function readProposal(client: Client, id: string) {
  return (
    await client.query<{
      status: string;
      data: { materialized: CompleteMaterializedRecord };
    }>(`select status, data from proposals where id = $1`, [id])
  ).rows[0]!;
}

/** A concurrent writer, landing between the door's read and its write. */
function concurrentWriteDuringReview(client: Client, proposalId: string) {
  vi.mocked(computeCanReviewApproval).mockImplementationOnce(async () => {
    await client.query(
      `update proposals set updated_at = now() + interval '1 second' where id = $1`,
      [proposalId]
    );
    return { allowed: true } as never;
  });
}

describe("revert ONE item of a composite proposal (proposals.revert opKey)", () => {
  it("removes only that op's rows (and the run's own links to it), marks byOp, and a second revert is a no-op", async () => {
    const { client, database } = await freshDb();
    const proposalId = await insertProposal(client, {
      data: { operations: THREE_NOTES_TWO_LINKS },
    });
    const byRef = await materialize(client, database, proposalId);
    const caller = await revertCaller(database);

    const first = await caller.revert({ proposalId, opKey: "a" });

    expect(first).toMatchObject({ success: true, opKey: "a" });
    expect((first as { opKeys: string[] }).opKeys.sort()).toEqual([
      "a",
      "a->b:relates_to",
    ]);
    expect(await liveEntityIds(client)).toEqual(
      [byRef.get("b")!, byRef.get("c")!].sort()
    );
    const rels = await client.query<{ source_entity_id: string }>(
      `select source_entity_id from relations`
    );
    expect(rels.rows.map((r) => r.source_entity_id)).toEqual([byRef.get("b")]);

    const afterFirst = await readProposal(client, proposalId);
    expect(afterFirst.status).toBe("approved");
    const byOp = afterFirst.data.materialized.byOp!;
    expect(byOp.a!.revertedAt).toBeTruthy();
    expect(byOp["a->b:relates_to"]!.revertedAt).toBeTruthy();
    expect(byOp.b!.revertedAt).toBeUndefined();
    expect(byOp["b->c:relates_to"]!.revertedAt).toBeUndefined();
    expect(afterFirst.data.materialized.entityIds).not.toContain(
      byRef.get("a")
    );
    expect(afterFirst.data.materialized.entityIds).toHaveLength(2);

    const second = await caller.revert({ proposalId, opKey: "a" });
    expect(second).toMatchObject({ success: true, alreadyReverted: true });
    const afterSecond = await readProposal(client, proposalId);
    expect(afterSecond.data).toEqual(afterFirst.data);
    expect((await client.query(`select id from relations`)).rows).toHaveLength(
      1
    );
  });

  it("an unknown item is refused with the items that exist", async () => {
    const { client, database } = await freshDb();
    const proposalId = await insertProposal(client, {
      data: { operations: THREE_NOTES_TWO_LINKS },
    });
    await materialize(client, database, proposalId);
    const caller = await revertCaller(database);
    await expect(
      caller.revert({ proposalId, opKey: "zzz" })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("a->b:relates_to"),
    });
  });

  it("a write that lands on the proposal meanwhile ⇒ CONFLICT, and the item undo rolls back whole", async () => {
    const { client, database } = await freshDb();
    const proposalId = await insertProposal(client, {
      data: { operations: THREE_NOTES_TWO_LINKS },
    });
    const byRef = await materialize(client, database, proposalId);
    const before = await readProposal(client, proposalId);
    const caller = await revertCaller(database);
    concurrentWriteDuringReview(client, proposalId);

    await expect(
      caller.revert({ proposalId, opKey: "a" })
    ).rejects.toMatchObject({
      code: "CONFLICT",
    });

    // Nothing of the undo landed: the entity, its link and the record stand.
    expect(await liveEntityIds(client)).toContain(byRef.get("a"));
    expect((await client.query(`select id from relations`)).rows).toHaveLength(
      2
    );
    expect((await readProposal(client, proposalId)).data).toEqual(before.data);
  });
});

describe("whole-proposal revert write", () => {
  it("a write that lands on the proposal meanwhile ⇒ CONFLICT, never a silent overwrite of its record", async () => {
    const { client, database } = await freshDb();
    const proposalId = await insertProposal(client, {
      data: { operations: THREE_NOTES_TWO_LINKS },
    });
    await materialize(client, database, proposalId);
    const caller = await revertCaller(database);
    concurrentWriteDuringReview(client, proposalId);

    await expect(caller.revert({ proposalId })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect((await readProposal(client, proposalId)).status).toBe("approved");
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("revertSession — through the DEFAULT door (proposals.revert)", () => {
  it("an entity edited after its run is reported `skipped`, and stays", async () => {
    const { client, database } = await freshDb();
    const sessionId = await insertSession(client);
    const ops = [
      { op: "create_entity", ref: "n", profileSlug: "note", title: "Note" },
    ] as CompositeProposalOperation[];
    const proposalId = await insertProposal(client, {
      sessionId,
      data: { operations: ops },
    });
    const byRef = await materialize(client, database, proposalId, ops);
    await client.query(
      `update entities set title = 'Note, rewritten', updated_at = now() + interval '1 minute' where id = $1`,
      [byRef.get("n")]
    );

    const result = await revertSession({ sessionId, userId: USER });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposals.map((p) => [p.proposalId, p.outcome])).toEqual([
      [proposalId, "skipped"],
    ]);
    const outcome = result.proposals[0] as {
      skipped: Array<{ reason: string }>;
    };
    expect(outcome.skipped.map((s) => s.reason)).toEqual(["edited_since"]);
    expect(await liveEntityIds(client)).toEqual([byRef.get("n")]);
  });

  it("undoing a later proposal's link bumps the earlier entity (relation → property sync) — the pass's own write is not an edit", async () => {
    const { client, database } = await freshDb();
    const sessionId = await insertSession(client);

    const p1Ops = [
      { op: "create_entity", ref: "e1", profileSlug: "note", title: "First" },
    ] as CompositeProposalOperation[];
    const p1 = await insertProposal(client, {
      sessionId,
      data: { operations: p1Ops },
      createdAt: "now() - interval '1 hour'",
    });
    const e1 = (await materialize(client, database, p1, p1Ops)).get("e1")!;

    // P2 links FROM e1 — e1 is the source the reverse sync rewrites.
    const p2Ops = [
      { op: "create_entity", ref: "e2", profileSlug: "note", title: "Second" },
      {
        op: "create_relation",
        sourceRef: e1,
        targetRef: "e2",
        type: "relates_to",
      },
    ] as CompositeProposalOperation[];
    const p2 = await insertProposal(client, {
      sessionId,
      data: { operations: p2Ops },
    });
    await materialize(client, database, p2, p2Ops);

    // What the real sync does to the source entity: `updated_at = now()` —
    // pushed past the tolerance so it would read as an edit.
    vi.mocked(syncRelationToPropertyOnDelete).mockImplementation(
      async (source) => {
        await client.query(
          `update entities set updated_at = now() + interval '10 seconds' where id = $1`,
          [source]
        );
      }
    );

    try {
      const result = await revertSession({ sessionId, userId: USER });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.proposals.map((p) => [p.proposalId, p.outcome])).toEqual([
        [p2, "reverted"],
        [p1, "reverted"],
      ]);
      expect(await liveEntityIds(client)).toEqual([]);
    } finally {
      vi.mocked(syncRelationToPropertyOnDelete).mockImplementation(
        async () => undefined
      );
    }
  });
});

describe("MCP synap_revert_session — revert is a human decision", () => {
  it("refuses, changes nothing, and hands back a link to each revertable proposal of the session", async () => {
    const { client, database } = await freshDb();
    const sessionId = await insertSession(client);
    const ops = [
      { op: "create_entity", ref: "n", profileSlug: "note", title: "Note" },
    ] as CompositeProposalOperation[];
    const applied = await insertProposal(client, {
      sessionId,
      data: { operations: ops },
    });
    const byRef = await materialize(client, database, applied, ops);
    await insertProposal(client, {
      sessionId,
      status: "pending",
      data: { operations: [] },
    });
    const { sessionHandlers } =
      await import("../../../routers/mcp/handlers/session.js");

    const result = await sessionHandlers.synap_revert_session!({
      toolName: "synap_revert_session",
      args: { sessionId, opKey: "n" },
      userId: USER,
      apiKeyScopes: ["mcp.read"],
      agentUserId: "agent-1",
    } as never);

    const payload = JSON.parse(
      (result.content[0] as { text: string }).text
    ) as {
      status: string;
      reason: string;
      sessionId: string;
      opKey: string;
      revertable: Array<{ proposalId: string; link: string }>;
    };
    expect(payload).toMatchObject({
      status: "refused",
      reason: "revert_is_a_human_decision",
      sessionId,
      opKey: "n",
    });
    // Only the APPLIED proposal is offered, with the human door to it.
    expect(payload.revertable.map((p) => p.proposalId)).toEqual([applied]);
    expect(payload.revertable[0]!.link).toContain(`/open/${applied}`);
    // Nothing moved.
    expect(await liveEntityIds(client)).toEqual([byRef.get("n")]);
    expect((await readProposal(client, applied)).status).toBe("approved");
  });
});

describe("final review fixes", () => {
  it("an externally dispatched proposal: the session revert undoes its local rows AND reports the send permanent — one rule with proposals.revert", async () => {
    const { client, database } = await freshDb();
    const sessionId = await insertSession(client);
    const ops = [
      { op: "create_entity", ref: "x", profileSlug: "note", title: "Sent" },
    ] as CompositeProposalOperation[];
    const proposalId = await insertProposal(client, {
      sessionId,
      data: { operations: ops },
    });
    const byRef = await materialize(client, database, proposalId, ops);
    await client.query(
      `update proposals set external_dispatched_at = now() where id = $1`,
      [proposalId]
    );

    const result = await revertSession({ sessionId, userId: USER });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposals.map((p) => [p.proposalId, p.outcome])).toEqual([
      [proposalId, "permanent"],
    ]);
    // The door ran: the local row is gone, exactly as a single revert would do.
    expect(await liveEntityIds(client)).not.toContain(byRef.get("x"));
    expect((await readProposal(client, proposalId)).status).toBe("reverted");
  });

  it("more jobs than one scan reads: the overflow is recorded as not stopped, never silently dropped", async () => {
    const { client } = await freshDb();
    const sessionId = await insertSession(client);
    for (let i = 0; i < 201; i++) {
      await insertJob(client, {
        name: "import-corpus",
        state: "created",
        data: { userId: USER, sessionId },
      });
    }

    const result = await cancelSession({ sessionId, userId: USER });

    expect(result!.cancel!.stopped).toHaveLength(200);
    expect(result!.cancel!.stopFailed).toEqual([
      expect.objectContaining({
        kind: "job",
        id: "*",
        detail: expect.stringContaining("the rest were not stopped"),
      }),
    ]);
    const { rows } = await client.query<{ n: number }>(
      `select count(*)::int as n from pgboss.job where state = 'created'`
    );
    expect(rows[0]!.n).toBe(1);
  });

  it("REST cancel: another user's session and a missing one answer the SAME 404, and nothing is cancelled", async () => {
    const { client } = await freshDb();
    const theirs = randomUUID();
    // In a workspace the caller is NOT a member of: without the owner floor the
    // route would reach the membership check and answer 403 — telling the
    // caller the session exists. With the floor it never gets that far.
    await client.query(
      `insert into focus_sessions (id, user_id, goal, status, workspace_id) values ($1, 'someone-else', 'Theirs', 'active', $2)`,
      [theirs, randomUUID()]
    );
    const { OpenAPIHono } = await import("@hono/zod-openapi");
    const { registerFocusSessionsRoutes } =
      await import("../../../routers/hub-protocol/rest/focus-sessions.js");
    const app = new OpenAPIHono();
    app.use("*", async (c, next) => {
      c.set("scopes" as never, ["hub-protocol.write"] as never);
      c.set("userId" as never, USER as never);
      await next();
    });
    registerFocusSessionsRoutes(app as never);
    const post = (id: string) =>
      app.request(`/focus-sessions/${id}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
    const missing = randomUUID();

    const [toTheirs, toMissing] = [await post(theirs), await post(missing)];

    expect(toTheirs.status).toBe(404);
    expect(toMissing.status).toBe(404);
    const theirsBody = (await toTheirs.json()) as { error: string };
    const missingBody = (await toMissing.json()) as { error: string };
    expect(theirsBody.error.replace(theirs, "<id>")).toBe(
      missingBody.error.replace(missing, "<id>")
    );
    expect((await sessionRow(client, theirs)).status).toBe("active");
  });

  it("reverting ONE of two ops that enriched the SAME pre-existing entity is refused — no silent over-restore", async () => {
    const { client, database } = await freshDb();
    const ada = randomUUID();
    await client.query(
      `insert into entities (id, user_id, type, title, properties) values ($1, $2, 'person', 'Ada', $3::jsonb)`,
      [ada, USER, JSON.stringify({ role: "engineer", team: "core" })]
    );
    const ops = [
      {
        op: "create_entity",
        ref: "p1",
        profileSlug: "person",
        title: "Ada",
        properties: { role: "cto" },
      },
      {
        op: "create_entity",
        ref: "p2",
        profileSlug: "person",
        title: "Ada L.",
        properties: { team: "infra" },
      },
    ] as CompositeProposalOperation[];
    const proposalId = await insertProposal(client, {
      data: { operations: ops },
    });
    const { computeEntityPropertyDiff } =
      await import("../../../utils/entity-property-diff.js");
    // The entities.create door on a strong-identity match, twice: both ops
    // enrich Ada and report what they overwrote.
    const result = await materializeCompositeGraph(
      ops,
      {
        create: async (input: { properties?: Record<string, unknown> }) => {
          const {
            rows: [prior],
          } = await client.query<{ properties: Record<string, unknown> }>(
            `select properties from entities where id = $1`,
            [ada]
          );
          const applied = input.properties ?? {};
          await client.query(
            `update entities set properties = $1::jsonb where id = $2`,
            [JSON.stringify({ ...prior!.properties, ...applied }), ada]
          );
          return {
            status: "created",
            id: ada,
            deduplicated: true,
            propertyDiff: computeEntityPropertyDiff(
              ada,
              prior!.properties,
              applied
            ),
          };
        },
      },
      { create: async () => ({ status: "created", id: randomUUID() }) }
    );
    await stampMaterialized({
      proposalId,
      record: buildMaterializedRecord(result),
      database,
    });
    const before = await readProposal(client, proposalId);
    expect(before.data.materialized.byOp?.p1).toMatchObject({
      entityId: ada,
      linked: true,
    });
    expect(before.data.materialized.byOp?.p2).toMatchObject({
      entityId: ada,
      linked: true,
    });
    const caller = await revertCaller(database);

    await expect(
      caller.revert({ proposalId, opKey: "p1" })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("'p2'"),
    });

    const {
      rows: [row],
    } = await client.query<{ properties: Record<string, unknown> }>(
      `select properties from entities where id = $1`,
      [ada]
    );
    expect(row!.properties).toEqual({ role: "cto", team: "infra" });
    expect((await readProposal(client, proposalId)).data).toEqual(before.data);
  });
});

describe("revertSession with proposalIds", () => {
  it("reverts only the named proposals and names an id that is not this session's", async () => {
    const { client, database } = await freshDb();
    const sessionId = await insertSession(client);
    const p1 = await insertProposal(client, {
      sessionId,
      data: { operations: [] },
    });
    const p2 = await insertProposal(client, {
      sessionId,
      data: { operations: [] },
    });
    const otherSessions = await insertProposal(client, {
      sessionId: await insertSession(client),
      data: { operations: [] },
    });
    const revertOne = vi.fn(
      async (_proposalId: string) =>
        ({ success: true }) as unknown as ProposalRevertOutput
    );

    const result = await revertSession({
      sessionId,
      userId: USER,
      proposalIds: [p1, otherSessions],
      revertOne,
      database,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(revertOne.mock.calls.map(([id]) => id)).toEqual([p1]);
    expect(
      result.proposals.map((p) => [p.proposalId, p.outcome]).sort()
    ).toEqual(
      [
        [p1, "reverted"],
        [otherSessions, "not_applicable"],
      ].sort()
    );
    expect(result.counts).toMatchObject({ reverted: 1, not_applicable: 1 });
    expect(revertOne).not.toHaveBeenCalledWith(p2);
  });
});
