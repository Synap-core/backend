/**
 * A role the entity ALREADY wears: `entities.attachFacet` answers `exists`
 * with the live facet's id, writes nothing and files nothing. Before, the door
 * governed the attach first: an agent setting a lead's `nextAction` through
 * attach got a proposal whose approval wrote nothing and read as success
 * (finding 5b0a22b5). Driven on PGlite through the real door; the permission
 * gate is the mock that would have filed the proposal, so its call count is
 * the discriminating row. The role's fields change through `updateFacet`
 * (`synap_update_facet`), pinned here too: the merge lands on the same row.
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
import { checkPermissionOrPropose } from "../../utils/permission-check.js";

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

describe("attaching a role the entity already wears (finding 5b0a22b5)", () => {
  let client: PGlite;
  let database: Database;
  let personId: string;

  beforeAll(async () => {
    ({ client, database } = await freshDb());
    const personProfileId = randomUUID();
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
    await client.exec(
      `create unique index entity_facets_entity_profile_ctx_ws_uniq
         on entity_facets (entity_id, profile_id,
           coalesce(context_entity_id, '00000000-0000-0000-0000-000000000000'::uuid),
           coalesce(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid))
         where deleted_at is null`
    );
    const { entitiesRouter } = await import("../entities.js");
    const created = (await caller(entitiesRouter).create({
      profileSlug: "person",
      title: "Ada Lovelace",
    } as never)) as { status: string; id: string };
    expect(created.status).toBe("created");
    personId = created.id;
  }, 120_000);

  const caller = (router: { createCaller: (c: never) => unknown }) =>
    router.createCaller({
      db: database,
      authenticated: true,
      userId: USER,
      workspaceId: null,
    } as never) as {
      create: (i: never) => Promise<unknown>;
      attachFacet: (i: never) => Promise<Record<string, unknown>>;
      updateFacet: (i: never) => Promise<Record<string, unknown>>;
    };

  const gateCalls = () => vi.mocked(checkPermissionOrPropose).mock.calls.length;

  it("the first attach attaches; the second answers exists with the same facet, files nothing, changes nothing", async () => {
    const { entitiesRouter } = await import("../entities.js");
    const first = await caller(entitiesRouter).attachFacet({
      entityId: personId,
      profileSlug: "lead",
      properties: { nextAction: "intro call" },
    } as never);
    expect(first.status).toBe("attached");
    const facetId = first.facetId as string;
    expect(facetId).toBeTruthy();

    const before = gateCalls();
    const again = await caller(entitiesRouter).attachFacet({
      entityId: personId,
      profileSlug: "lead",
      properties: { nextAction: "send the proposal" },
    } as never);
    expect(again.status).toBe("exists");
    expect(again.facetId).toBe(facetId);
    // No governed write was attempted: nothing to propose, nothing to approve.
    expect(gateCalls()).toBe(before);
    const rows = await client.query<{ properties: Record<string, unknown> }>(
      `select properties from entity_facets where entity_id = $1 and deleted_at is null`,
      [personId]
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.properties).toMatchObject({
      nextAction: "intro call",
    });
  }, 60_000);

  it("the role's fields change through updateFacet on that facet id", async () => {
    const { entitiesRouter } = await import("../entities.js");
    const worn = await caller(entitiesRouter).attachFacet({
      entityId: personId,
      profileSlug: "lead",
    } as never);
    expect(worn.status).toBe("exists");
    const res = await caller(entitiesRouter).updateFacet({
      facetId: worn.facetId,
      properties: { nextAction: "send the proposal" },
    } as never);
    expect(res.status).toBe("updated");
    const rows = await client.query<{ properties: Record<string, unknown> }>(
      `select properties from entity_facets where id = $1`,
      [worn.facetId]
    );
    expect(rows.rows[0]!.properties).toMatchObject({
      nextAction: "send the proposal",
    });
  }, 60_000);
});
