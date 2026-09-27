/**
 * Public projection × SHARED roles on a real Postgres (PGlite), through the
 * REAL route and query (FX-B1, RV2 S3).
 *
 * A shared role's facet is stored pod-wide (NULL), so the old keystone
 * `entity_facets.workspace_id = W` could never match it: a workspace that
 * opted into `roles: [partner]` returned nothing, silently.
 *
 * Pinned:
 *  - a pod-wide `partner` facet on an entity STAMPED in W, with `partner`
 *    shared to W ⇒ published;
 *  - the same facet on a POD-WIDE entity ⇒ NOT published (no stored fact says
 *    W published it — the pod's private CRM stays off the public page);
 *  - the role shared to ANOTHER workspace but not W ⇒ NOT published;
 *  - a lensed facet in W keeps working; a lensed facet in another workspace
 *    stays out.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

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

import { OpenAPIHono } from "@hono/zod-openapi";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { registerPublicProjectionRoutes } from "./public-projection.js";

const A = randomUUID();
const SITE = randomUUID(); // publishes `partner`
const CRM = randomUUID();
const PARTNER = randomUUID(); // shared, granted to SITE
const INVESTOR = randomUUID(); // shared to CRM, NOT to SITE
const LOCAL = randomUUID(); // workspace role owned by SITE

const E_STAMPED = randomUUID(); // stamped SITE + pod-wide partner facet
const E_PODWIDE = randomUUID(); // pod-wide + pod-wide partner facet
const E_INVESTOR = randomUUID(); // stamped SITE + pod-wide investor facet
const E_LENSED = randomUUID(); // pod-wide + lensed SITE local facet
const E_OTHER = randomUUID(); // pod-wide + lensed CRM local facet

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
        : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

let app: OpenAPIHono;

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  const settings = JSON.stringify({
    publicProjection: {
      enabled: true,
      roles: ["partner", "investor", "site-local"],
      fields: ["tier"],
    },
  });
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'Site',$2,$3::jsonb),($4,'CRM',$2,'{}'::jsonb)`,
    [SITE, A, settings, CRM]
  );
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, workspace_id) values
      ($1,'partner','Partner','role','shared',null),
      ($2,'investor','Investor','role','shared',null),
      ($3,'site-local','Local','role','workspace',null)`,
    [PARTNER, INVESTOR, LOCAL]
  );
  await q(
    // investor is shared — but to CRM, not to the publishing workspace.
    `insert into profile_workspace_access (profile_id, workspace_id) values ($1,$2),($3,$4)`,
    [PARTNER, SITE, INVESTOR, CRM]
  );
  for (const [id, ws, title] of [
    [E_STAMPED, SITE, "Stamped partner"],
    [E_PODWIDE, null, "Private partner"],
    [E_INVESTOR, SITE, "Ungranted investor"],
    [E_LENSED, null, "Lensed local"],
    [E_OTHER, null, "Other lens"],
  ] as const) {
    await q(
      `insert into entities (id, user_id, workspace_id, title, properties) values ($1,$2,$3,$4,'{}'::jsonb)`,
      [id, A, ws, title]
    );
  }
  for (const [entity, profile, ws] of [
    [E_STAMPED, PARTNER, null],
    [E_PODWIDE, PARTNER, null],
    [E_INVESTOR, INVESTOR, null],
    [E_LENSED, LOCAL, SITE],
    [E_OTHER, LOCAL, CRM],
  ] as const) {
    await q(
      `insert into entity_facets (id, entity_id, profile_id, user_id, workspace_id, properties) values ($1,$2,$3,$4,$5,'{"tier":"gold"}'::jsonb)`,
      [randomUUID(), entity, profile, A, ws]
    );
  }
  app = new OpenAPIHono();
  registerPublicProjectionRoutes(app as never);
}, 120_000);

describe("public projection — shared roles", () => {
  it("publishes exactly the W-stamped shared-role records and W-lensed facets", async () => {
    const res = await app.request(`/public/projection?workspace=${SITE}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(new Set(body.items.map((i) => i.id))).toEqual(
      new Set([E_STAMPED, E_LENSED])
    );
  });
});
