/**
 * The add-on reads, through the doors pod admin calls (founder decision D6):
 *   - `capabilities.containers.get` on a BASE returns its add-ons by name,
 *     and on an ADD-ON returns the base it extends;
 *   - `listCapabilityCompositions` (`capabilities.compositions`) marks each
 *     add-on row with its base, in one read;
 *   - both stay under the reader's floor: an add-on in a space the reader is
 *     not a member of is not listed, and a tool that is not an add-on reads
 *     `extends: null`.
 *
 * PGlite tables from the Drizzle schema; the real router and the real
 * composition builder (its run-health read stubbed: no runs here).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return { ...actual, db, getDb: async () => db };
});
vi.mock("../runs/index.js", () => ({ listRuns: vi.fn(async () => []) }));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { capabilityContainersRouter } from "../../routers/capability-containers.js";
import { listCapabilityCompositions } from "../diagnose/capability-composition.js";

const VIEWER = randomUUID();
const OTHER = randomUUID();
const WS_MINE = randomUUID();
const WS_OTHER = randomUUID();
const APIFY = randomUUID();
const SOCIAL = randomUUID();
const LINKEDIN = randomUUID();
const HIDDEN = randomUUID();
const PLAIN = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : c.name === "metadata"
          ? " default '{}'"
          : c.name === "approved"
            ? " default false"
            : "";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

async function container(
  id: string,
  name: string,
  workspaceId: string | null,
  description: string | null = null
) {
  await q(
    `insert into capabilities (id, workspace_id, created_by, name, description, approved) values ($1,$2,$3,$4,$5,true)`,
    [id, workspaceId, VIEWER, name, description]
  );
}
async function extendsEdge(addOn: string, base: string, ws: string | null) {
  await q(
    `insert into links (id, workspace_id, from_type, from_id, to_type, to_id, link_type) values ($1,$2,'capability',$3,'capability',$4,'extends')`,
    [randomUUID(), ws, addOn, base]
  );
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  await q(`insert into users (id) values ($1), ($2)`, [VIEWER, OTHER]);
  await q(
    `insert into workspaces (id, name) values ($1,'Mine'), ($2,'Theirs')`,
    [WS_MINE, WS_OTHER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner'), ($4,$5,$6,'owner')`,
    [randomUUID(), WS_MINE, VIEWER, randomUUID(), WS_OTHER, OTHER]
  );
  await container(APIFY, "Apify", null);
  await container(SOCIAL, "Social post capture", null, "Read one public post");
  await container(LINKEDIN, "LinkedIn profiles", WS_MINE);
  await container(HIDDEN, "Their add-on", WS_OTHER);
  await container(PLAIN, "Plain", null);
  await extendsEdge(SOCIAL, APIFY, null);
  await extendsEdge(LINKEDIN, APIFY, WS_MINE);
  await extendsEdge(HIDDEN, APIFY, WS_OTHER);
}, 120_000);

const get = (id: string) =>
  capabilityContainersRouter
    .createCaller({ userId: VIEWER, authenticated: true } as never)
    .get({ id });

describe("capabilities.containers.get", () => {
  it("on a base: its add-ons the reader can see, by name", async () => {
    const out = await get(APIFY);
    expect(out.extends).toBeNull();
    expect(out.addOns).toEqual([
      {
        id: LINKEDIN,
        name: "LinkedIn profiles",
        description: null,
        workspaceId: WS_MINE,
      },
      {
        id: SOCIAL,
        name: "Social post capture",
        description: "Read one public post",
        workspaceId: null,
      },
    ]);
  });

  it("on an add-on: the base it extends, and no add-ons of its own", async () => {
    const out = await get(SOCIAL);
    expect(out.extends).toMatchObject({ id: APIFY, name: "Apify" });
    expect(out.addOns).toEqual([]);
  });

  it("on a tool that is not an add-on: neither", async () => {
    const out = await get(PLAIN);
    expect(out.extends).toBeNull();
    expect(out.addOns).toEqual([]);
  });
});

describe("capabilities.compositions", () => {
  it("marks each add-on row with its base, and only those", async () => {
    const rows = await listCapabilityCompositions({ userId: VIEWER });
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(SOCIAL)?.extends).toEqual({ id: APIFY, name: "Apify" });
    expect(byId.get(LINKEDIN)?.extends).toEqual({ id: APIFY, name: "Apify" });
    expect(byId.get(APIFY)?.extends).toBeNull();
    expect(byId.get(PLAIN)?.extends).toBeNull();
    // Not the reader's: not listed at all.
    expect(byId.has(HIDDEN)).toBe(false);
  });
});
