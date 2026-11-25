/**
 * A POD-WIDE entity's `entity:*` push reaches every person who may read the
 * entity, and nobody else, on real SQL (PGlite), with three people.
 *
 * Most kinds are pod-wide (the row carries no workspace). Before this, the
 * realtime schema required a workspace, so the bridge dropped every such
 * push and an open page never heard the change; and the fallback room it
 * would have used (`user:<writer>`) reached only the writer, never a space
 * member reading the entity through a role.
 *
 * The audience is the entity read floor, as `status:transition:completed`'s
 * (`statusAudience`, status-floor.ts), plus the writer. Asserted on the wire:
 * one POST per reader to `user:<id>`, never a workspace room, each payload
 * one the realtime server accepts (`validateEmitPayload`, what `/bridge/emit`
 * answers 400 with).
 *
 * Not covered here: the pod-shared and home-space floor branches (the floor
 * itself is pinned by status-realtime.pglite.test.ts and the access tests);
 * a failed audience read (domain-event-bridge.test.ts, mocked).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 120_000 });

const holder = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = { ...actual, getDb: async () => holder.db };
  Object.defineProperty(mocked, "db", {
    get: () => holder.db,
    enumerable: true,
  });
  return mocked;
});

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL, is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import type { EventRecord } from "@synap/database";
import { validateEmitPayload } from "@synap/events/realtime-schemas";
import { emitDomainEventToRealtime } from "./domain-event-bridge.js";

const ME = "user-me";
const OTHER = "user-other";
const STRANGER = "user-stranger";
const W_SHARED = randomUUID();
const W_STRANGER = randomUUID();
const KIND = randomUUID();
const ROLE = randomUUID();
/** Pod-wide, mine, wearing a role in the shared space: OTHER reads it too. */
const E_ROLED = randomUUID();
/** Pod-wide, mine, no role: only I may read it. */
const E_PRIVATE = randomUUID();
/** Pod-wide, mine, roled in the shared space, soft-deleted. */
const E_SOFT_DELETED = randomUUID();
/** In the shared space (the workspace room path, unchanged). */
const E_IN_SPACE = randomUUID();

let client: PGlite;
const q = (sql: string, params: unknown[] = []) => client.query(sql, params);

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
  return `create table if not exists "${cfg.name}" (${columns.join(", ")});`;
}

beforeAll(async () => {
  client = new PGlite();
  // Every table of the schema: the floor joins widely.
  const tables = (Object.values(schema) as unknown[]).filter(
    (t): t is PgTable => is(t, PgTable)
  );
  expect(tables.length).toBeGreaterThan(50);
  for (const t of tables) await client.exec(ddlFor(t));
  holder.db = drizzle(client, { schema });

  for (const id of [ME, OTHER, STRANGER]) {
    await q(`insert into users (id, email) values ($1, $2)`, [
      id,
      `${id}@example.test`,
    ]);
  }
  for (const [id, owner] of [
    [W_SHARED, ME],
    [W_STRANGER, STRANGER],
  ] as const) {
    await q(
      `insert into workspaces (id, owner_id, name, workspace_type) values ($1, $2, 'Space', 'team')`,
      [id, owner]
    );
  }
  for (const [ws, user, role] of [
    [W_SHARED, ME, "owner"],
    [W_SHARED, OTHER, "editor"],
    [W_STRANGER, STRANGER, "owner"],
  ] as const) {
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, $4)`,
      [randomUUID(), ws, user, role]
    );
  }
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, entity_scope) values ($1, 'task', 'Task', 'kind', 'pod')`,
    [KIND]
  );
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, entity_scope) values ($1, 'client', 'Client', 'role', 'workspace')`,
    [ROLE]
  );
  for (const [id, ws, deleted] of [
    [E_ROLED, null, false],
    [E_PRIVATE, null, false],
    [E_SOFT_DELETED, null, true],
    [E_IN_SPACE, W_SHARED, false],
  ] as const) {
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, created_at, updated_at, deleted_at)
       values ($1, $2, $3, $4, 'task', 'A task', '{}'::jsonb, now(), now(), ${deleted ? "now()" : "null"})`,
      [id, ME, ws, KIND]
    );
  }
  for (const entityId of [E_ROLED, E_SOFT_DELETED]) {
    await q(
      `insert into entity_facets (id, entity_id, profile_id, user_id, workspace_id, status, status_category, created_at, updated_at)
       values ($1, $2, $3, $4, $5, 'active', 'active', now(), now())`,
      [randomUUID(), entityId, ROLE, ME, W_SHARED]
    );
  }
});

