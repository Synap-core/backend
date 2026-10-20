/**
 * S7 W2c — the rest of class (c): each door's writes are bounded by the
 * calling key's grant on their real target, and nothing is written before or
 * past the gate (plan 13 §3.4).
 *
 *  - linking.linkEntity / linkDocument: a `proposed` gate returns the proposal
 *    — the link used to be inserted anyway;
 *  - views.createView with no workspace and no project: a pod-wide view, now
 *    grant-checked as pod scope (it had no gate at all);
 *  - documents.upsertSessionSection: the session document is created only
 *    after the grant allows creating a document in the session's workspace;
 *  - migration.migrate: its property defs pass the propertyDefs.create gate
 *    (a base def is pod scope);
 *  - signals.fetch / batch: a plain relay path only, and a fetch recorded in a
 *    workspace needs the grant there; signals.subscriptions / capture: every
 *    write is grant-checked where it lands;
 *  - n8nActions.createEntity (core router): its pod-scope create is refused,
 *    as a 403, to a key pinned to a space.
 *
 * Driven through the REAL Bearer door (`hubProtocolRouter` / `coreRouter` →
 * `apiKeyMiddleware` → the procedure) on PGlite with every @synap/database
 * table; only the key lookup, identity resolution and delivery side effects
 * are stubbed, plus the outbound relay `fetch`.
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
  blobs: new Map<string, Buffer>(),
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
// Object storage in memory: the session document's body round-trips.
vi.mock("@synap/storage", () => ({
  storage: {
    buildPath: (...parts: string[]) => parts.join("/"),
    upload: async (key: string, content: Buffer | string) => {
      const body = Buffer.from(content);
      h.blobs.set(key, body);
      return {
        path: key,
        url: `mem://${key}`,
        size: body.length,
        checksum: "",
      };
    },
    downloadBuffer: async (key: string) => h.blobs.get(key) ?? Buffer.from(""),
  },
}));
vi.mock("../../services/api-keys.js", () => ({
  apiKeyService: {
    validateApiKey: vi.fn(async () => ({
      id: "11111111-1111-4111-8111-111111111111",
      userId: "22222222-2222-4222-8222-222222222222",
      linkedUserId: null,
      keyName: "w2a",
      keyType: "user_pat",
      workspaceId: null,
      scope: ["hub-protocol.read", "hub-protocol.write", "write:entities"],
    })),
    checkRateLimit: vi.fn(() => true),
  },
}));
vi.mock("../../access/key-identity.js", () => ({
  resolveKeyIdentity: vi.fn(async () => ({
    effectiveUserId: "22222222-2222-4222-8222-222222222222",
    agentUserId: undefined,
    grant: h.grant,
  })),
}));

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { hubProtocolRouter } from "./index.js";
import { coreRouter } from "../../root.js";
import { config } from "@synap-core/core";

const USER = "22222222-2222-4222-8222-222222222222";
const WS = randomUUID();
const WS2 = randomUUID(); // a second space the key may write, with no review rule
const OTHER_WS = randomUUID();
const NOTE_PROFILE = randomUUID();
const SIGNAL_PROFILE = randomUUID();
const WS_THREAD = randomUUID();
const WS2_THREAD = randomUUID();
const WS_ENTITY = randomUUID();
const WS_DOC = randomUUID();
const OTHER_SESSION = randomUUID();
const WS_SESSION = randomUUID();

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
const count = async (sql: string, params?: unknown[]) =>
  (await q(sql, params)).rows.length;

const scope = (permissions: string[], workspaceIds: string[] | null) => ({
  permissions,
  workspaceIds,
  projectIds: null,
  entityIds: null,
});
/** Reads anywhere; writes ANYTHING, but only in WS and WS2. */
const WRITE_IN_WS = {
  scopes: [
    scope(
      [
        "entity.read",
        "profile.read",
        "channel.read",
        "document.read",
        "session.read",
        "view.read",
        "source.read",
      ],
      null
    ),
    scope(["*"], [WS, WS2]),
  ],
  clientId: null,
};

/** The Bearer door with `x-workspace-id: WS` (createContext → ctx.workspaceId). */
function bearer() {
  h.grant = WRITE_IN_WS;
  return {
    req: new Request("http://pod.test/api/hub/trpc/x", {
      headers: { authorization: "Bearer sk_test", "x-workspace-id": WS },
    }),
    authenticated: false,
    workspaceId: WS,
  } as never;
}
const hub = () => hubProtocolRouter.createCaller(bearer());

// `expect.stringMatching`, never a bare RegExp: `toMatchObject` treats a RegExp
// property as an empty object and matches ANY message.
const GRANT_DENIED = {
  code: "FORBIDDEN",
  message: expect.stringMatching(/grant does not allow/),
};

