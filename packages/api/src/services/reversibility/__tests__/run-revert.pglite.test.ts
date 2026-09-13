/**
 * RUN-SCOPED REVERSIBILITY — driven through the real seam, on a real Postgres.
 *
 * materializeCompositeGraph (real) → buildMaterializedRecord + stampMaterialized
 * (real, into a real `proposals` row) → planProposalRevert (real, reading that
 * row back) → revertProposalCreations → safeRevert (real SQL, real transaction).
 * Nothing downstream of the materializer is hand-built: the record the planner
 * reads is the one the stamp wrote.
 *
 * ENGINE: PGlite — real Postgres in-process (the same engine the database
 * package's conversion integration test uses). The api suite has no live
 * Postgres; the tables below carry only the columns these paths touch.
 *
 * What is stubbed, and why:
 *  - the entity / relation create DOORS. The materializer takes injected
 *    callers by design; these insert rows the way the doors do (with
 *    `source_proposal_id` lineage). The merge case returns the `propertyDiff`
 *    `entities.create` reports, computed by the same helper it uses.
 *  - post-commit event fan-out (`recordDomainMutation`, relation→property sync)
 *    — side effects with their own suites.
 *  - `registerIdentitySignals` (identity-signal table not modelled here).
 *
 * NOT covered here (NEEDS-DOGFOOD): the `proposals.revert` tRPC door's authority
 * + status flip, and the session revert's default door (`proposals.revert`) —
 * the session test injects the per-proposal step.
 */

import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("../../../utils/domain-mutation.js", () => ({
  recordDomainMutation: vi.fn(async () => null),
}));
vi.mock("../../../utils/property-relation-sync.js", () => ({
  syncRelationToPropertyOnDelete: vi.fn(async () => undefined),
}));
vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  registerIdentitySignals: vi.fn(async () => undefined),
}));

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { proposals, type db as DatabaseHandle } from "@synap/database";
import type { CompositeProposalOperation } from "@synap-core/types/proposals";
import { materializeCompositeGraph } from "../../../utils/materialize-composite.js";
import { computeEntityPropertyDiff } from "../../../utils/entity-property-diff.js";
import { makeExternalLinkIdempotency } from "../../../utils/entity-link-idempotency.js";
import {
  buildMaterializedRecord,
  stampMaterialized,
  type CompleteMaterializedRecord,
} from "../../proposals/stamp-materialized.js";
import { planProposalRevert } from "../../../routers/proposals/revert.js";
import { revertProposalCreations } from "../../proposals/revert-creations.js";
import { revertSession } from "../../focus-sessions/revert-session.js";

const USER = "user-1";

const DDL = `
  create table entities (
    id uuid primary key, user_id text not null, workspace_id uuid,
    profile_id uuid, type text not null, title text,
    document_id uuid, properties jsonb not null default '{}'::jsonb,
    source_proposal_id uuid,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    deleted_at timestamptz
  );
  create table relations (
    id uuid primary key, user_id text not null, workspace_id uuid,
    source_entity_id uuid, target_entity_id uuid, type text not null,
    source_proposal_id uuid,
    created_at timestamptz not null default now()
  );
  create table entity_facets (
    id uuid primary key, entity_id uuid not null, user_id text not null,
    source_proposal_id uuid,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    deleted_at timestamptz
  );
  create table links (
    id uuid primary key default gen_random_uuid(), workspace_id uuid,
    from_type text not null, from_id text not null,
    to_type text not null, to_id text not null, link_type text not null
  );
  create table proposals (
    id uuid primary key, workspace_id text, session_id uuid,
    status text not null, proposal_type text not null,
    target_type text not null default 'entity', target_id text not null,
    data jsonb not null, external_dispatched_at timestamptz,
    created_at timestamptz not null default now()
  );
  create table focus_sessions (id uuid primary key, user_id text not null);
  -- The idempotency lookup's owner floor reads connection owners from here.
  create table secrets (id uuid primary key default gen_random_uuid(), user_id text not null);
  create table entity_external_links (
    id uuid primary key default gen_random_uuid(), entity_id uuid not null,
    provider text not null, external_id text not null,
    nango_connection_id text not null, status text not null default 'active',
    sync_hash text, url text, last_synced_at timestamptz, disconnected_at timestamptz,
    created_at timestamptz not null default now()
  );
  -- Migration 0261's key — the writer's ON CONFLICT target (exact match).
  create unique index entity_external_links_provider_external_id_connection_idx
    on entity_external_links (provider, external_id, nango_connection_id);
`;

