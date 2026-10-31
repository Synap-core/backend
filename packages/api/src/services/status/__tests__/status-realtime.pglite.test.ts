/**
 * Realtime status events reach exactly who may read that status through
 * `statusOf` (status-first wave 2), on real SQL (PGlite), with two people:
 *
 *   - the audience of a thing, a role, a goal and a session is the readers
 *     statusOf admits — checked against `readStatusOf` itself for every
 *     subject and every user, so the floor cannot drift from the read;
 *   - a thing only one person may read reaches only them; a role hidden from
 *     a reader of its thing does not reach that reader;
 *   - the mover's key grant does not narrow another reader's audience;
 *   - on the wire: one POST per reader, to `user:<id>` only (never a
 *     workspace room), its payload the strict schema's keys and nothing
 *     else (no hold, no reason, no mover), for a move and for a signal.
 *
 * Only `getEffectiveLifecycle` is stubbed (no declared lifecycle needed).
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 120_000 });

const holder = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = {
    ...actual,
    getDb: async () => holder.db,
    ProfileResolutionService: class extends (actual.ProfileResolutionService as new (
      db: unknown
    ) => object) {
      async getEffectiveLifecycle() {
        return null;
      }
    },
  };
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
import { runWithGrant, type EventRecord } from "@synap/database";
import { validateEmitPayload } from "@synap/events/realtime-schemas";
import { readStatusOf } from "../status-read.js";
import { statusAudience, type StatusSubjectRef } from "../status-floor.js";
import {
  pushStatusSignal,
  pushStatusTransition,
  statusRealtimeHook,
} from "../status-realtime.js";

const ME = "user-me";
const OTHER = "user-other";
const W_MINE = randomUUID();
const W_SHARED = randomUUID();
const P_MINE = randomUUID();
const P_THEIRS = randomUUID();
const KIND = randomUUID();
const ROLE = randomUUID();
/** Mine, pod-personal: only I may read it. */
const E_MINE = randomUUID();
/** In a space we are both members of. */
const E_SHARED = randomUUID();
/** A role on the shared thing that only I may see (mine, pod-wide). */
const F_MINE_ONLY = randomUUID();
/** A role on the shared thing in the shared space: both of us see it. */
const F_SHARED = randomUUID();
const G_MINE = randomUUID();
const S_MINE = randomUUID();
const S_THEIRS = randomUUID();

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
  // Every table of the schema: the floors join widely, and a hand-kept list
  // is the one that falls behind.
  const tables = (Object.values(schema) as unknown[]).filter(
    (t): t is PgTable => is(t, PgTable)
  );
  expect(tables.length).toBeGreaterThan(50);
  for (const t of tables) await client.exec(ddlFor(t));
  holder.db = drizzle(client, { schema });

  for (const id of [ME, OTHER]) {
    await q(`insert into users (id, email) values ($1, $2)`, [
      id,
      `${id}@example.test`,
    ]);
  }
  await q(
    `insert into workspaces (id, owner_id, name, workspace_type) values ($1, $2, 'Mine', 'personal')`,
    [W_MINE, ME]
  );
  await q(
    `insert into workspaces (id, owner_id, name, workspace_type) values ($1, $2, 'Shared', 'team')`,
    [W_SHARED, ME]
  );
  for (const [ws, user, role] of [
    [W_MINE, ME, "owner"],
    [W_SHARED, ME, "owner"],
    [W_SHARED, OTHER, "editor"],
  ] as const) {
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, $4)`,
      [randomUUID(), ws, user, role]
    );
  }
  for (const [id, owner] of [
    [P_MINE, ME],
    [P_THEIRS, OTHER],
  ] as const) {
    await q(
      `insert into projects (id, user_id, workspace_id, name, status, created_at, updated_at)
       values ($1, $2, null, 'Project', 'active', now(), now())`,
      [id, owner]
    );
  }
  await q(
    `insert into project_tracks (id, project_id, user_id, name, definition_snapshot, method_version, status, criteria, created_at, updated_at)
     values ($1, $2, $3, 'My goal', '{}'::jsonb, '1', 'active', '[]'::jsonb, now(), now())`,
    [G_MINE, P_MINE, ME]
  );
  for (const [id, owner, project] of [
    [S_MINE, ME, P_MINE],
    [S_THEIRS, OTHER, P_THEIRS],
  ] as const) {
    await q(
      `insert into focus_sessions (id, user_id, workspace_id, project_id, goal, status, origin, expected_outputs, metadata, started_at, created_at, updated_at)
       values ($1, $2, null, $3, 'Do it', 'active', 'agent', '[]'::jsonb, '{}'::jsonb, now(), now(), now())`,
      [id, owner, project]
    );
  }
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, entity_scope) values ($1, 'deal', 'Deal', 'kind', 'workspace')`,
    [KIND]
  );
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, entity_scope) values ($1, 'client', 'Client', 'role', 'workspace')`,
    [ROLE]
  );
  for (const [id, ws, title] of [
    [E_MINE, null, "My secret deal"],
    [E_SHARED, W_SHARED, "Our deal"],
  ] as const) {
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, title, status, status_category, properties, created_at, updated_at)
       values ($1, $2, $3, $4, $5, 'draft', 'open', '{}'::jsonb, now(), now())`,
      [id, ME, ws, KIND, title]
    );
  }
  for (const [id, ws] of [
    [F_MINE_ONLY, null],
    [F_SHARED, W_SHARED],
  ] as const) {
    await q(
      `insert into entity_facets (id, entity_id, profile_id, user_id, workspace_id, status, status_category, created_at, updated_at)
       values ($1, $2, $3, $4, $5, 'active', 'active', now(), now())`,
      [id, E_SHARED, ROLE, ME, ws]
    );
  }
});

