/**
 * S7 W2a — the schema and graph doors gate the key's grant on the TARGET, never
 * on the workspace the caller named (plan 13 §3.4 bullet 1, decision D2).
 *
 * Driven through the REAL Bearer door: `hubProtocolRouter` → `apiKeyMiddleware`
 * (the S7 fence, then `runWithGrant`) → the hub procedure → the real router
 * door → `checkPermissionOrPropose` rung 0, on PGlite with every
 * @synap/database table. Only the key lookup and identity resolution are
 * stubbed, plus the delivery side effects (job queue, realtime).
 *
 * The key READS anywhere and WRITES anything (`*`) but only in W. Each red
 * case is a write whose real target is NOT W while the caller names W (body
 * `workspaceId` and `x-workspace-id`) — the shape every header/input fallback
 * let through. Each control is the same key writing a target that IS in W.
 *
 *  - relations.createRelation: an edge between two pod-wide entities lands
 *    pod-wide (D4 placement);
 *  - relations.deleteRelation: the stored edge lives in another workspace;
 *  - profiles.createProfile: re-declaring an existing SHARED kind from another
 *    workspace opens it there (grantAccess wrote before any gate); renaming a
 *    system kind is a pod-scope write;
 *  - profiles.setRenderer: a `pod` binding is pod scope;
 *  - profiles.createPropertyDef: a base def is stored pod-wide;
 *  - profiles.updatePropertyDef: the stored def is pod-wide;
 *  - entities.attach/update/detachFacet (D2): the PARENT entity is pod-wide.
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
      userId: "user-w2a-schema",
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
    effectiveUserId: "user-w2a-schema",
    agentUserId: undefined,
    grant: h.grant,
  })),
}));

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { hubProtocolRouter } from "./index.js";

const USER = "user-w2a-schema";
const WS = randomUUID();
const OTHER_WS = randomUUID(); // the caller is a member; the key is not pinned here
const NOTE_PROFILE = randomUUID(); // system kind, pod-wide
const SHARED_KIND = randomUUID(); // shared kind homed in WS
const ROLE = randomUUID(); // a workspace role in WS, any kind
const POD_NOTE = randomUUID();
const POD_NOTE_2 = randomUUID();
const WS_NOTE = randomUUID();
const WS_NOTE_2 = randomUUID();
const POD_EDGE = randomUUID();
const WS_EDGE = randomUUID();
const OTHER_EDGE = randomUUID(); // stored in OTHER_WS
const BASE_DEF = randomUUID(); // pod-wide base property def
const OVERLAY_DEF = randomUUID(); // WS overlay property def
const POD_PARENT_FACET = randomUUID(); // facet row in WS on a pod-wide parent
const POD_PARENT_FACET_2 = randomUUID();
const WS_FACET = randomUUID();

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
/** Reads the schema and graph anywhere; writes ANYTHING, but only in WS. */
const WRITE_IN_WS = {
  scopes: [
    scope(
      [
        "entity.read",
        "profile.read",
        "relation.read",
        "property_def.read",
        "facet.read",
      ],
      null
    ),
    scope(["*"], [WS]),
  ],
  clientId: null,
};

/** The Bearer door with `x-workspace-id: WS` (createContext → ctx.workspaceId). */
function hub(grant: unknown = WRITE_IN_WS) {
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
/**
 * The hub schema doors file every meta-model write for review (source
 * `intelligence`, never auto-approved). A filed proposal proves the grant rung
 * PASSED: a grant denial refuses, it never proposes.
 */
const PASSED_THE_GRANT = "proposed";

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  await q(`insert into users (id, email, user_type) values ($1, $2, 'human')`, [
    USER,
    `${USER}@x`,
  ]);
  for (const ws of [WS, OTHER_WS]) {
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
    `insert into profiles (id, slug, display_name, scope, entity_scope, profile_kind, is_active, origin, ui_hints, default_values, workspace_id, user_id)
     values ($1, 'note', 'Note', 'system', 'pod', 'kind', true, 'authored', '{}', '{}', null, null),
            ($2, 'deal', 'Deal', 'shared', 'workspace', 'kind', true, 'authored', '{}', '{}', $4, $5),
            ($3, 'client', 'Client', 'workspace', 'workspace', 'role', true, 'authored', '{}', '{}', $4, $5)`,
    [NOTE_PROFILE, SHARED_KIND, ROLE, WS, USER]
  );
  await q(
    `insert into entities (id, user_id, type, profile_id, title, workspace_id, properties)
     values ($1, $5, 'note', $6, 'pod note', null, '{}'),
            ($2, $5, 'note', $6, 'pod note 2', null, '{}'),
            ($3, $5, 'note', $6, 'ws note', $7, '{}'),
            ($4, $5, 'note', $6, 'ws note 2', $7, '{}')`,
    [POD_NOTE, POD_NOTE_2, WS_NOTE, WS_NOTE_2, USER, NOTE_PROFILE, WS]
  );
  await q(
    `insert into relations (id, user_id, source_entity_id, target_entity_id, type, workspace_id)
     values ($1, $3, $4, $5, 'same_subject', null),
            ($2, $3, $6, $7, 'same_subject', $8),
            ($9, $3, $6, $7, 'same_subject', $10)`,
    [
      POD_EDGE,
      WS_EDGE,
      USER,
      POD_NOTE,
      POD_NOTE_2,
      WS_NOTE,
      WS_NOTE_2,
      WS,
      OTHER_EDGE,
      OTHER_WS,
    ]
  );
  await q(
    `insert into property_defs (id, slug, profile_id, workspace_id, value_type, constraints, ui_hints)
     values ($1, 'mood', $3, null, 'string', '{}', '{}'),
            ($2, 'ws-mood', $3, $4, 'string', '{}', '{}')`,
    [BASE_DEF, OVERLAY_DEF, NOTE_PROFILE, WS]
  );
  await q(
    `insert into entity_facets (id, entity_id, profile_id, user_id, workspace_id, properties, metadata)
     values ($1, $4, $6, $7, $8, '{}', '{}'),
            ($2, $5, $6, $7, $8, '{}', '{}'),
            ($3, $9, $6, $7, $8, '{}', '{}')`,
    [
      POD_PARENT_FACET,
      POD_PARENT_FACET_2,
      WS_FACET,
      POD_NOTE,
      POD_NOTE_2,
      ROLE,
      USER,
      WS,
      WS_NOTE,
    ]
  );
});

