/**
 * A pod-wide record's HOME through the real `entities.update` door (finding
 * a70f910f): the one governed way to file an existing pod-wide record for a
 * space, so that space's members and a key limited to it read it. Before it,
 * `home_workspace_id` was written only at create, on `global: true` and by a
 * move in, so a contact created pod-wide stayed invisible to the CRM app.
 *
 * Driven on PGlite through the real door, the real repository write, the
 * real read floor (`entityReadVisibleWhere`) under a real space-limited grant
 * (`runWithGrant` + the registered grant read provider), and the real approve
 * body (`applyApprovedEntityPatch`). The permission gate is a recorder (its
 * own tests own the verdict); the event door is a recorder.
 *
 * Rows rule out: a home set on a row that lives in a space; a home filed for
 * a space the caller cannot write (a viewer, a non-member) or that reaches
 * the gate at all; a home that never lands (the space-limited key still sees
 * nothing); an agent's home applied without review; an approved home that
 * changes nothing on replay; a home change the undo record cannot see.
 *
 * Cannot see: production Postgres; the gate's own verdict per rule; a key
 * grant that may read the row but not write in the home space (the door
 * calls `assertKeyMayWrite` with the home; that check has its own tests).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
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
import { SQL, and, eq } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import {
  grantOfScope,
  runWithGrant,
  type db as DatabaseHandle,
} from "@synap/database";
// Registers the grant read provider the floors call (as the API does at
// load): without it a scoped grant reads deny-all, not narrowed.
import "../../access/grant-read.js";
import { entityReadVisibleWhere } from "../../access/entity-read-floor.js";
import { recordDomainMutation } from "../../utils/domain-mutation.js";
import { computeEntityUpdateDiff } from "../../utils/entity-property-diff.js";

const USER = randomUUID();
const AGENT = randomUUID();
const CRM = randomUUID(); // USER is its owner
const VIEWED = randomUUID(); // USER is only a viewer
const FOREIGN = randomUUID(); // USER is not a member
type Database = typeof DatabaseHandle;

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

/** CREATE TABLE from the drizzle definition: columns, types and literal defaults. */
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const columns = cfg.columns.map((c) => {
    const raw = c.getSQLType();
    const isArray = raw.endsWith("[]");
    let type =
      c.columnType === "PgEnumColumn" || !BASIC.test(raw)
        ? "text"
        : raw.replace(/\(.*\)/, "");
    if (isArray && !type.endsWith("[]")) type = `${type}[]`;
    let def = "";
    const d = c.default as unknown;
    if (d !== undefined && !(d instanceof SQL)) {
      if (typeof d === "string") def = ` default '${d.replace(/'/g, "''")}'`;
      else if (typeof d === "number" || typeof d === "boolean")
        def = ` default ${d}`;
      else if (isArray) def = ` default '{}'`;
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

let client: PGlite;
let database: Database;

async function freshDb() {
  client = new PGlite();
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await client.exec(ddlFor(t));
  await client.query(
    `insert into users (id, email, user_type) values ($1,'owner@example.test','human')`,
    [USER]
  );
  await client.query(
    `insert into users (id, email, user_type, created_by_user_id) values ($1,'agent@example.test','agent',$2)`,
    [AGENT, USER]
  );
  await client.query(
    `insert into pod_members (id, user_id, pod_role) values ($1,$2,'owner')`,
    [randomUUID(), USER]
  );
  for (const [ws, role] of [
    [CRM, "owner"],
    [VIEWED, "viewer"],
    [FOREIGN, null],
  ] as const) {
    await client.query(
      `insert into workspaces (id, name, owner_id, settings) values ($1,$2,$3,'{}'::jsonb)`,
      [ws, ws.slice(0, 8), role ? USER : AGENT]
    );
    if (role)
      await client.query(
        `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,$4)`,
        [randomUUID(), ws, USER, role]
      );
  }
  database = drizzle(client, { schema }) as unknown as Database;
  holder.db = database;
}

async function insertPerson(workspaceId: string | null, home?: string) {
  const id = randomUUID();
  await client.query(
    `insert into entities (id, user_id, workspace_id, home_workspace_id, type, title, properties)
     values ($1,$2,$3,$4,'person','Geoffroy Contact','{}'::jsonb)`,
    [id, USER, workspaceId, home ?? null]
  );
  return id;
}

const homeOf = async (id: string) =>
  (
    await client.query<{ home_workspace_id: string | null }>(
      `select home_workspace_id from entities where id = $1`,
      [id]
    )
  ).rows[0]?.home_workspace_id ?? null;

/** What a key limited to CRM (the CRM app) reads of this row. */
const crmKeyReads = async (id: string) =>
  runWithGrant(
    grantOfScope({ permissions: ["entity.*.read"], workspaceIds: [CRM] }),
    async () =>
      (
        await database
          .select({ id: schema.entities.id })
          .from(schema.entities)
          .where(and(eq(schema.entities.id, id), entityReadVisibleWhere(USER)))
      ).length > 0
  );

async function caller() {
  const { entitiesRouter } = await import("../entities.js");
  return entitiesRouter.createCaller({
    db: database,
    authenticated: true,
    userId: USER,
    workspaceId: null,
  } as never);
}

const granted = () => vi.fn(async () => ({ granted: true }));

beforeEach(async () => {
  await freshDb();
  vi.mocked(recordDomainMutation).mockClear();
});

describe("entities.update — the home of a pod-wide record", () => {
  it("sets the home of a pod-wide row: it lands, the space-limited key then reads it, through the gate and the update event", async () => {
    const id = await insertPerson(null);
    expect(await crmKeyReads(id)).toBe(false);
    holder.perm = granted();

    const out = await (await caller()).update({ id, homeWorkspaceId: CRM });

    expect(out).toMatchObject({
      status: "updated",
      written: { homeWorkspaceId: CRM },
    });
    expect(await homeOf(id)).toBe(CRM);
    expect(await crmKeyReads(id)).toBe(true);
    // Governed: the gate decided in the home space, and the stored data
    // carries the home (an approval replays it).
    expect(holder.perm).toHaveBeenCalledTimes(1);
    expect(holder.perm.mock.calls[0]![0]).toMatchObject({
      workspaceId: CRM,
      subjectType: "entity",
      action: "update",
      data: { id, homeWorkspaceId: CRM },
    });
    // The normal update event, saying what changed.
    const emitted = vi
      .mocked(recordDomainMutation)
      .mock.calls.map((c) => c[0] as { action: string; data: object })
      .find((c) => c.action === "update");
    expect(emitted?.data).toMatchObject({
      homeWorkspaceId: CRM,
      "previous.homeWorkspaceId": null,
    });
  });

  it("null clears the home: the space-limited key no longer reads it", async () => {
    const id = await insertPerson(null, CRM);
    expect(await crmKeyReads(id)).toBe(true);
    holder.perm = granted();

    await (await caller()).update({ id, homeWorkspaceId: null });

    expect(await homeOf(id)).toBeNull();
    expect(await crmKeyReads(id)).toBe(false);
  });

  it("REFUSED on a row stamped in a space: nothing reaches the gate, nothing written", async () => {
    const id = await insertPerson(CRM);
    holder.perm = granted();

    await expect(
      (await caller()).update({ id, homeWorkspaceId: CRM })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(/Only a pod-wide record has a home/),
    });
    expect(holder.perm).not.toHaveBeenCalled();
    expect(await homeOf(id)).toBeNull();
  });

  it("SECURITY: REFUSED for a space the caller cannot write (a viewer, a non-member): nothing reaches the gate", async () => {
    const id = await insertPerson(null);
    holder.perm = granted();

    for (const space of [VIEWED, FOREIGN]) {
      await expect(
        (await caller()).update({ id, homeWorkspaceId: space })
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: expect.stringMatching(/can write in a space/),
      });
    }
    expect(holder.perm).not.toHaveBeenCalled();
    expect(await homeOf(id)).toBeNull();
    expect(await crmKeyReads(id)).toBe(false);
  });

  it("an agent's home is always reviewed (forcePropose) and writes nothing until approved", async () => {
    const id = await insertPerson(null);
    holder.perm = vi.fn(async () => ({
      proposalId: "prop-home",
      proposalType: "update",
      reviewUrl: "https://pod.example/open/prop-home",
    }));

    const out = await (
      await caller()
    ).update({ id, homeWorkspaceId: CRM, agentUserId: AGENT, source: "ai" });

    expect(out).toMatchObject({ status: "proposed", proposalId: "prop-home" });
    expect(holder.perm.mock.calls[0]![0]).toMatchObject({
      forcePropose: true,
      data: { id, homeWorkspaceId: CRM },
    });
    expect(await homeOf(id)).toBeNull();
  });

  it("the approval replays the stored home, and the undo pair records it", async () => {
    const id = await insertPerson(null);
    holder.perm = granted();
    const { applyApprovedEntityPatch } =
      await import("../proposals/executors/entity.js");

    const { undoBefore, undoAfter, status } = await applyApprovedEntityPatch({
      caller: (await caller()) as never,
      userId: USER,
      proposalId: randomUUID(),
      proposalWorkspaceId: CRM,
      entityId: id,
      patch: { homeWorkspaceId: CRM },
    });

    expect(status).toBe("updated");
    expect(await homeOf(id)).toBe(CRM);
    expect(await crmKeyReads(id)).toBe(true);
    const diff = computeEntityUpdateDiff(id, undoBefore!, undoAfter!);
    expect(diff?.fields).toEqual({
      before: { homeWorkspaceId: null },
      after: { homeWorkspaceId: CRM },
    });
  });
});
