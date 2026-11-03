/**
 * HUB RESPONSE DRIFT (hub schema drift finder, R0).
 *
 * `registerOpenApi` / `createRoute` document a route's 2xx body with a zod
 * schema, but nothing checks the handler's body against it: a handler can drop
 * or add a field while the spec still looks right (`/work-release` lost
 * `pullRequests`, backend#656; entities dropped `status`, backend#667).
 *
 * This ONE tripwire serves real Hub REST reads (the real route modules, rows in
 * PGlite, no hand-written bodies) through `installHubResponseCheck`, which
 * records every 2xx JSON body its registered schema does not describe
 * (missing / mistyped fields, and keys zod would strip). The recorded set must
 * equal the shrink-only baseline: a new drift fails here, and a fixed one must
 * be deleted from it. The check is installed on THIS file's app only (no vitest
 * setup file), so no other test can go red on it.
 *
 * `HUB_DRIFT_DUMP=1` prints every fixture's status and verdict.
 */

import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
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

import { OpenAPIHono, z } from "@hono/zod-openapi";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { runWithGrant } from "@synap/database";
import { registerEntitiesRoutes } from "../entities.js";
import { registerFocusSessionsRoutes } from "../focus-sessions.js";
import type { HubHono, HubVariables } from "../_shared.js";
import { registerOpenApi } from "../_codecs/_register.js";
import {
  buildMatchers,
  checkBody,
  installHubResponseCheck,
  matchRoute,
  unknownKeys,
  type DriftVerdict,
} from "../_test-support/hub-response-check.js";
import { HUB_RESPONSE_DRIFT_BASELINE } from "../_test-support/hub-response-drift.baseline.js";

/** Today's size; lower it when an entry is deleted, never raise it. */
const BASELINE_CEILING = 2;

// ── the checker itself (pure, no database) ──────────────────────────────────

const Item = z.object({ id: z.string(), status: z.string() });

function probeApp(body: unknown, sink: DriftVerdict[]) {
  const app = new OpenAPIHono();
  registerOpenApi(app as never, {
    method: "get",
    path: "/things/:id",
    responses: { 200: { description: "ok", schema: Item } },
  });
  app.get("/things/:id", (c) => c.json(body as never));
  installHubResponseCheck(app as never, sink);
  return app;
}

describe("hub response check", () => {
  it("records a body its schema does not describe, and leaves the response alone", async () => {
    const sink: DriftVerdict[] = [];
    const res = await probeApp({ id: "a" }, sink).request("/things/1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "a" });
    expect(sink).toHaveLength(1);
    expect(sink[0]).toMatchObject({ key: "GET /things/{id}", status: 200 });
    expect(sink[0]!.issues.join("\n")).toMatch(/status/);
  });

  it("sees keys zod strips: an undeclared field is drift", async () => {
    const sink: DriftVerdict[] = [];
    await probeApp({ id: "a", status: "open", pullRequests: [] }, sink).request(
      "/things/1"
    );
    expect(sink.map((v) => v.issues.join("\n")).join("\n")).toMatch(
      /pullRequests: not declared/
    );
  });

  it("records nothing for a body that matches", async () => {
    const sink: DriftVerdict[] = [];
    const res = await probeApp({ id: "a", status: "open" }, sink).request(
      "/things/1"
    );
    expect(res.status).toBe(200);
    expect(sink).toEqual([]);
  });

  it("checkBody names route and issues; a static route beats a param route", () => {
    const app = new OpenAPIHono();
    const route = (path: string, s: z.ZodType) =>
      registerOpenApi(app as never, {
        method: "get",
        path,
        responses: { 200: { description: "ok", schema: s } },
      });
    route("/sessions/:id", z.object({ kind: z.literal("one") }));
    route("/sessions/active", z.object({ kind: z.literal("active") }));
    const matchers = buildMatchers(app.openAPIRegistry.definitions as never);
    expect(matchRoute(matchers, "get", "/sessions/active")?.path).toBe(
      "/sessions/active"
    );
    expect(matchRoute(matchers, "get", "/sessions/42")?.path).toBe(
      "/sessions/{id}"
    );
    expect(
      checkBody(matchers, "get", "/sessions/42", 200, { kind: "one" })
    ).toBe("ok");
    expect(checkBody(matchers, "get", "/sessions/42", 404, {})).toBe("skipped");
    expect(
      checkBody(matchers, "get", "/sessions/active", 200, { kind: "one" })
    ).toMatchObject({ key: "GET /sessions/active", status: 200 });
    expect(unknownKeys({ a: 1, b: { c: 2 } }, { a: 1, b: {} })).toEqual([
      "b.c",
    ]);
    expect(unknownKeys([{ a: 1 }], [{ a: 1 }])).toEqual([]);
  });
});

// ── real routes on PGlite ───────────────────────────────────────────────────

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
const WS = randomUUID();
const PROFILE = randomUUID();
const DEAL = randomUUID();
const PLAIN = randomUUID();
const SESSION = randomUUID();

/** A key pinned to WS that reads sessions and deals (a pod app). */
const APP_GRANT = {
  scopes: [
    { permissions: ["session.read", "entity.deal.read"], workspaceIds: [WS] },
  ],
  clientId: null,
};

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  await q(`insert into users (id, email) values ($1, $2)`, [
    OWNER,
    "owner@example.test",
  ]);
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,$2,$3,'{}'::jsonb)`,
    [WS, "ws", OWNER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), WS, OWNER]
  );
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, is_active, ui_hints, workspace_id)
     values ($1,'deal','Deal','kind','system','workspace',true,'{}'::jsonb,null)`,
    [PROFILE]
  );
  for (const [id, title, status, cat] of [
    [DEAL, "in-talks", "negotiation", "active"],
    [PLAIN, "no-lifecycle", null, null],
  ] as const) {
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, system_data, status, status_category)
       values ($1,$2,$3,$4,'deal',$5,'{}'::jsonb,'{}'::jsonb,$6,$7)`,
      [id, OWNER, WS, PROFILE, title, status, cat]
    );
  }
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, title, status, started_at, metadata)
     values ($1,$2,$3,'Build a prospect list','active',now(),'{"stage":{"index":1,"of":4}}'::jsonb)`,
    [SESSION, OWNER, WS]
  );
}, 120_000);

