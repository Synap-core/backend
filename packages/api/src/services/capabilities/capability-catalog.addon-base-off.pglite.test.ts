/**
 * An ADD-ON's card reads its BASE's access (founder decision D6: "if the base
 * is off, the add-on cannot run").
 *
 * An add-on owns no tool row: its actions run through its base's tool rows
 * (`capability --extends--> capability`). The run itself is refused at the
 * provider call (`external-dispatch.verb-act-tool-off.test.ts`); this pins
 * what every screen reads, through the real `buildCapabilityCatalog`: with
 * the base's tool row off, the add-on's card names that tool in `toolsOff`
 * and calls none of its actions runnable, though each action is on. Without
 * the base fallback the add-on had no tools at all and read "On".
 *
 * Driven on PGlite with the real member-link and row reads compiled to SQL.
 * Mocked: only the two calls that leave the pod, as in
 * `capability-catalog.tools-off.pglite.test.ts`.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
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
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return { ...actual, db: drizzle(client) };
});

vi.mock("../../connectors/index.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveBroker: vi.fn(async () => ({
    ok: false,
    reason: "not-configured",
    error: "no broker",
  })),
}));

vi.mock("./cp-template-client.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchCPCapabilityTemplates: vi.fn(async () => []),
  fetchCPCapabilityTemplateByKey: vi.fn(async () => null),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { buildCapabilityCatalog } from "./capability-catalog.js";

const VIEWER = "viewer-1";
const APIFY = randomUUID();
const APIFY_TOOL = randomUUID();
const LINKEDIN = randomUUID();
const PLAIN = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

async function container(id: string, name: string) {
  await q(
    `insert into capabilities (id, workspace_id, created_by, name, approved) values ($1,null,$2,$3,true)`,
    [id, VIEWER, name]
  );
}
async function link(
  fromType: string,
  fromId: string,
  toId: string,
  type: string
) {
  await q(
    `insert into links (id, from_type, from_id, to_type, to_id, link_type) values ($1,$2,$3,'capability',$4,$5)`,
    [randomUUID(), fromType, fromId, toId, type]
  );
}
async function skill(name: string, cap: string) {
  const id = randomUUID();
  await q(
    `insert into skills (id, user_id, scope, kind, name, approved) values ($1,$2,'pod','code',$3,true)`,
    [id, VIEWER, name]
  );
  await link("skill", id, cap, "member_of");
}
const setBaseAccess = (on: boolean) =>
  q(`update tools set approved = $1 where id = $2`, [on, APIFY_TOOL]);

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  await q(`insert into users (id) values ($1)`, [VIEWER]);
  // The base: Apify, its access tool row, one action of its own.
  await container(APIFY, "Apify");
  await q(
    `insert into tools (id, workspace_id, created_by, name, kind, approved) values ($1,null,$2,'apify_api','api',true)`,
    [APIFY_TOOL, VIEWER]
  );
  await link("tool", APIFY_TOOL, APIFY, "member_of");
  await skill("apify_search_actors", APIFY);
  // The add-on: its own container and action, no tool, extends Apify.
  await container(LINKEDIN, "LinkedIn profiles");
  await skill("apify_linkedin_profile", LINKEDIN);
  await link("capability", LINKEDIN, APIFY, "extends");
  // A plain capability with no tool and no base: unchanged by any of this.
  await container(PLAIN, "Plain");
  await skill("plain_action", PLAIN);
});

async function cards() {
  const all = await buildCapabilityCatalog({ userId: VIEWER });
  const byId = new Map(all.map((c) => [c.id, c]));
  return {
    base: byId.get(APIFY)!,
    addOn: byId.get(LINKEDIN)!,
    plain: byId.get(PLAIN)!,
  };
}

describe("an add-on whose base's access is OFF", () => {
  it("names the base's tool as off and calls none of its actions runnable", async () => {
    await setBaseAccess(false);
    const { addOn, base } = await cards();
    expect(addOn.verbs.map((v) => v.verbId)).toEqual([
      "apify_linkedin_profile",
    ]);
    expect(addOn.verbs.every((v) => v.enabled)).toBe(true);
    expect(addOn.toolsOff).toEqual([{ id: APIFY_TOOL, name: "apify_api" }]);
    expect(addOn.verbs.some((v) => v.runnable)).toBe(false);
    // The base says the same about itself.
    expect(base.toolsOff).toEqual([{ id: APIFY_TOOL, name: "apify_api" }]);
  });

  it("does not list the base's own actions on the add-on", async () => {
    const { addOn } = await cards();
    expect(addOn.verbs.map((v) => v.verbId)).not.toContain(
      "apify_search_actors"
    );
  });
});

describe("an add-on whose base's access is ON", () => {
  it("carries no toolsOff and its actions are runnable", async () => {
    await setBaseAccess(true);
    const { addOn } = await cards();
    expect(addOn).not.toHaveProperty("toolsOff");
    expect(addOn.verbs.every((v) => v.runnable)).toBe(true);
  });

  it("a capability that is not an add-on is unchanged", async () => {
    await setBaseAccess(false);
    const { plain } = await cards();
    expect(plain).not.toHaveProperty("toolsOff");
  });
});
