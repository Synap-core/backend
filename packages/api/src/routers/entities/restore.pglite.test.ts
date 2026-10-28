/**
 * `entities.restore` in the real door (PGlite): the undo of `entities.delete`.
 *  - restore after delete clears `deletedAt` and nothing else, and reports a
 *    verified effect a client's `readWriteOutcome` reads;
 *  - it goes through the SAME governance door as delete, with the same inputs
 *    (the LOADED row's workspace, never the caller's), so a caller the gate
 *    makes propose a delete is made to propose a restore;
 *  - a live row is refused `ENTITY_NOT_DELETED`, a missing one `ENTITY_GONE`.
 * The gate itself is a recorder here: the verdict parity for an agent lives in
 * `@synap/governance-policy` (`entity-restore-parity.test.ts`).
 *
 * NEGATIVE CONTROL: make `restore` skip `checkPermissionOrPropose` and the
 * parity test goes red; drop the `deletedAt === null` refusal and the
 * not-deleted test goes red.
 */

import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";

const holder = vi.hoisted(() => ({
  db: undefined as unknown,
  gate: undefined as unknown as import("vitest").Mock,
  recorded: undefined as unknown as import("vitest").Mock,
}));
holder.gate = vi.fn();
holder.recorded = vi.fn(async () => null);

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
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
  getBoss: () => ({ send: async () => null }),
}));
vi.mock("../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: (...a: unknown[]) => holder.gate(...a),
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
  recordDomainMutation: (...a: unknown[]) => holder.recorded(...a),
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

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { ENTITY_RESTORE_REASON_CODES } from "@synap-core/types/entities";
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

const USER = "user-1";
const AGENT = "22222222-2222-4222-8222-222222222222";
const LENS = "33333333-3333-4333-8333-333333333333";
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
  await client.exec(
    `insert into users (id, email) values ('${USER}', '${USER}@example.test')`
  );
  // The caller's lens: a space they belong to, which the note is NOT in.
  await client.exec(
    `insert into workspaces (id, name) values ('${LENS}', 'Lens');
     insert into workspace_members (workspace_id, user_id, role) values ('${LENS}', '${USER}', 'owner');`
  );
  const database = drizzle(client, {
    schema: { entities, proposals, workspaces, workspaceMembers },
  }) as unknown as Database;
  holder.db = database;
  return { client, database };
}

async function insertNote(client: PGlite): Promise<string> {
  const id = randomUUID();
  await client.query(
    `insert into entities (id, user_id, type, title, properties)
     values ($1, $2, 'note', 'A note', '{}'::jsonb)`,
    [id, USER]
  );
  return id;
}
async function deletedAt(client: PGlite, id: string) {
  const r = await client.query<{ deleted_at: Date | null }>(
    `select deleted_at from entities where id = $1`,
    [id]
  );
  return r.rows[0]!.deleted_at;
}
async function callerFor(database: unknown) {
  const { entitiesRouter } = await import("../entities.js");
  return entitiesRouter.createCaller({
    db: database,
    authenticated: true,
    userId: USER,
    // The caller's lens is NOT what governance reads: the loaded row's is.
    workspaceId: LENS,
  } as never);
}
function reasonCodeOf(err: unknown): unknown {
  return (err as { cause?: { reasonCode?: unknown } }).cause?.reasonCode;
}

describe("entities.restore", () => {
  it("restores what delete removed and reports a verified effect", async () => {
    const { client, database } = await freshDb();
    const id = await insertNote(client);
    holder.gate.mockReset();
    holder.gate.mockResolvedValue({ granted: true });
    holder.recorded.mockClear();
    const caller = await callerFor(database);

    await caller.delete({ id });
    expect(await deletedAt(client, id)).not.toBeNull();

    const out = await caller.restore({ id });
    expect(out).toMatchObject({
      status: "restored",
      effect: { applied: "verified", rows: 1, ids: [id] },
    });
    expect(await deletedAt(client, id)).toBeNull();
    expect(holder.recorded).toHaveBeenLastCalledWith(
      expect.objectContaining({
        subjectType: "entity",
        action: "restore",
        subjectId: id,
        data: { profileSlug: "note" },
      })
    );
  });

  it("asks the same gate as delete, with the same inputs", async () => {
    const { client, database } = await freshDb();
    const id = await insertNote(client);
    holder.gate.mockReset();
    // An agent is made to propose; the person acts.
    holder.gate.mockImplementation(async (opts: { agentUserId?: string }) =>
      opts.agentUserId
        ? {
            granted: false,
            proposalId: "p-1",
            proposalType: "entity.x",
            reviewUrl: "/open/p-1",
          }
        : { granted: true }
    );
    const caller = await callerFor(database);

    const proposedDelete = await caller.delete({ id, agentUserId: AGENT });
    expect(proposedDelete).toMatchObject({ status: "proposed" });
    await caller.delete({ id });

    const proposedRestore = await caller.restore({ id, agentUserId: AGENT });
    expect(proposedRestore).toMatchObject({
      status: "proposed",
      proposalId: "p-1",
    });
    expect(await deletedAt(client, id)).not.toBeNull();

    const strip = (o: Record<string, unknown>) => {
      const { action, correlationId, requestedEventId, ...rest } = o;
      void correlationId;
      void requestedEventId;
      return { action, rest };
    };
    const deleteCall = strip(holder.gate.mock.calls[0]![0]);
    const restoreCall = strip(holder.gate.mock.calls[2]![0]);
    expect(deleteCall.action).toBe("delete");
    expect(restoreCall.action).toBe("restore");
    expect(restoreCall.rest).toEqual(deleteCall.rest);
    // The row's workspace (pod-wide here), never the caller's lens.
    expect(restoreCall.rest.workspaceId).toBeNull();
  });

  it("refuses a live entity with ENTITY_NOT_DELETED", async () => {
    const { client, database } = await freshDb();
    const id = await insertNote(client);
    holder.gate.mockReset();
    holder.gate.mockResolvedValue({ granted: true });
    const caller = await callerFor(database);

    const err = await caller.restore({ id }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "CONFLICT" });
    expect(reasonCodeOf(err)).toBe(ENTITY_RESTORE_REASON_CODES.notDeleted);
    expect(holder.gate).not.toHaveBeenCalled();
  });

  it("refuses a permanently deleted entity with ENTITY_GONE", async () => {
    const { client, database } = await freshDb();
    const id = await insertNote(client);
    await client.query(`delete from entities where id = $1`, [id]);
    holder.gate.mockReset();
    const caller = await callerFor(database);

    const err = await caller.restore({ id }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "NOT_FOUND" });
    expect(reasonCodeOf(err)).toBe(ENTITY_RESTORE_REASON_CODES.gone);
    expect(holder.gate).not.toHaveBeenCalled();
  });
});