const sink: DriftVerdict[] = [];

function hubApp(): HubHono {
  const a: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  a.use("/*", async (c, next) => {
    c.set("userId", OWNER);
    c.set("scopes", ["hub-protocol.read"]);
    c.set("apiKeyId", "key-owner");
    await next();
  });
  registerEntitiesRoutes(a);
  registerFocusSessionsRoutes(a);
  installHubResponseCheck(a as never, sink);
  return a;
}

/** Each fixture: one real read, as the person or as a pinned app. */
const FIXTURES: Array<{ path: () => string; grant?: unknown }> = [
  { path: () => `/entities?workspaceId=${WS}&profileSlug=deal&limit=10` },
  { path: () => `/entities/${DEAL}` },
  { path: () => `/entities/${PLAIN}` },
  { path: () => `/entities/${DEAL}/facets` },
  { path: () => `/entities/${DEAL}/connections` },
  { path: () => `/focus-sessions?workspaceId=${WS}` },
  { path: () => `/focus-sessions/${SESSION}`, grant: APP_GRANT },
];

describe("hub response drift on real routes", () => {
  it("every fixture answers 2xx JSON (non-vacuous)", async () => {
    const app = hubApp();
    const statuses: string[] = [];
    for (const f of FIXTURES) {
      const send = () => app.request(f.path());
      const res = await (f.grant
        ? runWithGrant(f.grant as never, send)
        : send());
      const text = await res.text();
      statuses.push(`${res.status} ${f.path()}`);
      expect(res.status, `${f.path()} -> ${text.slice(0, 300)}`).toBeLessThan(
        300
      );
      expect(res.headers.get("content-type") ?? "").toContain("json");
    }
    if (process.env.HUB_DRIFT_DUMP)
      console.log(
        `HUB_DRIFT_DUMP ${JSON.stringify({ statuses, drift: sink }, null, 2)}`
      );
  });

  it("the drift found equals the shrink-only baseline", () => {
    const found = [...new Set(sink.map((v) => v.key))].sort();
    const baseline = new Set(HUB_RESPONSE_DRIFT_BASELINE);
    const fresh = sink.filter((v) => !baseline.has(v.key));
    expect(
      fresh.map((v) => `${v.key} ${v.status}:\n  ${v.issues.join("\n  ")}`),
      "a 2xx body its registered schema does not describe: fix the schema or the handler (hub-openapi.json is what clients read)"
    ).toEqual([]);
    expect(
      [...baseline].filter((k) => !found.includes(k)),
      "now matches its schema: delete it from HUB_RESPONSE_DRIFT_BASELINE and lower BASELINE_CEILING"
    ).toEqual([]);
  });

  it("the baseline only shrinks", () => {
    expect(HUB_RESPONSE_DRIFT_BASELINE.length).toBeLessThanOrEqual(
      BASELINE_CEILING
    );
    expect(new Set(HUB_RESPONSE_DRIFT_BASELINE).size).toBe(
      HUB_RESPONSE_DRIFT_BASELINE.length
    );
  });
});