const THING = (id: string, facetId?: string): StatusSubjectRef => ({
  type: "entity",
  id,
  facetId: facetId ?? null,
});

/** What statusOf itself says `userId` may read of this subject. */
async function statusOfReads(
  userId: string,
  subject: StatusSubjectRef
): Promise<boolean> {
  const [answer] = await readStatusOf(userId, [subject.id]);
  if (!answer || answer.type === "unknown") return false;
  if (!subject.facetId) return true;
  if (!("roles" in answer) || !Array.isArray(answer.roles)) {
    throw new Error(`statusOf could not read ${subject.id}'s roles`);
  }
  return answer.roles.some((r) => r.facetId === subject.facetId);
}

describe("the audience of a status event is statusOf's floor", () => {
  const SUBJECTS: Array<[string, StatusSubjectRef]> = [
    ["my pod-personal thing", THING(E_MINE)],
    ["a thing in a shared space", THING(E_SHARED)],
    [
      "a role only I may see, on the shared thing",
      THING(E_SHARED, F_MINE_ONLY),
    ],
    ["a role in the shared space", THING(E_SHARED, F_SHARED)],
    ["my goal", { type: "goal", id: G_MINE }],
    ["my session", { type: "session", id: S_MINE }],
    ["their session", { type: "session", id: S_THEIRS }],
  ];

  it("a thing only I may read reaches only me", async () => {
    expect(await statusAudience(THING(E_MINE))).toEqual([ME]);
  });

  it("a thing we both read reaches both; a role hidden from one reaches only the other", async () => {
    expect((await statusAudience(THING(E_SHARED))).sort()).toEqual(
      [ME, OTHER].sort()
    );
    expect(await statusAudience(THING(E_SHARED, F_MINE_ONLY))).toEqual([ME]);
    expect((await statusAudience(THING(E_SHARED, F_SHARED))).sort()).toEqual(
      [ME, OTHER].sort()
    );
  });

  it("a goal and a session reach their reader only", async () => {
    expect(await statusAudience({ type: "goal", id: G_MINE })).toEqual([ME]);
    expect(await statusAudience({ type: "session", id: S_MINE })).toEqual([ME]);
    expect(await statusAudience({ type: "session", id: S_THEIRS })).toEqual([
      OTHER,
    ]);
  });

  it("for every subject and every user, it agrees with readStatusOf", async () => {
    let admitted = 0;
    let refused = 0;
    for (const [, subject] of SUBJECTS) {
      const audience = await statusAudience(subject);
      for (const user of [ME, OTHER]) {
        const reads = await statusOfReads(user, subject);
        expect(
          audience.includes(user),
          `${user} on ${subject.type} ${subject.id} (${subject.facetId ?? "-"})`
        ).toBe(reads);
        if (reads) admitted++;
        else refused++;
      }
    }
    // Non-vacuous: both answers occur.
    expect(admitted).toBeGreaterThanOrEqual(5);
    expect(refused).toBeGreaterThanOrEqual(4);
  });

  it("the mover's key grant does not narrow another reader's audience", async () => {
    // A grant that reads nothing: inside it, the session floor reads no row.
    const nothing = { scopes: [], clientId: null };
    const audience = await runWithGrant(nothing, () =>
      statusAudience({ type: "session", id: S_MINE })
    );
    expect(audience).toEqual([ME]);
  });
});