describe("relations gate the grant where the edge LIVES (W2a)", () => {
  it("an edge between two pod-wide entities is pod scope, whatever workspace is named", async () => {
    await expect(
      hub().relations.createRelation({
        userId: USER,
        workspaceId: WS,
        sourceEntityId: POD_NOTE,
        targetEntityId: POD_NOTE_2,
        type: "same_subject",
      })
    ).rejects.toMatchObject(GRANT_DENIED);
    const { rows } = await q(
      `select id from relations where source_entity_id = $1 and id <> $2`,
      [POD_NOTE, POD_EDGE]
    );
    expect(rows).toHaveLength(0);
  });

  it("CONTROL — an edge between two entities in W is created", async () => {
    const res = await hub().relations.createRelation({
      userId: USER,
      workspaceId: WS,
      sourceEntityId: WS_NOTE_2,
      targetEntityId: WS_NOTE,
      type: "same_subject",
    });
    expect(res).toMatchObject({ status: "created" });
  });

  // (A pod-wide edge is refused to everyone by `assertWorkspaceWrite` before
  // the gate, so the edge that proves the grant target lives in ANOTHER space.)
  it("an edge stored in another workspace cannot be deleted through W", async () => {
    await expect(
      hub().relations.deleteRelation({
        userId: USER,
        workspaceId: WS,
        relationId: OTHER_EDGE,
      })
    ).rejects.toMatchObject(GRANT_DENIED);
    const { rows } = await q(`select id from relations where id = $1`, [
      OTHER_EDGE,
    ]);
    expect(rows).toHaveLength(1);
  });

  it("CONTROL — an edge stored in W is deleted", async () => {
    const res = await hub().relations.deleteRelation({
      userId: USER,
      workspaceId: WS,
      relationId: WS_EDGE,
    });
    expect(res).toMatchObject({ status: "deleted" });
  });
});

describe("profiles.createProfile writes nothing outside the grant (W2a)", () => {
  it("re-declaring a shared kind from another workspace is refused before grantAccess", async () => {
    await expect(
      hub().profiles.createProfile({
        userId: USER,
        workspaceId: OTHER_WS,
        slug: "deal",
        displayName: "Deal",
      })
    ).rejects.toMatchObject(GRANT_DENIED);
    const { rows } = await q(
      `select profile_id from profile_workspace_access where workspace_id = $1`,
      [OTHER_WS]
    );
    expect(rows).toHaveLength(0);
  });

  it("renaming a system kind is a pod-scope write", async () => {
    await expect(
      hub().profiles.createProfile({
        userId: USER,
        workspaceId: WS,
        slug: "note",
        displayName: "Renamed note",
      })
    ).rejects.toMatchObject(GRANT_DENIED);
    const { rows } = await q<{ display_name: string }>(
      `select display_name from profiles where id = $1`,
      [NOTE_PROFILE]
    );
    expect(rows[0]?.display_name).toBe("Note");
  });

  it("CONTROL — a new kind defined in W passes the grant", async () => {
    const res = await hub().profiles.createProfile({
      userId: USER,
      workspaceId: WS,
      slug: "ws-kind",
      displayName: "WS kind",
      entityScope: "workspace",
    });
    expect(res).toMatchObject({ status: PASSED_THE_GRANT });
  });
});

