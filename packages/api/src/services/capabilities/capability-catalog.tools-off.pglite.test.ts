/**
 * A capability whose TOOL row is off reads as off on its card
 * (`CapabilityCard.toolsOff`), through the real `buildCapabilityCatalog`.
 *
 * Founder dogfood 2026-10-30: Hetzner Cloud read "6 of 6 tools turned on"
 * while its `hetzner_cloud` tool row was `approved: false` (the CLI's one-shot
 * approve timed out). The run gate refuses on the tool row too
 * (`gateCapabilityExecution`, capabilityKind "tool"), so every run failed
 * "installed but not enabled" with nothing on any screen to turn on.
 *
 * Driven on PGlite with the real member-link and row reads compiled to SQL.
 * Mocked: only the two calls that leave the pod — the connection broker (no
 * Nango on this pod) and the Control Plane template list (none).
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
const HETZNER = randomUUID();
const HETZNER_TOOL = randomUUID();
const EXA = randomUUID();
const EXA_TOOL = randomUUID();

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
async function tool(id: string, name: string, approved: boolean, cap: string) {
  await q(
    `insert into tools (id, workspace_id, created_by, name, kind, approved) values ($1,null,$2,$3,'api',$4)`,
    [id, VIEWER, name, approved]
  );
  await q(
    `insert into links (id, from_type, from_id, to_type, to_id, link_type) values ($1,'tool',$2,'capability',$3,'member_of')`,
    [randomUUID(), id, cap]
  );
}
async function skill(name: string, cap: string) {
  const id = randomUUID();
  await q(
    `insert into skills (id, user_id, scope, kind, name, approved) values ($1,$2,'pod','declarative',$3,true)`,
    [id, VIEWER, name]
  );
  await q(
    `insert into links (id, from_type, from_id, to_type, to_id, link_type) values ($1,'skill',$2,'capability',$3,'member_of')`,
    [randomUUID(), id, cap]
  );
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  // A pod-wide row is visible to a known pod user (`podReaderWhere`).
  await q(`insert into users (id) values ($1)`, [VIEWER]);
  // Every action on in both; only Hetzner's tool row is off.
  await container(HETZNER, "Hetzner Cloud");
  await tool(HETZNER_TOOL, "hetzner_cloud", false, HETZNER);
  await skill("hcloud_create_server", HETZNER);
  await skill("hcloud_list_servers", HETZNER);
  await container(EXA, "Exa");
  await tool(EXA_TOOL, "exa_api", true, EXA);
  await skill("exa_search", EXA);
});

async function cards() {
  const all = await buildCapabilityCatalog({ userId: VIEWER });
  const byId = new Map(all.map((c) => [c.id, c]));
  return { hetzner: byId.get(HETZNER)!, exa: byId.get(EXA)! };
}

describe("a capability whose tool row is off", () => {
  it("names the tool that is off, though every action is on", async () => {
    const { hetzner } = await cards();
    expect(hetzner.verbs.length).toBe(2);
    expect(hetzner.verbs.every((v) => v.enabled)).toBe(true);
    expect(hetzner.toolsOff).toEqual([
      { id: HETZNER_TOOL, name: "hetzner_cloud" },
    ]);
  });

  it("calls no action runnable, and its next step is to turn the tool on", async () => {
    const { hetzner } = await cards();
    expect(hetzner.verbs.some((v) => v.runnable)).toBe(false);
    expect(hetzner.nextAction.kind).toBe("enable");
    expect(hetzner.nextAction.hint).toMatch(/access to the service is off/i);
  });

  it("a capability whose tool is on carries no toolsOff and stays runnable", async () => {
    const { exa } = await cards();
    expect(exa).not.toHaveProperty("toolsOff");
    expect(exa.verbs.every((v) => v.runnable)).toBe(true);
    expect(exa.nextAction.hint).not.toMatch(/access to the service is off/i);
  });
});
