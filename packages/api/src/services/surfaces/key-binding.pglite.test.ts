/**
 * Surface writes judge the calling KEY (security review H3, 27 Nov 2026): a
 * key bound to one space (`keyWorkspaceId`) makes, attaches and takes off
 * surfaces in that space only, whatever its person may do elsewhere.
 *
 * Driven through the REAL tRPC doors (`surfaces.create | attach | detach`)
 * and the REAL Hub route `POST /surfaces/attach`, the real endpoint floor and
 * the real `links` writes, on PGlite. Governance is stubbed with its two
 * outcomes (an agent proposes, a person is allowed), as in
 * `attach.pglite.test.ts`.
 *
 *   W  — Alice owns it, Bob is an editor. Deal E and view V_RADAR live in W.
 *   WB — Bob's alone.
 *
 * Rows, each ruling out a wrong outcome:
 *  - Bob's key bound to WB attaching V_RADAR to E (both in W, which Bob
 *    writes in): FORBIDDEN, no edge, the gate never asked (rules out "the
 *    person's floor is the only check");
 *  - the same key taking an existing attachment off: FORBIDDEN, the edge
 *    stays; making a cell for E: FORBIDDEN, no cell made;
 *  - the Hub route with that binding: 403, no edge (rules out "only the tRPC
 *    door checks");
 *  - Bob's key bound to W: attached (rules out "every bound key is refused");
 *  - an object Bob cannot see, with a bound key: the person's own refusal
 *    (NOT_FOUND), never "another space" (rules out a cross-space existence
 *    probe).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  permCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  const noop = new Proxy(
    {},
    { get: (_t, k) => (k === "then" ? undefined : async () => undefined) }
  );
  return { ...actual, db, getDb: async () => db, eventRepository: noop };
});
vi.mock("../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: vi.fn(async (args: Record<string, unknown>) => {
    h.permCalls.push(args);
    return args.agentUserId
      ? { proposalId: `proposal-${h.permCalls.length}` }
      : { allowed: true };
  }),
  previewPermissionDecision: vi.fn(async () => ({ decision: "allow" })),
  proposedMessageFor: vi.fn(() => "proposed"),
}));
vi.mock("../../utils/domain-mutation.js", () => ({
  recordDomainMutation: vi.fn(async () => undefined),
}));

import { OpenAPIHono } from "@hono/zod-openapi";
import { pgliteAllTablesDdl } from "../../__tests__/pglite-ddl.js";
import { surfacesRouter } from "../../routers/surfaces.js";
import { registerSurfacesRoutes } from "../../routers/hub-protocol/rest/surfaces.js";
import type {
  HubHono,
  HubVariables,
} from "../../routers/hub-protocol/rest/_shared.js";

const ALICE = randomUUID();
const BOB = randomUUID();
const W = randomUUID();
const WB = randomUUID();
const E = randomUUID(); // a deal in W
const HIDDEN = randomUUID(); // a deal in a space Bob is not in
const WH = randomUUID();
const V_RADAR = randomUUID(); // a view in W
const V_ON = randomUUID(); // a view already attached to E

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const caller = (userId: string, keyWorkspaceId?: string) =>
  surfacesRouter.createCaller({
    authenticated: true,
    userId,
    workspaceId: null,
    ...(keyWorkspaceId ? { keyWorkspaceId } : {}),
  } as never);

function hub(path: string, method: string, body: unknown, keyWs?: string) {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("userId", BOB);
    c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
    if (keyWs) c.set("keyWorkspaceId", keyWs);
    await next();
  });
  registerSurfacesRoutes(app);
  return app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const edgesTo = async (viewId: string) =>
  (
    await q<{ id: string }>(
      `select id from links where from_type='entity' and from_id=$1 and to_id=$2 and link_type='attaches'`,
      [E, viewId]
    )
  ).rows.length;

beforeAll(async () => {
  await h.client!.exec(pgliteAllTablesDdl());
  await h.client!.exec(
    `create unique index on links (from_type, from_id, to_type, to_id, link_type)`
  );
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'W',$2,'{}'::jsonb), ($3,'WB',$4,'{}'::jsonb), ($5,'WH',$2,'{}'::jsonb)`,
    [W, ALICE, WB, BOB, WH]
  );
  await q(
    `insert into workspace_members (workspace_id, user_id, role) values ($1,$2,'owner'), ($1,$3,'editor'), ($4,$3,'owner'), ($5,$2,'owner')`,
    [W, ALICE, BOB, WB, WH]
  );
  await q(
    `insert into entities (id, user_id, workspace_id, type, title) values ($1,$2,$3,'deal','Seed round'), ($4,$2,$5,'deal','Hidden')`,
    [E, ALICE, W, HIDDEN, WH]
  );
  for (const [id, name] of [
    [V_RADAR, "Investor radar"],
    [V_ON, "Already on"],
  ] as const) {
    await q(
      `insert into views (id, workspace_id, user_id, name, type, category) values ($1,$2,$3,$4,'table','structured')`,
      [id, W, ALICE, name]
    );
  }
  await q(
    `insert into links (id, from_type, from_id, to_type, to_id, link_type, workspace_id, created_by, metadata)
     values (gen_random_uuid(), 'entity', $1, 'view', $2, 'attaches', $3, $4, '{"position":0}'::jsonb)`,
    [E, V_ON, W, ALICE]
  );
}, 60_000);

beforeEach(() => {
  h.permCalls.length = 0;
});

const anchor = { kind: "entity" as const, id: E };

describe("a key bound to another space", () => {
  it("attach: FORBIDDEN, no edge, the gate never asked", async () => {
    await expect(
      caller(BOB, WB).attach({
        anchor,
        surface: { type: "view", id: V_RADAR },
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await edgesTo(V_RADAR)).toBe(0);
    expect(h.permCalls).toEqual([]);
  });

  it("detach: FORBIDDEN, the edge stays", async () => {
    await expect(
      caller(BOB, WB).detach({ anchor, surface: { type: "view", id: V_ON } })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await edgesTo(V_ON)).toBe(1);
  });

  it("create: FORBIDDEN, no cell made", async () => {
    const before = (
      await q<{ n: number }>(`select count(*)::int as n from cell_instances`)
    ).rows[0]!.n;
    await expect(
      caller(BOB, WB).create({
        anchor,
        body: "cell",
        title: "Next step",
        spec: { cellKey: "entity-header" },
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(
      (await q<{ n: number }>(`select count(*)::int as n from cell_instances`))
        .rows[0]!.n
    ).toBe(before);
  });

  it("the Hub route POST /surfaces/attach: 403, no edge", async () => {
    const res = await hub(
      "/surfaces/attach",
      "POST",
      { anchor, surface: { type: "view", id: V_RADAR } },
      WB
    );
    expect(res.status).toBe(403);
    expect(await edgesTo(V_RADAR)).toBe(0);
  });

  it("an object the person cannot see: the person's own NOT_FOUND, not 'another space'", async () => {
    await expect(
      caller(BOB, WB).attach({
        anchor: { kind: "entity", id: HIDDEN },
        surface: { type: "view", id: V_RADAR },
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("a key bound to the object's own space", () => {
  it("attach: attached", async () => {
    const res = await caller(BOB, W).attach({
      anchor,
      surface: { type: "view", id: V_RADAR },
    });
    expect(res).toMatchObject({ status: "attached" });
    expect(await edgesTo(V_RADAR)).toBe(1);
  });
});