type Database = typeof DatabaseHandle;

async function freshDb() {
  const client = new PGlite();
  await client.exec(DDL);
  const database = drizzle(client, {
    schema: { proposals },
  }) as unknown as Database;
  return { client, database };
}

async function insertEntity(
  client: PGlite,
  opts: {
    id?: string;
    title: string;
    properties?: Record<string, unknown>;
    sourceProposalId?: string | null;
  }
): Promise<string> {
  const id = opts.id ?? randomUUID();
  await client.query(
    `insert into entities (id, user_id, type, title, properties, source_proposal_id)
     values ($1, $2, 'note', $3, $4::jsonb, $5)`,
    [
      id,
      USER,
      opts.title,
      JSON.stringify(opts.properties ?? {}),
      opts.sourceProposalId ?? null,
    ]
  );
  return id;
}

async function insertProposal(
  client: PGlite,
  opts: {
    id: string;
    data: Record<string, unknown>;
    sessionId?: string;
    status?: string;
    createdAt?: string;
    externalDispatched?: boolean;
  }
) {
  await client.query(
    `insert into proposals (id, session_id, status, proposal_type, target_id, data, created_at, external_dispatched_at)
     values ($1, $2, $3, 'import.graph', $4, $5::jsonb, ${opts.createdAt ?? "now()"}, ${
       opts.externalDispatched ? "now()" : "null"
     })`,
    [
      opts.id,
      opts.sessionId ?? null,
      opts.status ?? "approved",
      // The placeholder target a graph proposal is minted with — never a row.
      randomUUID(),
      JSON.stringify(opts.data),
    ]
  );
}

/** The create doors, as the materializer sees them: rows land with lineage. */
function doorsFor(
  client: PGlite,
  proposalId: string,
  opts: { relationCreatedAt?: string } = {}
) {
  return {
    entityCaller: {
      create: async (input: {
        title?: string;
        properties?: Record<string, unknown>;
      }) => {
        const id = await insertEntity(client, {
          title: input.title ?? "Untitled",
          properties: input.properties,
          sourceProposalId: proposalId,
        });
        return { status: "created", id };
      },
    },
    relationCaller: {
      create: async (input: {
        sourceEntityId: string;
        targetEntityId: string;
        type: string;
      }) => {
        const id = randomUUID();
        await client.query(
          `insert into relations (id, user_id, source_entity_id, target_entity_id, type, source_proposal_id, created_at)
           values ($1, $2, $3, $4, $5, $6, ${opts.relationCreatedAt ?? "now()"})`,
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
    },
  };
}

async function materializeAndStamp(
  client: PGlite,
  database: Database,
  proposalId: string,
  operations: CompositeProposalOperation[],
  doors = doorsFor(client, proposalId)
) {
  const result = await materializeCompositeGraph(
    operations,
    doors.entityCaller,
    doors.relationCaller
  );
  await stampMaterialized({
    proposalId,
    record: buildMaterializedRecord(result),
    database,
  });
  return result;
}

/** Plan from the STORED row, then run the undo — the revert door's core. */
async function revertStored(
  client: PGlite,
  database: Database,
  proposalId: string
) {
  const {
    rows: [row],
  } = await client.query<{
    id: string;
    status: string;
    target_type: string;
    target_id: string;
    proposal_type: string;
    workspace_id: string | null;
    session_id: string | null;
    data: unknown;
  }>(`select * from proposals where id = $1`, [proposalId]);
  const plan = planProposalRevert({
    status: row!.status,
    targetType: row!.target_type,
    targetId: row!.target_id,
    proposalType: row!.proposal_type,
    data: row!.data,
  });
  if (plan.kind !== "delete-creations") {
    throw new Error(`expected delete-creations, planner said ${plan.kind}`);
  }
  return revertProposalCreations({
    proposal: {
      id: row!.id,
      workspaceId: row!.workspace_id,
      sessionId: row!.session_id,
      data: row!.data,
    },
    plan,
    userId: USER,
    database,
  });
}

async function liveEntityIds(client: PGlite): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `select id from entities where deleted_at is null order by id`
  );
  return rows.map((r) => r.id);
}

async function relationIds(client: PGlite): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `select id from relations order by id`
  );
  return rows.map((r) => r.id);
}

