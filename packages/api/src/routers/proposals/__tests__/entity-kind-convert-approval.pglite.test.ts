/**
 * c-kind-convert (plan 9992207a): an APPROVED kind change reaches the write.
 *
 * Live defect found 2026-10-12: `entities.update` files a kind change
 * (`profileSlug`) as a proposal, but the `entity/update` executor replayed
 * title/description/properties/deleteProperties and DROPPED `profileSlug` — so
 * approving the conversion reported success and the entity kept its kind.
 *
 * Driven through the REAL executor on PGlite (same harness as
 * entity-update-undo.pglite.test.ts); the entities door is captured.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const holder = vi.hoisted(() => ({
  db: undefined as unknown,
  updateArgs: [] as Array<Record<string, unknown>>,
}));

// The seam under test is the executor's hand-off to the entities door, so the
// door itself is captured, not run (kind resolution needs the profile tables
// this harness does not build — `entities.update` has its own suites).
vi.mock("../../entities.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>();
  return {
    ...actual,
    entitiesRouter: {
      ...actual.entitiesRouter,
      createCaller: (ctx: unknown) => ({
        ...actual.entitiesRouter.createCaller(ctx),
        update: async (args: Record<string, unknown>) => {
          holder.updateArgs.push(args);
          return { status: "updated", written: null };
        },
      }),
    },
  };
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = {
    ...actual,
    registerIdentitySignals: async () => undefined,
    getDb: async () => holder.db,
    // Hookless: the realtime fan-out is not under test.
    eventRepository: { append: async () => undefined },
  };
  Object.defineProperty(mocked, "db", {
    get: () => holder.db,
    enumerable: true,
  });
  return mocked;
});
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
  getBoss: () => ({ send: async () => null }),
}));
vi.mock("../../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: vi.fn(async () => ({ granted: true })),
}));
vi.mock("../review-authority.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  computeCanReviewApproval: vi.fn(async () => ({ allowed: true })),
}));
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
import { registerEntityExecutors } from "../executors/entity.js";
import { proposalExecRegistry } from "../execution-registry.js";

const USER = "user-1";
type Database = typeof DatabaseHandle;

/** CREATE TABLE from the drizzle definition — columns, types and literal defaults. */
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
  // A KNOWN principal (Sites W2 S2): an id with no `users` row is an unknown
  // principal and reads no pod-level row — `podReaderWhere`.
  await client.exec(
    `insert into users (id, email) values ('${USER}', '${USER}@example.test')`
  );
  const database = drizzle(client, {
    schema: { entities, proposals, workspaces, workspaceMembers },
  }) as unknown as Database;
  holder.db = database;
  return { client, database };
}

async function insertEntity(client: PGlite): Promise<string> {
  const id = randomUUID();
  await client.query(
    `insert into entities (id, user_id, type, title, preview, properties)
     values ($1, $2, 'note', 'Old title', 'Old description', $3::jsonb)`,
    [id, USER, JSON.stringify({ stage: "lead", owner: "ann", gone: "x" })]
  );
  return id;
}

async function proposalRow(client: PGlite, id: string) {
  return (
    await client.query<{
      id: string;
      status: string;
      target_type: string;
      target_id: string;
      proposal_type: string;
      data: Record<string, any>;
    }>(
      `select id, status, target_type, target_id, proposal_type, data from proposals where id = $1`,
      [id]
    )
  ).rows[0]!;
}

async function pendingKindChange(
  client: PGlite,
  entityId: string,
  extra: Record<string, unknown>
) {
  const id = randomUUID();
  await client.query(
    `insert into proposals (id, status, proposal_type, target_type, target_id, data, created_by, subject_user_id)
     values ($1, 'pending', 'update', 'entity', $2, $3::jsonb, 'agent-1', $4)`,
    [
      id,
      entityId,
      JSON.stringify({
        changeType: "update",
        targetType: "entity",
        data: { id: entityId, ...extra },
      }),
      USER,
    ]
  );
  return id;
}

async function approve(client: PGlite, proposalId: string) {
  const row = await proposalRow(client, proposalId);
  await proposalExecRegistry.resolveExact("entity/update")!.execute({
    proposal: {
      id: row.id,
      targetType: row.target_type,
      targetId: row.target_id,
      proposalType: row.proposal_type,
      workspaceId: null,
      agentUserId: "agent-1",
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
  holder.updateArgs = [];
});

describe("entity/update executor — a kind change is applied, not dropped", () => {
  it("forwards profileSlug with the rest of the patch", async () => {
    const { client } = await freshDb();
    const entityId = await insertEntity(client);
    await approve(
      client,
      await pendingKindChange(client, entityId, {
        profileSlug: "decision",
        properties: { decisionStatus: "decided" },
      })
    );
    expect(holder.updateArgs).toHaveLength(1);
    expect(holder.updateArgs[0]).toMatchObject({
      id: entityId,
      profileSlug: "decision",
    });
  });

  it("CONTROL: an ordinary update carries no profileSlug", async () => {
    const { client } = await freshDb();
    const entityId = await insertEntity(client);
    await approve(
      client,
      await pendingKindChange(client, entityId, { title: "Renamed" })
    );
    expect(holder.updateArgs[0]).not.toHaveProperty("profileSlug");
  });
});