/** An entity row as `EntityRepository` emits it. */
function rowOf(id: string, workspaceId: string | null) {
  return {
    id,
    userId: ME,
    workspaceId,
    homeWorkspaceId: null,
    profileId: KIND,
    type: "task",
    title: "A task",
    preview: null,
    documentId: null,
    properties: {},
    systemData: {},
    version: 2,
    createdAt: "2026-11-26T09:00:00.000Z",
    updatedAt: "2026-11-26T10:00:00.000Z",
    deletedAt: null,
  };
}

function event(
  eventType: string,
  subjectId: string,
  data: Record<string, unknown>
): EventRecord {
  return {
    id: randomUUID(),
    timestamp: new Date("2026-11-26T10:00:00Z"),
    subjectId,
    subjectType: "entity",
    eventType,
    userId: ME,
    data,
    version: 1,
    source: "api",
  } as EventRecord;
}

describe("a pod-wide entity's push reaches each of its readers", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const bodies = () =>
    fetchMock.mock.calls.map(
      (c) => JSON.parse(c[1].body as string) as Record<string, unknown>
    );
  /** Who received it; every POST checked against the realtime server's check. */
  const recipients = (socketEvent: string) => {
    const sent = bodies();
    for (const b of sent) {
      expect(b.event).toBe(socketEvent);
      // A reader's own room, never a workspace room.
      expect(b.workspaceId).toBeUndefined();
      expect(validateEmitPayload(b.event as string, b.data)).toEqual({
        ok: true,
      });
    }
    return sent.map((b) => b.userId as string).sort();
  };

  it("an update of a roled pod-wide entity reaches me AND the space member, never a stranger", async () => {
    await emitDomainEventToRealtime(
      event("entity.update.completed", E_ROLED, rowOf(E_ROLED, null))
    );
    expect(recipients("entity:updated")).toEqual([ME, OTHER].sort());
    // The value arrives: the reader gets the entity id and its patch.
    expect(bodies()[0]!.data).toMatchObject({
      entityId: E_ROLED,
      updatedBy: ME,
      changes: { title: "A task" },
    });
  });

  it("a create of an un-roled pod-wide entity reaches only me", async () => {
    await emitDomainEventToRealtime(
      event("entity.create.completed", E_PRIVATE, rowOf(E_PRIVATE, null))
    );
    expect(recipients("entity:created")).toEqual([ME]);
  });

  it("a status move of a roled pod-wide entity reaches both readers", async () => {
    await emitDomainEventToRealtime(
      event("entity.transition.completed", E_ROLED, {
        transitionId: "t1",
        entityId: E_ROLED,
        property: "taskStatus",
        from: "todo",
        to: "doing",
        category: "active",
        role: null,
        workspaceId: null,
      })
    );
    expect(recipients("entity:updated")).toEqual([ME, OTHER].sort());
  });

  it("a soft delete reaches whoever read the row; a row already gone reaches the writer", async () => {
    await emitDomainEventToRealtime(
      event("entity.delete.completed", E_SOFT_DELETED, {
        id: E_SOFT_DELETED,
        workspaceId: null,
        type: "task",
      })
    );
    expect(recipients("entity:deleted")).toEqual([ME, OTHER].sort());

    fetchMock.mockClear();
    const gone = randomUUID();
    await emitDomainEventToRealtime(
      event("entity.delete.completed", gone, {
        id: gone,
        workspaceId: null,
        type: "task",
      })
    );
    expect(recipients("entity:deleted")).toEqual([ME]);
  });

  it("CONTROL: an entity in a space still goes once to that space's room", async () => {
    await emitDomainEventToRealtime(
      event("entity.update.completed", E_IN_SPACE, rowOf(E_IN_SPACE, W_SHARED))
    );
    const sent = bodies();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ event: "entity:updated", workspaceId: W_SHARED });
    expect(sent[0]!.userId).toBeUndefined();
  });
});
