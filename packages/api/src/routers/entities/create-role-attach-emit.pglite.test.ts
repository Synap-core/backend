/**
 * R1 — a role ATTACH reaches the automation matcher (`entity_facet.attach`,
 * the event a role's `created` activator compiles to) from EVERY path, once:
 * the facet door (`FacetRepository.attach`) announces each NEW row through the
 * boot-wired emitter (`registerFacetAttachEmitter`). Driven on PGlite through
 * the real doors, reading what reaches `emitSideEffects` (the fan-out).
 *
 * Paths: the router create AS a role (its adapter attaches in a transaction
 * and announces after commit), capture/sync's `EntityUpsertService`, and a
 * direct door call (merge, the team bridge, the materializer all call it so).
 * Discriminating rows: the router path announces EXACTLY once (a router emit
 * beside the door's would double it); an idempotent re-attach announces
 * nothing; a sync upsert's attach carries `origin: "sync"` (or a first sync
 * of 200 contacts would start 200 processes).
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const holder = vi.hoisted(() => ({
  db: undefined as unknown,
}));

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
import * as schema from "@synap/database/schema";
import { type db as DatabaseHandle } from "@synap/database";
import { emitSideEffects } from "@synap/events";

const USER = "user-1";
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
  const tables = (Object.values(schema) as unknown[]).filter(
    (t): t is PgTable => {
      try {
        return !!getTableConfig(t as PgTable).name;
      } catch {
        return false;
      }
    }
  );
  for (const table of tables) {
    try {
      await client.exec(ddlFor(table));
    } catch {
      // a duplicate / unsupported table definition is not under test
    }
  }
  await client.exec(
    `insert into users (id, email) values ('${USER}', '${USER}@example.test')`
  );
  const database = drizzle(client, { schema }) as unknown as Database;
  holder.db = database;
  return { client, database };
}

type Emit = {
  subjectType: string;
  action: string;
  data: Record<string, unknown>;
  origin?: string;
};
const attaches = (): Emit[] =>
  vi
    .mocked(emitSideEffects)
    .mock.calls.map((c) => c[0] as Emit)
    .filter((p) => p.subjectType === "entity_facet" && p.action === "attach");
/** The fan-out is fire-and-forget behind an origin lookup. */
const settle = () => new Promise((r) => setTimeout(r, 30));

describe("a role attach is announced once, from every path (R1)", () => {
  let client: PGlite;
  let database: Database;
  let personProfileId: string;

  beforeAll(async () => {
    ({ client, database } = await freshDb());
    personProfileId = randomUUID();
    const leadId = randomUUID();
    await client.query(
      `insert into profiles (id, slug, display_name, profile_kind, entity_scope, user_id, scope)
       values ($1, 'person', 'Person', 'kind', 'pod', $3, 'system'),
              ($2, 'lead', 'Lead', 'role', 'pod', $3, 'system')`,
      [personProfileId, leadId, USER]
    );
    await client.query(
      `update profiles set applicable_kinds = '{person}' where id = $1`,
      [leadId]
    );
    // The live-row unique index (migration 0174) is what makes a re-attach
    // idempotent; the drizzle-derived DDL above carries no indexes.
    await client.exec(
      `create unique index entity_facets_entity_profile_ctx_ws_uniq
         on entity_facets (entity_id, profile_id,
           coalesce(context_entity_id, '00000000-0000-0000-0000-000000000000'::uuid),
           coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid))
         where deleted_at is null`
    );
    const { registerFacetAttachEmitter } = await import("./helpers.js");
    registerFacetAttachEmitter();
    // Every schema table on PGlite: ~3s alone, ~30s on a loaded machine.
  }, 120_000);

  beforeEach(() => vi.mocked(emitSideEffects).mockClear());

  it("router: entities.create AS a lead announces the attach EXACTLY once", async () => {
    const { entitiesRouter } = await import("../entities.js");
    const caller = entitiesRouter.createCaller({
      db: database,
      authenticated: true,
      userId: USER,
      workspaceId: null,
    } as never);
    const res = (await caller.create({
      profileSlug: "lead",
      title: "Ada Lovelace",
      forceCreate: true,
    } as never)) as { status: string; id: string };
    expect(res.status).toBe("created");
    await settle();
    expect(attaches()).toHaveLength(1);
    expect(attaches()[0]!.data).toMatchObject({
      entityId: res.id,
      profileSlug: "lead",
    });
  }, 60_000);

  it("capture/sync upsert of a lead announces it; a SYNC upsert says so", async () => {
    const { EntityUpsertService } = await import("@synap/database");
    const svc = new EntityUpsertService(
      database as never,
      { append: async () => undefined } as never
    );
    const res = await svc.upsert({
      profileSlug: "lead",
      title: "Grace Hopper",
      properties: {},
      source: "contacts",
      externalId: `ext-${randomUUID()}`,
      signals: [],
      workspaceId: null,
      userId: USER,
      provenance: { createdByKind: "system", createdByUserId: USER },
    } as never);
    await settle();
    expect(attaches()).toHaveLength(1);
    expect(attaches()[0]!.data).toMatchObject({
      entityId: res.entity.id,
      profileSlug: "lead",
    });
    expect(attaches()[0]!.origin).toBeUndefined();

    vi.mocked(emitSideEffects).mockClear();
    await svc.upsert({
      profileSlug: "lead",
      title: "Katherine Johnson",
      properties: {},
      source: "contacts",
      externalId: `ext-${randomUUID()}`,
      signals: [],
      workspaceId: null,
      userId: USER,
      provenance: { createdByKind: "system", createdByUserId: USER },
      origin: "sync",
    } as never);
    await settle();
    expect(attaches()).toHaveLength(1);
    expect(attaches()[0]!.origin).toBe("sync");
  }, 60_000);

  it("a direct door attach (merge / team bridge / materializer) announces it; a re-attach does not", async () => {
    const { FacetRepository } = await import("@synap/database");
    const personId = randomUUID();
    await client.query(
      `insert into entities (id, user_id, type, title, profile_id, properties)
       values ($1, $2, 'person', 'Mary Jackson', $3, '{}'::jsonb)`,
      [personId, USER, personProfileId]
    );
    const repo = new FacetRepository(
      database as never,
      { append: async () => undefined } as never
    );
    await repo.attach(
      { entityId: personId, profileSlug: "lead", userId: USER },
      USER
    );
    await settle();
    expect(attaches()).toHaveLength(1);
    expect(attaches()[0]!.data).toMatchObject({
      entityId: personId,
      profileSlug: "lead",
    });
    await repo.attach(
      { entityId: personId, profileSlug: "lead", userId: USER },
      USER
    );
    await settle();
    expect(attaches()).toHaveLength(1);
  }, 60_000);
});