describe("on the wire", () => {
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

  /** The log row `emitLifecycleTransition` appends, hold and words included. */
  function transitionRow(
    subjectType: string,
    subjectId: string,
    data: Record<string, unknown> = {}
  ): EventRecord {
    return {
      id: randomUUID(),
      timestamp: new Date("2026-10-31T09:00:00Z"),
      subjectId,
      subjectType,
      eventType: `${subjectType}.transition.completed`,
      userId: ME,
      data: {
        transitionId: "t-1",
        subjectType,
        subjectId,
        property: "status",
        from: "draft",
        to: "on_hold",
        fromCategory: "open",
        category: "paused",
        actorKind: "agent",
        userId: ME,
        agentUserId: "agent-1",
        reason: "Waiting on the secret supplier",
        hold: { on: "person", reason: "their lawyer", since: "x" },
        workspaceId: null,
        occurredAt: "2026-10-31T08:59:00.000Z",
        role: null,
        facetId: null,
        ...data,
      },
      version: 1,
      source: "api",
    } as EventRecord;
  }

  it("a move of my thing: one POST, to my room only, the strict payload only", async () => {
    await pushStatusTransition(transitionRow("entity", E_MINE));
    expect(bodies()).toHaveLength(1);
    const [body] = bodies();
    expect(body).toEqual({
      event: "status:transition:completed",
      userId: ME,
      data: {
        subjectType: "entity",
        subjectId: E_MINE,
        transitionId: "t-1",
        role: null,
        from: "draft",
        to: "on_hold",
        category: "paused",
        at: "2026-10-31T08:59:00.000Z",
      },
    });
    expect(validateEmitPayload(body.event as string, body.data)).toEqual({
      ok: true,
    });
    const wire = JSON.stringify(body);
    for (const leaked of ["secret supplier", "their lawyer", "agent-1"]) {
      expect(wire).not.toContain(leaked);
    }
  });

  it("a hidden role's move reaches only who may see the role", async () => {
    await pushStatusTransition(
      transitionRow("entity", E_SHARED, {
        role: "client",
        facetId: F_MINE_ONLY,
        to: "active",
        category: "active",
      })
    );
    expect(bodies().map((b) => b.userId)).toEqual([ME]);
    expect(bodies()[0]!.data).toMatchObject({ role: "client" });
    expect(bodies()[0]).not.toHaveProperty("workspaceId");
  });

  it("a shared thing's move reaches each reader in their own room, never a workspace room", async () => {
    await pushStatusTransition(
      transitionRow("entity", E_SHARED, { workspaceId: W_SHARED })
    );
    expect(
      bodies()
        .map((b) => b.userId)
        .sort()
    ).toEqual([ME, OTHER].sort());
    for (const b of bodies()) expect(b).not.toHaveProperty("workspaceId");
  });

  it("a goal's and a session's move speak statusOf's words", async () => {
    await pushStatusTransition(transitionRow("track", G_MINE));
    await pushStatusTransition(transitionRow("focus_session", S_THEIRS));
    expect(
      bodies().map((b) => [
        b.userId,
        (b.data as Record<string, unknown>).subjectType,
      ])
    ).toEqual([
      [ME, "goal"],
      [OTHER, "session"],
    ]);
  });

  it("a raised signal reaches its readers only, with no words", async () => {
    await pushStatusSignal({
      signal: "stuck",
      subjectType: "entity",
      subjectId: E_MINE,
      facetId: null,
      role: null,
      beganAt: "2026-10-28T00:00:00.000Z",
      raisedAt: new Date("2026-10-31T09:00:00Z"),
    });
    expect(bodies()).toEqual([
      {
        event: "status:signal:raised",
        userId: ME,
        data: {
          subjectType: "entity",
          subjectId: E_MINE,
          signal: "stuck",
          role: null,
          beganAt: "2026-10-28T00:00:00.000Z",
          raisedAt: "2026-10-31T09:00:00.000Z",
        },
      },
    ]);
  });

  it("the hook pushes a transition row and ignores every other row", async () => {
    statusRealtimeHook(transitionRow("entity", E_MINE));
    statusRealtimeHook({
      ...transitionRow("entity", E_MINE),
      eventType: "entity.update.completed",
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // Give a wrongly-pushed second row the time to arrive.
    await new Promise((r) => setTimeout(r, 200));
    expect(bodies()).toHaveLength(1);
    expect(bodies()[0]!.event).toBe("status:transition:completed");
  });
});
