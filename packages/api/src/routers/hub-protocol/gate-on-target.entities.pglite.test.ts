/**
 * S7 W2a — the entity doors gate the key's grant on the TARGET, never on the
 * workspace the caller picked (plan 13 §3.4 bullets 1–2).
 *
 * Driven through the REAL Bearer door: `hubProtocolRouter` → `apiKeyMiddleware`
 * (the S7 fence, then `runWithGrant`) → the hub procedure → the real
 * `entities.create` / `entities.update` door → `checkPermissionOrPropose`
 * rung 0, on PGlite with every @synap/database table. Only the key lookup and
 * the identity resolution are stubbed (they read the keys tables), plus the
 * delivery side effects (job queue, realtime).
 *
 * Each case rules out one wrong implementation:
 *  - the gate reads the header workspace for a pod-scope kind → a key that
 *    WRITES only in W creates a pod-wide `note` by sending `x-workspace-id: W`;
 *  - the gate reads the caller's `profileSlug` as the kind → a `note`-only key
 *    converts a `person` into a note;
 *  - the gate reads the header for a pod-wide row → a key that writes only in
 *    W edits a pod-wide entity (single and batch door).
 * Controls: the same key still creates a workspace-scope kind in W and still
 * edits a row stored in W.
 *
 * The keys READ unpinned on purpose: a key pinned for reads too never sees a
 * pod-wide row or a system kind (the grant read clause hides them), so the
 * write gate is only reachable — and only provable — with a wider read scope.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  grant: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  // The event log appends over its own connection (no PGlite): a no-op here,
  // the timeline is not under test.
  const eventRepository = new Proxy(
    {},
    { get: () => async () => ({ id: "event" }) }
  );
  return { ...actual, db: h.db, getDb: async () => h.db, eventRepository };
});
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
  getBoss: () => ({ send: async () => null }),
}));
vi.mock("../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: () => undefined,
}));
vi.mock("../../services/api-keys.js", () => ({
  apiKeyService: {
    validateApiKey: vi.fn(async () => ({
      id: "11111111-1111-4111-8111-111111111111",
      userId: "user-w2a",
      linkedUserId: null,
      keyName: "w2a",
      keyType: "user_pat",
      workspaceId: null,
      scope: ["hub-protocol.read", "hub-protocol.write"],
    })),
    checkRateLimit: vi.fn(() => true),
  },
}));
vi.mock("../../access/key-identity.js", () => ({
  resolveKeyIdentity: vi.fn(async () => ({
    effectiveUserId: "user-w2a",
    agentUserId: undefined,
    grant: h.grant,
  })),
}));

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { hubProtocolRouter } from "./index.js";

const USER = "user-w2a";
const WS = randomUUID();
const NOTE_PROFILE = randomUUID();
const TASK_PROFILE = randomUUID();
const PERSON_PROFILE = randomUUID();
const POD_NOTE = randomUUID(); // a pod-wide row (workspace_id NULL)
const WS_NOTE = randomUUID(); // a row stored in WS
const PERSON = randomUUID(); // a person stored in WS
const POD_PERSON = randomUUID(); // a pod-wide person with a strong identity
const LEAD_ROLE = randomUUID();
const POD_LEAD = randomUUID(); // a pod-wide person with a live role stamped in WS

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const key = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    return `"${c.name}" ${type}${key}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const scope = (permissions: string[], workspaceIds: string[] | null) => ({
  permissions,
  workspaceIds,
  projectIds: null,
  entityIds: null,
});
/**
 * Reads entities and kinds anywhere, WRITES only in WS — the shape the header
 * fallback defeated: a pod-wide target gated as "in WS" passed the write scope.
 */
const WRITE_IN_WS = {
  scopes: [
    scope(["entity.read", "profile.read"], null),
    scope(["entity.create", "entity.update"], [WS]),
  ],
  clientId: null,
};
/**
 * A pod app's shape (founder "option 1", 2026-10-23): reads AND writes pinned
 * to WS. Its reads now reach a pod-wide person roled in WS; its writes must not.
 */
const APP_IN_WS = {
  scopes: [scope(["entity.read", "entity.update"], [WS])],
  clientId: null,
};
/** Reads entities anywhere; may only update NOTES. */
const NOTE_UPDATE_ONLY = {
  scopes: [scope(["entity.read", "entity.note.update"], null)],
  clientId: null,
};

