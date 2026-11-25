/**
 * The design door for an APP (plan 0fc746f4 §2.6, W5): the Design app signs
 * the person in (`app_person`) with a grant of entity permissions and no
 * `capability … run`, and reads and changes designs through `GET
 * /designs/catalog`, `GET /designs/:id` and `POST /designs/apply`.
 *
 * Driven through the REAL hub auth door (W1 fence, `appPersonWriteAllowed`,
 * `runWithGrant`), the REAL routes and the REAL design door, on PGlite, with
 * each key's grant as a real `grants` row. The entity door behind the design
 * door is a stand-in that runs the gate's rung 0 itself (`grantWriteDenial`,
 * the real one, on the request's grant) and records what reached it; the rest
 * of `checkPermissionOrPropose` (the caller's own rung) is the entity door's
 * own suite.
 *
 * Rows rule out:
 *   - the fence refusing the app its doors (a person token holding entity
 *     permissions but no `capability … run`);
 *   - a write applied without `entity.ui-design.update` (or `.create` for
 *     create_design): refused 403, naming the permission, nothing written;
 *   - the person's write being forced into review (`forcePropose`) or
 *     governed as an agent;
 *   - an agent's key losing its agent identity on the way (its write must
 *     reach the entity door as that agent);
 *   - a design the grant does not reach being read (404), and a key that
 *     reads no kind reaching the read doors (403);
 *   - the batch's guarantees lost on this door: a stale `baseUpdatedAt` is a
 *     409 and writes nothing, a refused op a 422 naming the op and the hash.
 *
 * Stubbed: the key lookup (`getApiKeyStatus`; the grant rows are real), the
 * guest check, the ui-design lifecycle read, the designs' space lookup, the
 * entity door past rung 0. Cannot see: production Postgres, a real minted
 * app token, the entity door's own rungs.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  getApiKeyStatus: vi.fn(),
  space: "",
  writes: [] as Array<{
    action: "create" | "update";
    ctx: Record<string, unknown>;
    input: Record<string, unknown>;
  }>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return { ...actual, db, getDb: async () => db };
});
vi.mock("../../../access/guest-containment.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isGuestPrincipal: vi.fn(async () => false),
}));
vi.mock("../../../services/api-keys.js", () => ({
  apiKeyService: {
    getApiKeyStatus: (...a: unknown[]) => h.getApiKeyStatus(...a),
    recordKeyUse: vi.fn(),
    checkRateLimit: () => true,
  },
}));
vi.mock("../../../services/external-user-mapping.js", () => ({
  isSubTokenFeatureEnabled: () => false,
  resolveExternalUserMapping: vi.fn(),
}));
vi.mock("../../../services/installed-template-space.js", () => ({
  installedTemplateSpace: async () => ({ id: h.space, name: "Builder" }),
}));
vi.mock("../../../services/lifecycle/board-lens.js", () => ({
  resolveProfileLifecycle: async () => ({}),
  toLifecycleWire: () => ({
    profileSlug: "ui-design",
    property: "design-status",
    options: [
      { key: "draft", label: "Draft", category: "open", humanOnly: false },
      {
        key: "approved",
        label: "Approved",
        category: "active",
        humanOnly: true,
      },
    ],
    initialStatus: "draft",
  }),
}));
// The entity door past rung 0: the real `grantWriteDenial` on the request's
// grant (what `checkPermissionOrPropose` runs first), then a record.
vi.mock("../../entities.js", async () => {
  const { TRPCError } = await import("@trpc/server");
  const { grantWriteDenial } =
    await import("../../../utils/grant-write-check.js");
  const rung0 = async (
    action: "create" | "update",
    workspaceId: string | null,
    data: Record<string, unknown>
  ) => {
    const denied = await grantWriteDenial({
      subjectType: "entity",
      action,
      workspaceId,
      data,
    });
    if (denied) throw new TRPCError({ code: "FORBIDDEN", message: denied });
  };
  return {
    entitiesRouter: {
      createCaller: (ctx: Record<string, unknown>) => ({
        create: async (input: Record<string, unknown>) => {
          await rung0(
            "create",
            (input.targetWorkspaceId as string | undefined) ?? null,
            { profileSlug: input.profileSlug }
          );
          h.writes.push({ action: "create", ctx, input });
          return { id: randomUUID(), updatedAt: new Date() };
        },
        update: async (input: Record<string, unknown>) => {
          await rung0("update", (ctx.workspaceId as string | null) ?? null, {
            id: input.id,
          });
          h.writes.push({ action: "update", ctx, input });
          return { id: input.id, updatedAt: new Date() };
        },
      }),
    },
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import "../../../access/grant-read.js";
import { hubAuthMiddleware } from "../_middleware/auth.js";
import { registerDesignsRoutes } from "./designs.js";
import type { HubHono, HubVariables } from "./_shared.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : c.name === "is_active"
          ? " default true"
          : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const OWNER = randomUUID();
const AGENT = randomUUID();
const DESIGNS = randomUUID();
const DESIGN = randomUUID();
const NOTE = randomUUID();

const CATALOG = {
  kitId: "synap",
  hash: "h-1",
  components: {},
  layout: {
    Section: { children: { kind: "slot" } },
    Text: { text: { kind: "text" } },
  },
};
const BOARD = {
  format: "synap-board/2",
  frames: [
    {
      id: "d",
      name: "Home",
      x: 0,
      y: 0,
      w: 1440,
      h: 900,
      page: {
        root: { props: {} },
        content: [{ type: "Section", props: { id: "sec" } }],
      },
    },
  ],
};

interface Key {
  id: string;
  keyType: string;
  principal: string;
  person: string | null;
  permissions: string[];
}
/** What the Design app asks for. */
const DESIGN_APP = [
  "entity.*.read",
  "project.read",
  "proposal.read",
  "entity.ui-design.create",
  "entity.ui-design.update",
];
const KEYS = {
  /** The Design app, signed in as the person. */
  designer: {
    id: randomUUID(),
    keyType: "app_person",
    principal: OWNER,
    person: null,
    permissions: DESIGN_APP,
  },
  /** The same app, granted reads only. */
  reader: {
    id: randomUUID(),
    keyType: "app_person",
    principal: OWNER,
    person: null,
    permissions: ["entity.*.read", "project.read"],
  },
  /** An app reading notes only: designs are not its to read. */
  notes: {
    id: randomUUID(),
    keyType: "app_person",
    principal: OWNER,
    person: null,
    permissions: ["entity.note.read"],
  },
  /** An app that reads no kind at all. */
  /** The person's own unbounded key (no fence): how the tests read `updatedAt`. */
  owner: {
    id: randomUUID(),
    keyType: "hub_inbound",
    principal: OWNER,
    person: null,
    permissions: ["*"],
  },
  projectsOnly: {
    id: randomUUID(),
    keyType: "app_person",
    principal: OWNER,
    person: null,
    permissions: ["project.read"],
  },
  /** An agent's key with the same grant, acting for the person. */
  agent: {
    id: randomUUID(),
    keyType: "hub_inbound",
    principal: AGENT,
    person: OWNER,
    permissions: DESIGN_APP,
  },
} satisfies Record<string, Key>;
type KeyName = keyof typeof KEYS;

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);
const tableOf = (t: PgTable) => getTableConfig(t).name;

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  h.space = DESIGNS;

  await q(
    `insert into users (id, email, user_type, name) values ($1,$2,'human','Owner')`,
    [OWNER, "owner@example.test"]
  );
  await q(
    `insert into users (id, email, user_type, created_by_user_id) values ($1,$2,'agent',$3)`,
    [AGENT, "agent@example.test", OWNER]
  );
  await q(
    `insert into pod_members (id, user_id, pod_role) values ($1,$2,'owner')`,
    [randomUUID(), OWNER]
  );
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'Builder',$2,'{}'::jsonb)`,
    [DESIGNS, OWNER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), DESIGNS, OWNER]
  );
  await q(
    `insert into ${tableOf(schema.capabilities as unknown as PgTable)} (id, template_key, metadata) values ($1,'design',$2::jsonb)`,
    [randomUUID(), JSON.stringify({ designCatalog: CATALOG })]
  );
  await q(
    `insert into entities (id, user_id, workspace_id, type, title, properties) values ($1,$2,$3,'ui-design','Home',$4::jsonb)`,
    [
      DESIGN,
      OWNER,
      DESIGNS,
      JSON.stringify({
        "design-json": BOARD,
        "design-status": "draft",
        "schema-version": 3,
      }),
    ]
  );
  await q(
    `insert into entities (id, user_id, workspace_id, type, title, properties) values ($1,$2,$3,'note','A note','{}'::jsonb)`,
    [NOTE, OWNER, DESIGNS]
  );

  for (const k of Object.values(KEYS)) {
    await q(
      `insert into api_keys (id, user_id, linked_user_id, is_active) values ($1,$2,$3,true)`,
      [k.id, k.principal, k.person]
    );
    await q(
      `insert into grants (id, api_key_id, principal_user_id, on_behalf_of, permissions, workspace_ids, created_by, client_id)
       values ($1,$2,$3,$4,$5::text[],null,$4,'design-app')`,
      [
        randomUUID(),
        k.id,
        k.principal,
        k.person ?? k.principal,
        `{${k.permissions.join(",")}}`,
      ]
    );
  }
}, 120_000);

beforeEach(() => {
  h.writes.length = 0;
  h.getApiKeyStatus.mockImplementation(async (bearer: string) => {
    const key: Key = KEYS[bearer.replace(/^synap_/, "") as KeyName];
    return {
      status: "valid",
      record: {
        id: key.id,
        userId: key.principal,
        linkedUserId: key.person,
        parentKeyId: null,
        scope: ["hub-protocol.read", "hub-protocol.write"],
        keyType: key.keyType,
        workspaceId: null,
        expiresAt: null,
      },
    };
  });
});

function app() {
  const hub: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  hub.use("/*", hubAuthMiddleware as never);
  registerDesignsRoutes(hub);
  const root = new Hono();
  root.route("/api/hub", hub);
  return root;
}
const send = (
  key: KeyName,
  method: "GET" | "POST",
  path: string,
  body?: unknown
) => {
  const json = body === undefined ? undefined : JSON.stringify(body);
  return app().request(`/api/hub${path}`, {
    method,
    headers: {
      authorization: `Bearer synap_${key}`,
      ...(json
        ? {
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(json)),
          }
        : {}),
    },
    ...(json ? { body: json } : {}),
  });
};
const body = async (res: Response) =>
  (await res.json()) as Record<string, unknown>;

/**
 * The design's `updatedAt` as the door reads it: the next write's
 * `baseUpdatedAt`. Read with the owner's unbounded key, so a write test does
 * not depend on the app's read door.
 */
async function base(): Promise<string> {
  const res = await send("owner", "GET", `/designs/${DESIGN}`);
  expect(res.status, await res.clone().text()).toBe(200);
  const at = ((await body(res)).design as { updatedAt: unknown }).updatedAt;
  expect(typeof at).toBe("string");
  return at as string;
}

const addText = {
  op: "add_block",
  frameId: "d",
  parentId: "sec",
  type: "Text",
  props: { text: "Hi" },
};

describe("the Design app reads designs through its grant", () => {
  it("reads the catalog and a design, and keeps updatedAt for its next write", async () => {
    const cat = await send("designer", "GET", "/designs/catalog");
    expect(cat.status, await cat.clone().text()).toBe(200);
    expect(await body(cat)).toMatchObject({ kitId: "synap", hash: "h-1" });

    const res = await send("designer", "GET", `/designs/${DESIGN}`);
    expect(res.status, await res.clone().text()).toBe(200);
    const read = await body(res);
    expect(read.design).toMatchObject({ id: DESIGN, status: "draft" });
    expect(typeof (read.design as { updatedAt: unknown }).updatedAt).toBe(
      "string"
    );
    expect(read.catalog).toMatchObject({ hash: "h-1" });
  });

  it("a design the grant does not reach is a 404; a key that reads no kind is refused the doors", async () => {
    expect((await send("notes", "GET", `/designs/${DESIGN}`)).status).toBe(404);
    expect(
      (await send("projectsOnly", "GET", `/designs/${DESIGN}`)).status
    ).toBe(403);
    expect((await send("projectsOnly", "GET", "/designs/catalog")).status).toBe(
      403
    );
  });
});

describe("POST /designs/apply: the write is the entity door's, under the key's grant", () => {
  it("the person's token with entity.ui-design.update: applied, as the person, never forced into review", async () => {
    const res = await send("designer", "POST", "/designs/apply", {
      designId: DESIGN,
      baseUpdatedAt: await base(),
      ops: [addText],
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await body(res)).toMatchObject({
      status: "applied",
      designId: DESIGN,
      catalogHash: "h-1",
    });
    expect(h.writes).toHaveLength(1);
    const [w] = h.writes;
    expect(w!.action).toBe("update");
    expect(w!.ctx.userId).toBe(OWNER);
    expect(w!.input.agentUserId).toBeUndefined();
    expect(w!.input.forcePropose).toBeUndefined();
  });

  it("create_design with entity.ui-design.create: created in the designs' space", async () => {
    const res = await send("designer", "POST", "/designs/apply", {
      ops: [
        { op: "create_design", title: "Settings" },
        { op: "add_frame", preset: "desktop", id: "f1" },
      ],
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await body(res)).toMatchObject({ status: "created" });
    expect(h.writes.map((w) => w.action)).toEqual(["create"]);
    expect(h.writes[0]!.input).toMatchObject({
      profileSlug: "ui-design",
      targetWorkspaceId: DESIGNS,
    });
  });

  it("without the permission: 403 naming it, nothing written", async () => {
    const upd = await send("reader", "POST", "/designs/apply", {
      designId: DESIGN,
      baseUpdatedAt: await base(),
      ops: [addText],
    });
    expect(upd.status).toBe(403);
    expect(String((await body(upd)).error)).toContain(
      "entity.ui-design.update"
    );

    const create = await send("reader", "POST", "/designs/apply", {
      ops: [{ op: "create_design", title: "Settings" }],
    });
    expect(create.status).toBe(403);
    expect(String((await body(create)).error)).toContain(
      "entity.ui-design.create"
    );
    expect(h.writes).toHaveLength(0);
  });

  it("an agent's key with the same grant: its write reaches the entity door as that agent", async () => {
    const res = await send("agent", "POST", "/designs/apply", {
      designId: DESIGN,
      baseUpdatedAt: await base(),
      ops: [addText],
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]!.input.agentUserId).toBe(AGENT);
  });

  it("the batch's answers are 4xx with their body (never a redacted 5xx): stale 409 DESIGN_CHANGED, refused 422 DESIGN_OP_REFUSED; nothing written", async () => {
    const stale = await send("designer", "POST", "/designs/apply", {
      designId: DESIGN,
      baseUpdatedAt: "2020-01-01T00:00:00.000Z",
      ops: [addText],
    });
    expect(stale.status).toBe(409);
    expect(await body(stale)).toMatchObject({
      code: "DESIGN_CHANGED",
      status: "conflict",
      designId: DESIGN,
      updatedAt: await base(),
    });

    const refused = await send("designer", "POST", "/designs/apply", {
      designId: DESIGN,
      baseUpdatedAt: await base(),
      ops: [addText, { ...addText, type: "Nope" }],
    });
    expect(refused.status).toBe(422);
    expect(await body(refused)).toMatchObject({
      code: "DESIGN_OP_REFUSED",
      status: "refused",
      opIndex: 1,
      op: "add_block",
      reasons: [{ kind: "unknown-type", type: "Nope" }],
      catalogHash: "h-1",
    });
    expect(h.writes).toHaveLength(0);
  });
});
