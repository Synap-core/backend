/**
 * R1 — creating a thing AS a role (`profileSlug: "lead"`) reaches the
 * automation matcher as the role's ATTACH (`entity_facet.attach`), the event a
 * role's `created` activator compiles to. Driven through the real
 * `entities.create` door on PGlite, reading what the door hands to
 * `emitSideEffects` (the matcher's fan-out).
 *
 * Why: the create door's role adapter attaches the facet through the
 * repository, whose event reaches the fact bus only. Before R1 nothing told
 * the matcher a lead had landed — "Qualify a lead" could never start from a
 * lead created this way.
 */

import { describe, it, expect, vi } from "vitest";
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

describe("entities.create as a ROLE emits the role's attach (R1)", () => {
  it("profileSlug: lead → entity_facet.attach reaches the matcher fan-out, with the role and the parent", async () => {
    const { client, database } = await freshDb();
    const personId = randomUUID();
    const leadId = randomUUID();
    await client.query(
      `insert into profiles (id, slug, display_name, profile_kind, entity_scope, user_id, scope)
       values ($1, 'person', 'Person', 'kind', 'pod', $3, 'system'),
              ($2, 'lead', 'Lead', 'role', 'pod', $3, 'system')`,
      [personId, leadId, USER]
    );
    await client.query(
      `update profiles set applicable_kinds = '{person}' where id = $1`,
      [leadId]
    );
    const { entitiesRouter } = await import("../entities.js");
    const caller = entitiesRouter.createCaller({
      db: database,
      authenticated: true,
      userId: USER,
      workspaceId: null,
    } as never);
    vi.mocked(emitSideEffects).mockClear();
    const res = (await caller.create({
      profileSlug: "lead",
      title: "Ada Lovelace",
      forceCreate: true,
    } as never)) as { status: string; id: string };
    expect(res.status).toBe("created");
    // The fan-out is fire-and-forget behind an origin lookup.
    await new Promise((r) => setTimeout(r, 20));
    const attach = vi
      .mocked(emitSideEffects)
      .mock.calls.map(
        (c) =>
          c[0] as {
            subjectType: string;
            action: string;
            data: Record<string, unknown>;
          }
      )
      .find((p) => p.subjectType === "entity_facet" && p.action === "attach");
    expect(
      attach,
      "the role's attach never reached the matcher fan-out"
    ).toBeDefined();
    expect(attach!.data).toMatchObject({
      entityId: res.id,
      profileSlug: "lead",
    });
    // Every schema table on PGlite: ~3s alone, ~30s on a loaded machine.
  }, 120_000);
});