/** The Bearer door with `x-workspace-id: WS` (createContext → ctx.workspaceId). */
function hub(grant: unknown) {
  h.grant = grant;
  const req = new Request("http://pod.test/api/hub/trpc/x", {
    headers: { authorization: "Bearer sk_test", "x-workspace-id": WS },
  });
  return hubProtocolRouter.createCaller({
    req,
    authenticated: false,
    workspaceId: WS,
  } as never);
}

// `expect.stringMatching`, never a bare RegExp: `toMatchObject` treats a RegExp
// property as an empty object and matches ANY message.
const GRANT_DENIED = {
  code: "FORBIDDEN",
  message: expect.stringMatching(/grant does not allow/),
};

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  await q(`insert into users (id, email, user_type) values ($1, $2, 'human')`, [
    USER,
    `${USER}@x`,
  ]);
  await q(`insert into workspaces (id, owner_id, name) values ($1, $2, 'w')`, [
    WS,
    USER,
  ]);
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values (gen_random_uuid(), $1, $2, 'owner')`,
    [WS, USER]
  );
  await q(
    `insert into profiles (id, slug, display_name, scope, entity_scope, profile_kind, is_active, origin, ui_hints, default_values)
     values ($1, 'note', 'Note', 'system', 'pod', 'kind', true, 'authored', '{}', '{}'),
            ($2, 'task', 'Task', 'system', 'workspace', 'kind', true, 'authored', '{}', '{}'),
            ($3, 'person', 'Person', 'system', 'pod', 'kind', true, 'authored', '{}', '{}')`,
    [NOTE_PROFILE, TASK_PROFILE, PERSON_PROFILE]
  );
  await q(
    `insert into entities (id, user_id, type, profile_id, title, workspace_id, properties)
     values ($1, $2, 'note', $3, 'pod note', null, '{}'),
            ($4, $2, 'note', $3, 'ws note', $5, '{}'),
            ($6, $2, 'person', $7, 'Ada Lovelace', $5, '{}'),
            ($8, $2, 'person', $7, 'Grace Hopper', null, '{}')`,
    [
      POD_NOTE,
      USER,
      NOTE_PROFILE,
      WS_NOTE,
      WS,
      PERSON,
      PERSON_PROFILE,
      POD_PERSON,
    ]
  );
  await q(
    `insert into profiles (id, slug, display_name, scope, entity_scope, profile_kind, is_active, origin, ui_hints, default_values)
     values ($1, 'lead', 'Lead', 'workspace', 'workspace', 'role', true, 'authored', '{}', '{}')`,
    [LEAD_ROLE]
  );
  await q(
    `insert into entities (id, user_id, type, profile_id, title, workspace_id, properties)
     values ($1, $2, 'person', $3, 'Katherine Johnson', null, '{}')`,
    [POD_LEAD, USER, PERSON_PROFILE]
  );
  await q(
    `insert into entity_facets (id, entity_id, profile_id, user_id, workspace_id, properties)
     values (gen_random_uuid(), $1, $2, $3, $4, '{}')`,
    [POD_LEAD, LEAD_ROLE, USER, WS]
  );
  await q(
    `insert into entity_identity_signals (id, entity_id, signal_type, signal_value, source)
     values (gen_random_uuid(), $1, 'email', 'grace@navy.test', 'seed')`,
    [POD_PERSON]
  );
});

describe("entities.createEntity gates the grant where the row LANDS (W2a)", () => {
  it("a key that writes only in W cannot create a pod-scope `note` by sending x-workspace-id: W", async () => {
    await expect(
      hub(WRITE_IN_WS).entities.createEntity({
        userId: USER,
        profileSlug: "note",
        title: "smuggled pod-wide note",
      })
    ).rejects.toMatchObject(GRANT_DENIED);
    const { rows } = await q(
      `select id from entities where title = 'smuggled pod-wide note'`
    );
    expect(rows).toHaveLength(0);
  });

  it("CONTROL — the same key creates a workspace-scope kind, landing in W", async () => {
    const res = await hub(WRITE_IN_WS).entities.createEntity({
      userId: USER,
      profileSlug: "task",
      title: "a task in W",
    });
    expect(res.status).toBe("created");
    const { rows } = await q<{ workspace_id: string }>(
      `select workspace_id from entities where id = $1`,
      [res.id]
    );
    expect(rows[0]?.workspace_id).toBe(WS);
  });
});

describe("entities.createEntity strong-dedup writes nothing before the gate (W2a)", () => {
  it("a create that merges onto a pod-wide match is refused before the body or enrich lands", async () => {
    const docsBefore = (await q(`select id from documents`)).rows.length;
    await expect(
      hub(WRITE_IN_WS).entities.createEntity({
        userId: USER,
        profileSlug: "person",
        title: "Grace Hopper",
        properties: { email: "grace@navy.test", role: "admiral" },
        content: "A long biography that would become the body document.",
      })
    ).rejects.toMatchObject(GRANT_DENIED);
    expect((await q(`select id from documents`)).rows).toHaveLength(docsBefore);
    const { rows } = await q<{ properties: Record<string, unknown> }>(
      `select properties from entities where id = $1`,
      [POD_PERSON]
    );
    expect(rows[0]?.properties).toEqual({});
  });
});

describe("entities.updateEntity gates the STORED row (W2a)", () => {
  it("a note-only key cannot convert a `person` by naming profileSlug: note", async () => {
    const proposalsBefore = (await q(`select id from proposals`)).rows.length;
    await expect(
      hub(NOTE_UPDATE_ONLY).entities.updateEntity({
        entityId: PERSON,
        userId: USER,
        profileSlug: "note",
      })
    ).rejects.toMatchObject({
      ...GRANT_DENIED,
      message: expect.stringMatching(/entity\.person\.update/),
    });
    // Refused, never filed for review: approving it would widen the grant.
    const { rows } = await q(`select id from proposals`);
    expect(rows).toHaveLength(proposalsBefore);
  });

  it("a key that writes only in W cannot edit a pod-wide row through the header workspace", async () => {
    await expect(
      hub(WRITE_IN_WS).entities.updateEntity({
        entityId: POD_NOTE,
        userId: USER,
        title: "rewritten",
      })
    ).rejects.toMatchObject(GRANT_DENIED);
    const { rows } = await q<{ title: string }>(
      `select title from entities where id = $1`,
      [POD_NOTE]
    );
    expect(rows[0]?.title).toBe("pod note");
  });

  it("CONTROL — the same key edits a row stored in W", async () => {
    const res = await hub(WRITE_IN_WS).entities.updateEntity({
      entityId: WS_NOTE,
      userId: USER,
      title: "ws note, edited",
    });
    expect(res.status).toBe("updated");
  });
});

describe("entities.updateEntities gates each STORED row (W2a)", () => {
  it("a key that writes only in W gets the pod-wide row denied, the W row applied", async () => {
    const res = await hub(WRITE_IN_WS).entities.updateEntities({
      userId: USER,
      items: [
        { id: POD_NOTE, patch: { title: "batch rewrite" } },
        { id: WS_NOTE, patch: { title: "ws note, batch" } },
      ],
    });
    expect(res.denied.map((d) => d.id)).toEqual([POD_NOTE]);
    expect(res.denied[0]?.reason).toMatch(/grant does not allow/);
    expect(res.applied).toEqual([WS_NOTE]);
    const { rows } = await q<{ title: string }>(
      `select title from entities where id = $1`,
      [POD_NOTE]
    );
    expect(rows[0]?.title).toBe("pod note");
  });
});

describe("a key pinned to W READS a pod-wide person roled in W, and still cannot WRITE it (option 1)", () => {
  it("reach: the list in W returns the pod-wide person roled there (not an un-roled one)", async () => {
    const rows = (await hub(APP_IN_WS).entities.getEntities({
      userId: USER,
      workspaceId: WS,
      profileSlug: "person",
    })) as Array<{ id: string }>;
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(POD_LEAD);
    expect(ids).not.toContain(POD_PERSON);
  });

  it("an edit of it is refused on the stored row (pod-wide), never filed for review", async () => {
    const proposalsBefore = (await q(`select id from proposals`)).rows.length;
    await expect(
      hub(APP_IN_WS).entities.updateEntity({
        entityId: POD_LEAD,
        userId: USER,
        title: "rewritten by the app",
      })
    ).rejects.toMatchObject(GRANT_DENIED);
    expect((await q(`select id from proposals`)).rows).toHaveLength(
      proposalsBefore
    );
    const { rows } = await q<{ title: string }>(
      `select title from entities where id = $1`,
      [POD_LEAD]
    );
    expect(rows[0]?.title).toBe("Katherine Johnson");
  });

  it("the batch door denies it too", async () => {
    const res = await hub(APP_IN_WS).entities.updateEntities({
      userId: USER,
      items: [{ id: POD_LEAD, patch: { title: "batch rewrite" } }],
    });
    expect(res.denied.map((d) => d.id)).toEqual([POD_LEAD]);
    expect(res.denied[0]?.reason).toMatch(/grant does not allow/);
    expect(res.applied).toEqual([]);
  });
});