const THREE_NOTES_TWO_LINKS = [
  { op: "create_entity", ref: "a", profileSlug: "note", title: "Alpha" },
  { op: "create_entity", ref: "b", profileSlug: "note", title: "Beta" },
  { op: "create_entity", ref: "c", profileSlug: "note", title: "Gamma" },
  { op: "create_relation", sourceRef: "a", targetRef: "b", type: "relates_to" },
  { op: "create_relation", sourceRef: "b", targetRef: "c", type: "relates_to" },
] as CompositeProposalOperation[];

describe("run-scoped revert (real materializer → stamped record → planner → safeRevert)", () => {
  it("an import of 3 entities + 2 relations reverts exactly those rows, and nothing else", async () => {
    const { client, database } = await freshDb();
    // Somebody else's graph — must survive untouched.
    const otherA = await insertEntity(client, { title: "Not ours A" });
    const otherB = await insertEntity(client, { title: "Not ours B" });
    const otherLink = randomUUID();
    await client.query(
      `insert into relations (id, user_id, source_entity_id, target_entity_id, type) values ($1, $2, $3, $4, 'relates_to')`,
      [otherLink, USER, otherA, otherB]
    );

    const proposalId = randomUUID();
    await insertProposal(client, {
      id: proposalId,
      data: { operations: THREE_NOTES_TWO_LINKS },
    });
    const result = await materializeAndStamp(
      client,
      database,
      proposalId,
      THREE_NOTES_TWO_LINKS
    );
    const createdIds = result.entities.map((e) => e.entityId);
    expect(createdIds).toHaveLength(3);

    const outcome = await revertStored(client, database, proposalId);

    expect(outcome.skipped).toEqual([]);
    expect([...(outcome.undone.entityIds ?? [])].sort()).toEqual(
      [...createdIds].sort()
    );
    expect(outcome.undone.relationIds).toHaveLength(2);
    // Database reality: only the unrelated graph is left.
    expect(await liveEntityIds(client)).toEqual([otherA, otherB].sort());
    expect(await relationIds(client)).toEqual([otherLink]);
    // The record now names nothing live.
    expect(outcome.remaining.entityIds).toEqual([]);
    expect(outcome.remaining.relationIds).toEqual([]);
  });

  it("a crash between create and stamp: the retry links the proposal's own rows, the record counts them created, and revert removes them", async () => {
    const { client, database } = await freshDb();
    // An entity the run did NOT create — linked on purpose, never undone.
    const outsider = await insertEntity(client, { title: "Already there" });
    const proposalId = randomUUID();
    const ops = [
      ...THREE_NOTES_TWO_LINKS,
      {
        op: "create_entity",
        ref: "x",
        profileSlug: "note",
        title: "Already there",
        existingEntityId: outsider,
      },
      {
        op: "create_relation",
        sourceRef: "a",
        targetRef: "x",
        type: "relates_to",
      },
    ] as CompositeProposalOperation[];
    await insertProposal(client, { id: proposalId, data: { operations: ops } });
    const keyed = () =>
      makeExternalLinkIdempotency(database, {
        namespace: `${USER}:${proposalId}`,
        provider: "proposal",
        userId: USER,
        sourceProposalId: proposalId,
      });
    const doors = doorsFor(client, proposalId);

    // Attempt 1 creates everything, then dies before the record is stamped.
    const first = await materializeCompositeGraph(
      ops,
      doors.entityCaller,
      doors.relationCaller,
      undefined,
      { idempotency: keyed() }
    );
    const createdIds = first.entities
      .filter((e) => !e.linked)
      .map((e) => e.entityId);
    expect(createdIds).toHaveLength(3);

    // The retry links what attempt 1 made — and it is the attempt that stamps.
    const retry = await materializeCompositeGraph(
      ops,
      doors.entityCaller,
      doors.relationCaller,
      undefined,
      { idempotency: keyed() }
    );
    expect(
      retry.entities
        .filter((e) => e.linkedByRetry)
        .map((e) => e.entityId)
        .sort()
    ).toEqual([...createdIds].sort());
    const x = retry.entities.find((e) => e.ref === "x");
    expect(x).toMatchObject({ entityId: outsider, linked: true });
    expect(x?.linkedByRetry).toBeUndefined();
    await stampMaterialized({
      proposalId,
      record: buildMaterializedRecord(retry),
      database,
    });

    const outcome = await revertStored(client, database, proposalId);

    expect(outcome.skipped).toEqual([]);
    expect([...(outcome.undone.entityIds ?? [])].sort()).toEqual(
      [...createdIds].sort()
    );
    expect(await liveEntityIds(client)).toEqual([outsider]);
    expect(await relationIds(client)).toEqual([]);
  });

  it("a key hit on a row this proposal did NOT create stays `linked` — never counted created, never reverted", async () => {
    const { client, database } = await freshDb();
    const proposalId = randomUUID();
    // A live row under this proposal's key, written by someone else (no
    // lineage) — e.g. an earlier door that registered the same namespace.
    const foreign = await insertEntity(client, { title: "Alpha" });
    const idem = makeExternalLinkIdempotency(database, {
      namespace: `${USER}:${proposalId}`,
      provider: "proposal",
      userId: USER,
      sourceProposalId: proposalId,
    });
    await idem.register(foreign, "proposal", `${USER}:${proposalId}:a`);

    const ops = [
      { op: "create_entity", ref: "a", profileSlug: "note", title: "Alpha" },
    ] as CompositeProposalOperation[];
    await insertProposal(client, { id: proposalId, data: { operations: ops } });
    const doors = doorsFor(client, proposalId);
    const result = await materializeCompositeGraph(
      ops,
      doors.entityCaller,
      doors.relationCaller,
      undefined,
      { idempotency: idem }
    );
    expect(result.entities[0]).toMatchObject({
      entityId: foreign,
      linked: true,
    });
    expect(result.entities[0]?.linkedByRetry).toBeUndefined();

    const record = buildMaterializedRecord(result);
    expect(record.entityIds).toEqual([]);
    await stampMaterialized({ proposalId, record, database });
    const revertOutcome = await planProposalRevert({
      status: "approved",
      targetType: "entity",
      targetId: randomUUID(),
      proposalType: "import.graph",
      data: { operations: ops, materialized: record },
    });
    // Nothing of this run's to undo — and the foreign row is still live.
    expect(revertOutcome.kind).not.toBe("delete-creations");
    expect(await liveEntityIds(client)).toEqual([foreign]);
  });

  it("the stored record names what each op produced, keyed by op, and a retry's stamp keeps the first attempt's creations", async () => {
    const { client, database } = await freshDb();
    const proposalId = randomUUID();
    await insertProposal(client, {
      id: proposalId,
      data: { operations: THREE_NOTES_TWO_LINKS },
    });
    const result = await materializeAndStamp(
      client,
      database,
      proposalId,
      THREE_NOTES_TWO_LINKS
    );
    const byRef = new Map(result.entities.map((e) => [e.ref, e.entityId]));
    const readByOp = async () => {
      const {
        rows: [row],
      } = await client.query<{
        data: { materialized: CompleteMaterializedRecord };
      }>(`select data from proposals where id = $1`, [proposalId]);
      return row!.data.materialized.byOp;
    };
    const stored = await readByOp();
    const { rows: rels } = await client.query<{
      id: string;
      source_entity_id: string;
      target_entity_id: string;
    }>(`select id, source_entity_id, target_entity_id from relations`);
    const relId = (from: string, to: string) =>
      rels.find(
        (r) =>
          r.source_entity_id === byRef.get(from) &&
          r.target_entity_id === byRef.get(to)
      )!.id;
    // The flat lists stay (relay/browser read them) — the map is additive.
    expect(Object.keys(stored ?? {}).sort()).toEqual(
      ["a", "a->b:relates_to", "b", "b->c:relates_to", "c"].sort()
    );
    expect(stored).toMatchObject({
      a: { op: "create_entity", entityId: byRef.get("a"), linked: false },
      b: { op: "create_entity", entityId: byRef.get("b"), linked: false },
      c: { op: "create_entity", entityId: byRef.get("c"), linked: false },
      "a->b:relates_to": { op: "create_relation", relationId: relId("a", "b") },
      "b->c:relates_to": { op: "create_relation", relationId: relId("b", "c") },
    });

    // A retry links what the first attempt created: its own result says
    // `linked`. Stamping it must not relabel the first attempt's rows.
    await stampMaterialized({
      proposalId,
      record: buildMaterializedRecord({
        entities: result.entities.map((e) => ({ ...e, linked: true })),
        relations: [],
      }),
      database,
    });
    const afterRetry = await readByOp();
    expect(afterRetry?.a).toMatchObject({
      entityId: byRef.get("a"),
      linked: false,
    });
    expect(afterRetry?.["a->b:relates_to"]).toMatchObject({
      relationId: relId("a", "b"),
    });
  });

  it("an entity edited after the run is SKIPPED with the reason; the rest is reverted", async () => {
    const { client, database } = await freshDb();
    const proposalId = randomUUID();
    await insertProposal(client, {
      id: proposalId,
      data: { operations: THREE_NOTES_TWO_LINKS },
    });
    const result = await materializeAndStamp(
      client,
      database,
      proposalId,
      THREE_NOTES_TWO_LINKS
    );
    const byRef = new Map(result.entities.map((e) => [e.ref, e.entityId]));
    const beta = byRef.get("b")!;

    // The user edits Beta after the run.
    await client.query(
      `update entities set title = 'Beta, rewritten', updated_at = now() + interval '1 minute' where id = $1`,
      [beta]
    );

    const outcome = await revertStored(client, database, proposalId);

    expect(outcome.skipped).toEqual([
      {
        target: { kind: "entity", id: beta },
        reason: "edited_since",
        detail: "the entity was edited after it was created",
      },
    ]);
    expect(await liveEntityIds(client)).toEqual([beta]);
    // Both edges were the run's own, untouched — they go.
    expect(await relationIds(client)).toEqual([]);
    // The record keeps naming what is still live, so it stays revertable later.
    expect(outcome.remaining.entityIds).toEqual([beta]);
  });

  it("a merged entity is never deleted: the properties the run overwrote are restored, a key edited since is kept", async () => {
    const { client, database } = await freshDb();
    const ada = await insertEntity(client, {
      title: "Ada",
      properties: { email: "ada@example.com", role: "engineer", team: "core" },
    });

    const proposalId = randomUUID();
    const operations = [
      {
        op: "create_entity",
        ref: "p",
        profileSlug: "person",
        title: "Ada Lovelace",
        properties: {
          email: "ada@example.com",
          role: "cto",
          team: "infra",
          city: "London",
        },
      },
    ] as CompositeProposalOperation[];
    await insertProposal(client, { id: proposalId, data: { operations } });

    // The entities.create door on a strong-identity match: enrich the matched
    // entity, report `deduplicated` + what it overwrote.
    const doors = doorsFor(client, proposalId);
    doors.entityCaller.create = async (input) => {
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
      } as unknown as { status: string; id: string };
    };
    await materializeAndStamp(client, database, proposalId, operations, doors);

    // The user changes `team` after the run.
    await client.query(
      `update entities set properties = jsonb_set(properties, '{team}', '"platform"') where id = $1`,
      [ada]
    );

    const outcome = await revertStored(client, database, proposalId);

    const {
      rows: [after],
    } = await client.query<{
      properties: Record<string, unknown>;
      deleted_at: Date | null;
    }>(`select properties, deleted_at from entities where id = $1`, [ada]);
    expect(after!.deleted_at).toBeNull();
    expect(after!.properties).toEqual({
      email: "ada@example.com",
      role: "engineer", // restored
      team: "platform", // edited since — kept
      // city: absent before the run — removed
    });
    expect(outcome.skipped.map((s) => [s.target.kind, s.reason])).toEqual([
      ["property", "edited_since"],
    ]);
    expect(outcome.undone.entityIds).toEqual([]);
  });
});