const relayFetch = vi.fn(
  async () =>
    new Response(JSON.stringify([{ title: "item" }]), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
);

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  // The column defaults the derived DDL leaves out, where a control reads them.
  await h.client!.exec(`
    alter table documents alter column content_revision set default 1;
    alter table signal_subscriptions alter column is_active set default true;
    alter table signal_subscriptions alter column created_at set default now();
    alter table signal_subscriptions alter column updated_at set default now();
  `);
  vi.stubGlobal("fetch", relayFetch);
  (config.server as { controlPlaneUrl?: string }).controlPlaneUrl =
    "http://cp.test";

  await q(`insert into users (id, email, user_type) values ($1, $2, 'human')`, [
    USER,
    `${USER}@x`,
  ]);
  for (const ws of [WS, WS2, OTHER_WS]) {
    await q(
      `insert into workspaces (id, owner_id, name) values ($1, $2, 'w')`,
      [ws, USER]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values (gen_random_uuid(), $1, $2, 'owner')`,
      [ws, USER]
    );
  }
  await q(
    `insert into profiles (id, slug, display_name, scope, entity_scope, profile_kind, is_active, origin, ui_hints, default_values)
     values ($1, 'note', 'Note', 'system', 'pod', 'kind', true, 'authored', '{}', '{}'),
            ($2, 'signal_item', 'Signal', 'system', 'workspace', 'kind', true, 'authored', '{}', '{}')`,
    [NOTE_PROFILE, SIGNAL_PROFILE]
  );
  await q(
    `insert into entities (id, user_id, type, profile_id, title, workspace_id, properties)
     values ($1, $2, 'note', $3, 'ws note', $4, '{}')`,
    [WS_ENTITY, USER, NOTE_PROFILE, WS]
  );
  await q(
    `insert into documents (id, user_id, title, workspace_id) values ($1, $2, 'doc', $3)`,
    [WS_DOC, USER, WS]
  );
  await q(
    `insert into channels (id, user_id, workspace_id, channel_type, status, metadata)
     values ($1, $3, $4, 'thread', 'active', '{}'), ($2, $3, $5, 'thread', 'active', '{}')`,
    [WS_THREAD, WS2_THREAD, USER, WS, WS2]
  );
  // WS reviews every context link (rung 2.8): the gate answers `proposed`.
  await q(
    `insert into governance_rules (id, principal_kind, scope_kind, workspace_id, target_kind, target_pattern, verdict, created_by, created_at)
     values (gen_random_uuid(), 'any', 'workspace', $1, 'action', 'context.link', 'propose', $2, now())`,
    [WS, USER]
  );
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, title, goal, status)
     values ($1, $3, $4, 's', 'g', 'active'), ($2, $3, $5, 's', 'g', 'active')`,
    [OTHER_SESSION, WS_SESSION, USER, OTHER_WS, WS]
  );
});

describe("linking.* never writes a link the gate filed for review (W2c)", () => {
  it("linkEntity: proposed → the proposal comes back, no context item", async () => {
    const res = await hub().linking.linkEntity({
      userId: USER,
      threadId: WS_THREAD,
      entityId: WS_ENTITY,
    });
    expect(res).toMatchObject({ status: "proposed", linked: false });
    expect(
      await count(
        `select id from channel_context_items where channel_id = $1`,
        [WS_THREAD]
      )
    ).toBe(0);
  });

  it("linkDocument: proposed → the proposal comes back, no context item", async () => {
    const res = await hub().linking.linkDocument({
      userId: USER,
      threadId: WS_THREAD,
      documentId: WS_DOC,
    });
    expect(res).toMatchObject({ status: "proposed", linked: false });
    expect(
      await count(
        `select id from channel_context_items where channel_id = $1`,
        [WS_THREAD]
      )
    ).toBe(0);
  });

  it("CONTROL — where links auto-apply, the link is written", async () => {
    const res = await hub().linking.linkEntity({
      userId: USER,
      threadId: WS2_THREAD,
      entityId: WS_ENTITY,
    });
    expect(res).toMatchObject({ success: true, linked: true });
  });
});

describe("views.createView with no workspace is pod scope (W2c)", () => {
  it("a key pinned to spaces cannot create a pod-wide view", async () => {
    await expect(
      hub().views.createView({
        userId: USER,
        name: "smuggled pod-wide view",
        type: "table",
      })
    ).rejects.toMatchObject(GRANT_DENIED);
    expect(
      await count(`select id from views where name = 'smuggled pod-wide view'`)
    ).toBe(0);
  });

  it("CONTROL — the same key creates a view in W", async () => {
    const res = await hub().views.createView({
      userId: USER,
      workspaceId: WS,
      name: "a view in W",
      type: "table",
      profileId: NOTE_PROFILE,
    });
    expect(res.status).not.toBe("denied");
    expect(await count(`select id from views where name = 'a view in W'`)).toBe(
      1
    );
  });
});

