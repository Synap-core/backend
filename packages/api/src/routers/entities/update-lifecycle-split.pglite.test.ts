/**
 * LIFECYCLE SPLIT in the real `entities.update` door (PGlite), work model L2:
 *  - the kind's lifecycle key is handed to `moveStatus` and NEVER patched by
 *    the generic update (the other keys are);
 *  - a stale move (CONFLICT) rejects the whole call before anything is written;
 *  - a status-only call writes nothing else.
 * `moveStatus` itself is a recorder here (its own suites prove it).
 */

import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";

const holder = vi.hoisted(() => ({
  db: undefined as unknown,
  move: undefined as unknown as import("vitest").Mock,
}));
holder.move = vi.fn();

vi.mock("../../services/lifecycle/move-status.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  moveStatus: (...a: unknown[]) => holder.move(...a),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = {
    ...actual,
    registerIdentitySignals: async () => undefined,
    getDb: async () => holder.db,
    // Hookless: the realtime fan-out is not under test.
    eventRepository: { append: async () => undefined },
    // The deal kind declares `commercialStage` as its lifecycle.
    ProfileResolutionService: class extends (actual.ProfileResolutionService as new (
      db: unknown
    ) => object) {
      async getEffectiveLifecycle(profileId: string) {
        return profileId === "11111111-1111-4111-8111-111111111111"
          ? { propertySlug: "commercialStage", options: [] }
          : null;
      }
    },
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
vi.mock("../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: vi.fn(async () => ({ granted: true })),
}));
vi.mock("../proposals/review-authority.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  computeCanReviewApproval: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("../../lib/event-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  logEvent: vi.fn(async () => undefined),
}));
vi.mock("../../utils/domain-event-bridge.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitHubRealtimeEvent: vi.fn(),
}));
vi.mock("../../utils/audit-log.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  auditLog: vi.fn(async () => undefined),
}));
vi.mock("../../utils/domain-mutation.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recordDomainMutation: vi.fn(async () => null),
}));
vi.mock("../../utils/split-brain-service.js", async (importOriginal) => ({
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
vi.mock("../../utils/property-relation-sync.js", async (importOriginal) => ({
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
  profiles,
  propertyDefs,
  profileProperties,
  type db as DatabaseHandle,
} from "@synap/database";

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
    profiles,
    propertyDefs,
    profileProperties,
  ]) {
    await client.exec(ddlFor(table as unknown as PgTable));
  }
  // A KNOWN principal (Sites W2 S2): an id with no `users` row is an unknown
  // principal and reads no pod-level row — `podReaderWhere`.
  await client.exec(
    `insert into users (id, email) values ('${USER}', '${USER}@example.test')`
  );
  const database = drizzle(client, {
    schema: {
      entities,
      proposals,
      workspaces,
      workspaceMembers,
      profiles,
      propertyDefs,
      profileProperties,
    },
  }) as unknown as Database;
  holder.db = database;
  return { client, database };
}

const DEAL = "11111111-1111-4111-8111-111111111111";
async function insertDeal(client: PGlite): Promise<string> {
  const id = randomUUID();
  await client.query(
    `insert into entities (id, user_id, type, profile_id, title, status, status_category, properties)
     values ($1, $2, 'deal', $3, 'Deal', 'draft', 'open', $4::jsonb)`,
    [id, USER, DEAL, JSON.stringify({ commercialStage: "draft", note: "a" })]
  );
  return id;
}
async function props(client: PGlite, id: string) {
  const r = await client.query<{ properties: Record<string, unknown> }>(
    `select properties from entities where id = $1`,
    [id]
  );
  return r.rows[0]!.properties;
}
async function callerFor(
  database: unknown,
  extra: Record<string, unknown> = {}
) {
  const { entitiesRouter } = await import("../entities.js");
  return entitiesRouter.createCaller({
    db: database,
    authenticated: true,
    userId: USER,
    workspaceId: null,
    ...extra,
  } as never);
}

describe("entities.update — the lifecycle split", () => {
  it("a hub key with no agent moves as an UNATTRIBUTED agent; a wire client cannot claim the system", async () => {
    const { client, database } = await freshDb();
    const id = await insertDeal(client);
    holder.move.mockReset();
    holder.move.mockResolvedValue({ status: "moved", transition: {} });
    const hub = await callerFor(database, {
      source: "intelligence",
      isHubProtocol: true,
    });
    await hub.update({
      id,
      properties: { commercialStage: "lost" },
      source: "intelligence",
    });
    expect(holder.move.mock.calls[0]![0].actor).toEqual({
      kind: "agent",
      userId: USER,
      agentUserId: null,
    });
    const wire = await callerFor(database, { req: {} });
    await wire.update({
      id,
      properties: { commercialStage: "lost" },
      source: "system",
    });
    expect(holder.move.mock.calls[1]![0].actor).toEqual({
      kind: "human",
      userId: USER,
    });
  });

  it("hands the status to moveStatus and patches only the other keys", async () => {
    const { client, database } = await freshDb();
    const id = await insertDeal(client);
    holder.move.mockReset();
    holder.move.mockResolvedValue({ status: "moved", transition: {} });
    const caller = await callerFor(database);
    await caller.update({
      id,
      properties: { commercialStage: "won", note: "b" },
      expectedStatus: "draft",
      agentUserId: "22222222-2222-4222-8222-222222222222",
    });
    expect(holder.move).toHaveBeenCalledTimes(1);
    expect(holder.move.mock.calls[0]![0]).toMatchObject({
      entityId: id,
      to: "won",
      expectedFrom: "draft",
      actor: { kind: "agent" },
    });
    // the generic update wrote `note` and did NOT touch the projection
    expect(await props(client, id)).toEqual({
      commercialStage: "draft",
      note: "b",
    });
  });

  it("a stale move rejects the whole call before anything is written", async () => {
    const { client, database } = await freshDb();
    const id = await insertDeal(client);
    holder.move.mockReset();
    holder.move.mockResolvedValue({
      status: "conflict",
      expectedFrom: "negotiating",
      actual: "draft",
    });
    const caller = await callerFor(database);
    await expect(
      caller.update({
        id,
        properties: { commercialStage: "won", note: "b" },
        expectedStatus: "negotiating",
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await props(client, id)).toEqual({
      commercialStage: "draft",
      note: "a",
    });
  });

  // E2: the agent doors (hub updateEntity/updateFacet, Hub REST, MCP) turn
  // the door's CONFLICT into a typed result through `lifecycleConflictOf` —
  // driven here from the REAL door's thrown error, across the tRPC caller.
  it("the stale move's error carries the typed conflict an agent door returns", async () => {
    const { lifecycleConflictOf } =
      await import("../../services/lifecycle/conflict.js");
    const { TRPCError } = await import("@trpc/server");
    const { client, database } = await freshDb();
    const id = await insertDeal(client);
    holder.move.mockReset();
    holder.move.mockResolvedValue({
      status: "conflict",
      expectedFrom: "negotiating",
      actual: "draft",
    });
    const caller = await callerFor(database);
    const err = await caller
      .update({
        id,
        properties: { commercialStage: "won" },
        expectedStatus: "negotiating",
      })
      .catch((e: unknown) => e);
    expect(lifecycleConflictOf(err)).toMatchObject({
      status: "conflict",
      conflict: {
        reason: "lifecycle_stale",
        expectedStatus: "negotiating",
        currentStatus: "draft",
      },
    });
    // Any OTHER conflict stays an error — only a stale status is an answer.
    expect(
      lifecycleConflictOf(new TRPCError({ code: "CONFLICT", message: "dup" }))
    ).toBeNull();
  });

  it("a status-only call returns the move and writes nothing else", async () => {
    const { client, database } = await freshDb();
    const id = await insertDeal(client);
    holder.move.mockReset();
    holder.move.mockResolvedValue({
      status: "proposed",
      proposalId: "p-1",
      proposalType: "entity.transition",
    });
    const caller = await callerFor(database);
    const r = (await caller.update({
      id,
      properties: { commercialStage: "won" },
    })) as Record<string, unknown>;
    expect(r).toMatchObject({ status: "proposed", proposalId: "p-1" });
    expect(await props(client, id)).toEqual({
      commercialStage: "draft",
      note: "a",
    });
  });
});