describe("revertSession — everything a run applied", () => {
  it("reverts every applied proposal newest-first, reports the external one as permanent, ignores the rest", async () => {
    const { client, database } = await freshDb();
    const sessionId = randomUUID();
    await client.query(
      `insert into focus_sessions (id, user_id) values ($1, $2)`,
      [sessionId, USER]
    );

    // P1 (older) creates e1.
    const p1 = randomUUID();
    const p1Ops = [
      { op: "create_entity", ref: "e1", profileSlug: "note", title: "First" },
    ] as CompositeProposalOperation[];
    await insertProposal(client, {
      id: p1,
      sessionId,
      data: { operations: p1Ops },
      createdAt: "now() - interval '1 hour'",
    });
    const p1Result = await materializeAndStamp(client, database, p1, p1Ops);
    const e1 = p1Result.entities[0]!.entityId;

    // P2 (newer) creates e2 and LINKS it to e1 — later than P1's stamp, so if
    // P1 were reverted first, e1 would read as "linked since" and be skipped.
    const p2 = randomUUID();
    const p2Ops = [
      { op: "create_entity", ref: "e2", profileSlug: "note", title: "Second" },
      {
        op: "create_relation",
        sourceRef: "e2",
        targetRef: e1,
        type: "relates_to",
      },
    ] as CompositeProposalOperation[];
    await insertProposal(client, {
      id: p2,
      sessionId,
      data: { operations: p2Ops },
      createdAt: "now() - interval '1 minute'",
    });
    await materializeAndStamp(
      client,
      database,
      p2,
      p2Ops,
      doorsFor(client, p2, {
        relationCreatedAt: "now() + interval '10 seconds'",
      })
    );

    // P3 (newest) dispatched an external side effect.
    const p3 = randomUUID();
    await insertProposal(client, {
      id: p3,
      sessionId,
      data: { operations: p1Ops },
      externalDispatched: true,
    });
    // A pending proposal of the same session — nothing applied, not touched.
    const pending = randomUUID();
    await insertProposal(client, {
      id: pending,
      sessionId,
      status: "pending",
      data: { operations: p1Ops },
    });

    // The per-proposal step, answering in the `proposals.revert` wire shape.
    const revertOne = vi.fn(async (proposalId: string) => {
      // The external one goes through the door like every other proposal: the
      // door undoes its local rows and reports the send as permanent (this one
      // never materialized here, so there is nothing local to undo).
      if (proposalId === p3) {
        return {
          success: true,
          reverted: { entityIds: [], relationIds: [], documentIds: [] },
          permanent: {
            reason: "external_dispatched" as const,
            at: new Date().toISOString(),
          },
        } as unknown as import("../../focus-sessions/revert-session.js").ProposalRevertOutput;
      }
      const outcome = await revertStored(client, database, proposalId);
      const reverted = (outcome.undone.entityIds?.length ?? 0) > 0;
      const stillThere = outcome.skipped.map((s) => s.detail);
      // Hand-built on purpose (this suite pins the ORDER); the real door is
      // driven in cancel-and-item-revert.pglite.test.ts.
      return (reverted
        ? {
            success: true,
            ...(stillThere.length ? { partialFailures: stillThere } : {}),
          }
        : {
            success: false,
            nothingReverted: true,
            partialFailures: stillThere,
          }) as unknown as import("../../focus-sessions/revert-session.js").ProposalRevertOutput;
    });

    const result = await revertSession({
      sessionId,
      userId: USER,
      revertOne,
      database,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(revertOne.mock.calls.map(([id]) => id)).toEqual([p3, p2, p1]);
    expect(result.proposals.map((p) => [p.proposalId, p.outcome])).toEqual([
      [p3, "permanent"],
      [p2, "reverted"],
      [p1, "reverted"],
    ]);
    expect(result.counts).toMatchObject({
      reverted: 2,
      permanent: 1,
      skipped: 0,
    });
    expect(await liveEntityIds(client)).toEqual([]);
    expect(await relationIds(client)).toEqual([]);
  });

  it("refuses a session the caller does not own", async () => {
    const { client, database } = await freshDb();
    const sessionId = randomUUID();
    await client.query(
      `insert into focus_sessions (id, user_id) values ($1, 'someone-else')`,
      [sessionId]
    );
    const revertOne = vi.fn();
    const result = await revertSession({
      sessionId,
      userId: USER,
      revertOne,
      database,
    });
    expect(result).toEqual({ ok: false, reason: "not_found" });
    expect(revertOne).not.toHaveBeenCalled();
  });
});

describe("idempotency never re-links a reverted (soft-deleted) entity", () => {
  it("a key whose entity was reverted is a miss, and the re-created entity takes the key over", async () => {
    const { client, database } = await freshDb();
    const idem = makeExternalLinkIdempotency(database, {
      namespace: `${USER}:import-key`,
      provider: "import",
      userId: USER,
    });
    const key = `${USER}:import-key:a`;

    const first = await insertEntity(client, { title: "Alpha" });
    await idem.register(first, "import", key);
    expect(await idem.lookup("import", key)).toBe(first);

    // The run is reverted: the entity is soft-deleted, the key row remains.
    await client.query(`update entities set deleted_at = now() where id = $1`, [
      first,
    ]);
    // Re-apply after reopen: the key must NOT link the deleted row.
    expect(await idem.lookup("import", key)).toBeNull();

    const second = await insertEntity(client, { title: "Alpha" });
    await idem.register(second, "import", key);
    expect(await idem.lookup("import", key)).toBe(second);

    // A LIVE key is never re-pointed (the retry-safe DoNothing behaviour).
    const third = await insertEntity(client, { title: "Alpha again" });
    await idem.register(third, "import", key);
    expect(await idem.lookup("import", key)).toBe(second);
  });
});