describe("documents.upsertSessionSection creates nothing outside the grant (W2c)", () => {
  const write = (sessionId: string) =>
    hub().documents.upsertSessionSection({
      sessionId,
      sectionId: "notes",
      title: "Notes",
      body: "hello",
      baseVersion: null,
    });

  it("a session in another space gets no document", async () => {
    const before = await count(`select id from documents`);
    await expect(write(OTHER_SESSION)).rejects.toMatchObject(GRANT_DENIED);
    expect(await count(`select id from documents`)).toBe(before);
  });

  it("CONTROL — a session in W gets its document", async () => {
    const before = await count(`select id from documents`);
    const res = await write(WS_SESSION);
    expect(res.status).not.toBe("denied");
    expect(await count(`select id from documents`)).toBe(before + 1);
  });
});

describe("migration.migrate writes its schema only where the grant allows (W2c)", () => {
  it("a base property def is pod scope: not stored for a key pinned to W", async () => {
    await hub().migration.migrate({
      userId: USER,
      workspaceId: WS,
      profiles: [
        {
          slug: "note",
          displayName: "Note",
          scope: "SYSTEM",
          properties: [{ slug: "smuggled-def", valueType: "string" }],
        },
      ],
      entities: [],
      views: [],
    });
    expect(
      await count(`select id from property_defs where slug = 'smuggled-def'`)
    ).toBe(0);
  });
});

describe("signals.* (W2c)", () => {
  it("fetch: a route that is not a plain path never reaches the relay", async () => {
    relayFetch.mockClear();
    for (const sourceRoute of ["/../admin", "//evil.test/x", "/a?b=c", "x"]) {
      await expect(
        hub().signals.fetch({ sourceRoute, sourcePlatform: "rss" })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(relayFetch).not.toHaveBeenCalled();
  });

  it("fetch: recording into another space is refused before the relay call", async () => {
    relayFetch.mockClear();
    await expect(
      hub().signals.fetch({
        sourceRoute: "/hackernews/best",
        sourcePlatform: "hackernews",
        context: { workspaceId: OTHER_WS, userId: USER },
      })
    ).rejects.toMatchObject(GRANT_DENIED);
    expect(relayFetch).not.toHaveBeenCalled();
    expect(await count(`select id from signal_fetch_history`)).toBe(0);
  });

  it("CONTROL — fetch recorded in W", async () => {
    const res = await hub().signals.fetch({
      sourceRoute: "/hackernews/best",
      sourcePlatform: "hackernews",
      context: { workspaceId: WS, userId: USER },
    });
    expect(res.success).toBe(true);
    expect(
      await count(
        `select id from signal_fetch_history where workspace_id = $1`,
        [WS]
      )
    ).toBe(1);
  });

  it("batch: a fetch op recording into another space fails, nothing recorded", async () => {
    const res = await hub().signals.batch({
      userId: USER,
      workspaceId: OTHER_WS,
      operations: [
        {
          type: "fetch",
          id: "f1",
          data: {
            sourceRoute: "/hackernews/best",
            sourcePlatform: "hackernews",
          },
        },
      ],
    });
    expect(res.operations[0]).toMatchObject({ success: false });
    expect(
      await count(
        `select id from signal_fetch_history where workspace_id = $1`,
        [OTHER_WS]
      )
    ).toBe(0);
  });

  it("subscriptions: creating one in another space is refused, nothing stored", async () => {
    const res = await hub().signals.subscriptions({
      userId: USER,
      workspaceId: OTHER_WS,
      operations: [{ operation: "create", subscription: { topic: "ai" } }],
    });
    expect(res.results[0]).toMatchObject({
      success: false,
      error: expect.stringMatching(/grant does not allow/),
    });
    expect(await count(`select id from signal_subscriptions`)).toBe(0);
  });

  it("CONTROL — subscriptions: one is created in W", async () => {
    const res = await hub().signals.subscriptions({
      userId: USER,
      workspaceId: WS,
      operations: [{ operation: "create", subscription: { topic: "ai" } }],
    });
    expect(res.results[0]).toMatchObject({ success: true });
  });

  it("capture: the feed post into another space is refused before anything is written", async () => {
    const before = await count(`select id from entities`);
    await expect(
      hub().signals.capture({
        signalData: {
          sourcePlatform: "rss",
          sourceRoute: "/feed",
          url: "https://news.test/a",
          title: "A headline",
          publishedAt: new Date().toISOString(),
          topics: [],
        },
        capture: { workspaceId: OTHER_WS, userId: USER },
      })
    ).rejects.toMatchObject(GRANT_DENIED);
    expect(await count(`select id from entities`)).toBe(before);
  });
});

describe("n8nActions.createEntity (core router) is bounded by the grant (W2c)", () => {
  it("a pod-scope create is refused to a key pinned to spaces — as a 403", async () => {
    await expect(
      coreRouter.createCaller(bearer()).n8nActions.createEntity({
        type: "note",
        title: "smuggled n8n note",
        content: "body",
      })
    ).rejects.toMatchObject(GRANT_DENIED);
    expect(
      await count(`select id from entities where title = 'smuggled n8n note'`)
    ).toBe(0);
  });
});
