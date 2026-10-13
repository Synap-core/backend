/**
 * KIND CHANGE in the real `entities.update` door (c-kind-convert, plan 9992207a).
 *
 *  - a kind that does not resolve is refused BEFORE a proposal is filed (it
 *    used to be filed, approved, and change nothing);
 *  - a kind that resolves is always a proposal (`forcePropose`) carrying the
 *    target kind, whatever the governance rules would say for a field patch.
 * The permission gate is a recorder; profile resolution is stubbed to two kinds.
 */
import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";

const holder = vi.hoisted(() => ({
  db: undefined as unknown,
  perm: undefined as unknown as import("vitest").Mock,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = {
    ...actual,
    registerIdentitySignals: async () => undefined,
    getDb: async () => holder.db,
    // Hookless: the realtime fan-out is not under test.
    eventRepository: { append: async () => undefined },
    // Two kinds exist: note (the entity's) and decision (the target).
    ProfileResolutionService: class extends (actual.ProfileResolutionService as new (
      db: unknown
    ) => object) {
      async getEffectiveLifecycle() {
        return null;
      }
      async resolveProfile(slug: string) {
        return slug === "note" || slug === "decision"
          ? {
              id:
                slug === "note"
                  ? "33333333-3333-4333-8333-333333333333"
                  : "44444444-4444-4444-8444-444444444444",
              slug,
              profileKind: "kind",
            }
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
  checkPermissionOrPropose: (...a: unknown[]) => holder.perm(...a),
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

async function insertNote(client: PGlite): Promise<string> {
  const id = randomUUID();
  await client.query(
    `insert into entities (id, user_id, type, profile_id, title, properties)
     values ($1, $2, 'note', '33333333-3333-4333-8333-333333333333', 'Agent DELETE governance fix', $3::jsonb)`,
    [id, USER, JSON.stringify({ knowledgeForm: "fact" })]
  );
  return id;
}

async function callerFor(database: unknown) {
  const { entitiesRouter } = await import("../entities.js");
  return entitiesRouter.createCaller({
    db: database,
    authenticated: true,
    userId: USER,
    workspaceId: null,
  } as never);
}

describe("entities.update — converting an entity to another kind", () => {
  it("refuses a kind that does not resolve, before any proposal is filed", async () => {
    const { client, database } = await freshDb();
    const id = await insertNote(client);
    holder.perm = vi.fn();
    const caller = await callerFor(database);
    await expect(
      caller.update({ id, profileSlug: "nope" })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(/No kind "nope"/),
    });
    expect(holder.perm).not.toHaveBeenCalled();
  });

  it("files a known kind change as a proposal carrying the target kind", async () => {
    const { client, database } = await freshDb();
    const id = await insertNote(client);
    holder.perm = vi.fn(async () => ({
      proposalId: "prop-1",
      proposalType: "update",
      reviewUrl: "https://pod.example/open/prop-1",
    }));
    const caller = await callerFor(database);
    const out = await caller.update({ id, profileSlug: "decision" });
    expect(out).toMatchObject({ status: "proposed", proposalId: "prop-1" });
    expect(holder.perm.mock.calls[0]![0]).toMatchObject({
      forcePropose: true,
      data: { id, profileSlug: "decision" },
    });
  });
});
