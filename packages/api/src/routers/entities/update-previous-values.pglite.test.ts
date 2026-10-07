/**
 * `entity.update.completed` carries the PREVIOUS value of every changed key
 * (`previous.<k>`, flat, beside `changed.<k>` and the new value) — driven
 * through the real `entities.update` door on a real Postgres (PGlite), reading
 * the payload the door hands to `recordDomainMutation` (the ONE emit door).
 *
 * Why: a rule could say "status changed" but not "status became X FROM Y"; the
 * matcher sees one payload, never the row. Process activators ("when a post
 * ENTERS published") and the subject→stage follow both read these keys.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
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
import { recordDomainMutation } from "../../utils/domain-mutation.js";

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


describe("entity.update payload carries previous values", () => {
  it("emits previous.<k> for every changed key (null for a key that did not exist)", async () => {
    const { client, database } = await freshDb();
    const id = await insertEntity(client);
    const { entitiesRouter } = await import("../entities.js");
    const caller = entitiesRouter.createCaller({
      db: database,
      authenticated: true,
      userId: USER,
      workspaceId: null,
    } as never);
    vi.mocked(recordDomainMutation).mockClear();
    await caller.update({
      id,
      properties: { stage: "client", added: 1, owner: "ann" },
      deleteProperties: ["gone"],
    });
    const call = vi
      .mocked(recordDomainMutation)
      .mock.calls.find(
        (c) =>
          (c[0] as { subjectType: string; action: string }).subjectType ===
            "entity" &&
          (c[0] as { action: string }).action === "update"
      );
    expect(call, "entities.update did not reach recordDomainMutation").toBeDefined();
    const data = (call![0] as { data: Record<string, unknown> }).data;
    // Unchanged `owner` is not a change: no flag, no previous.
    expect(data.changedKeys).toEqual(
      expect.arrayContaining(["stage", "added", "gone"])
    );
    expect(data).not.toHaveProperty("changed.owner");
    expect(data).not.toHaveProperty(["previous.owner"]);
    expect(data["changed.stage"]).toBe(true);
    expect(data.stage).toBe("client");
    expect(data["previous.stage"]).toBe("lead");
    expect(data["previous.added"]).toBeNull();
    expect(data["previous.gone"]).toBe("x");
  });
});