describe("profiles.setRenderer gates where the binding lands (W2a)", () => {
  it("a `pod` binding is pod scope, whatever workspace is named", async () => {
    await expect(
      hub().profiles.setRenderer({
        userId: USER,
        workspaceId: WS,
        profileSlug: "note",
        slot: "detail",
        cellKey: "some-cell",
        scope: "pod",
      })
    ).rejects.toMatchObject(GRANT_DENIED);
  });

  it("CONTROL — a `workspace` binding in W passes the grant", async () => {
    const res = await hub().profiles.setRenderer({
      userId: USER,
      workspaceId: WS,
      profileSlug: "note",
      slot: "detail",
      cellKey: "some-cell",
      scope: "workspace",
    });
    expect(res.status).toBe(PASSED_THE_GRANT);
  });
});

describe("property defs gate where the def LIVES (W2a)", () => {
  it("a base def lands pod-wide: refused, nothing stored", async () => {
    await expect(
      hub().profiles.createPropertyDef({
        userId: USER,
        workspaceId: WS,
        profileId: NOTE_PROFILE,
        slug: "smuggled-base",
        valueType: "string",
      })
    ).rejects.toMatchObject(GRANT_DENIED);
    const { rows } = await q(
      `select id from property_defs where slug = 'smuggled-base'`
    );
    expect(rows).toHaveLength(0);
  });

  it("CONTROL — an overlay def in W passes the grant", async () => {
    const res = await hub().profiles.createPropertyDef({
      userId: USER,
      workspaceId: WS,
      profileId: NOTE_PROFILE,
      slug: "ws-overlay",
      valueType: "string",
      overlay: true,
    });
    expect(res.status).toBe(PASSED_THE_GRANT);
  });

  it("a stored pod-wide base def cannot be edited through W", async () => {
    await expect(
      hub().profiles.updatePropertyDef({
        userId: USER,
        workspaceId: WS,
        propertyDefId: BASE_DEF,
        uiHints: { label: "rewritten" },
      })
    ).rejects.toMatchObject(GRANT_DENIED);
    const { rows } = await q<{ ui_hints: Record<string, unknown> }>(
      `select ui_hints from property_defs where id = $1`,
      [BASE_DEF]
    );
    expect(rows[0]?.ui_hints).toEqual({});
  });

  it("CONTROL — an edit of the W overlay def passes the grant", async () => {
    const res = await hub().profiles.updatePropertyDef({
      userId: USER,
      workspaceId: WS,
      propertyDefId: OVERLAY_DEF,
      uiHints: { label: "edited" },
    });
    expect(res.status).toBe(PASSED_THE_GRANT);
  });
});

describe("facets gate on the PARENT entity's workspace (W2a, D2)", () => {
  it("attaching a W role onto a pod-wide entity is refused", async () => {
    await expect(
      hub().entities.attachFacet({
        userId: USER,
        entityId: POD_NOTE_2,
        profileId: ROLE,
        workspaceId: WS,
      })
    ).rejects.toMatchObject(GRANT_DENIED);
    const { rows } = await q(
      `select id from entity_facets where entity_id = $1 and id <> $2`,
      [POD_NOTE_2, POD_PARENT_FACET_2]
    );
    expect(rows).toHaveLength(0);
  });

  it("CONTROL — the same role attaches onto an entity in W", async () => {
    const res = await hub().entities.attachFacet({
      userId: USER,
      entityId: WS_NOTE_2,
      profileId: ROLE,
      workspaceId: WS,
    });
    expect(res).toMatchObject({ status: "attached" });
  });

  it("updating a facet whose parent is pod-wide is refused", async () => {
    await expect(
      hub().entities.updateFacet({
        userId: USER,
        facetId: POD_PARENT_FACET,
        properties: { tier: "gold" },
      })
    ).rejects.toMatchObject(GRANT_DENIED);
    const { rows } = await q<{ properties: Record<string, unknown> }>(
      `select properties from entity_facets where id = $1`,
      [POD_PARENT_FACET]
    );
    expect(rows[0]?.properties).toEqual({});
  });

  it("detaching a facet whose parent is pod-wide is refused", async () => {
    await expect(
      hub().entities.detachFacet({
        userId: USER,
        facetId: POD_PARENT_FACET_2,
      })
    ).rejects.toMatchObject(GRANT_DENIED);
    const { rows } = await q<{ deleted_at: unknown }>(
      `select deleted_at from entity_facets where id = $1`,
      [POD_PARENT_FACET_2]
    );
    expect(rows[0]?.deleted_at).toBeNull();
  });

  it("CONTROL — a facet on an entity in W is detached", async () => {
    const res = await hub().entities.detachFacet({
      userId: USER,
      facetId: WS_FACET,
    });
    expect(res).toMatchObject({ status: "detached" });
  });
});
