/**
 * A PROMOTED SESSION'S PLAYBOOK KEEPS WHAT THE SESSION'S WORK HAD (0419, the
 * one tools field). A promoted playbook has no stages, so it is SHORT-class:
 * its floor is 6 reads. Before this, promote wrote no `tools` (only `grants`
 * links), so every run of a promoted playbook could not write.
 *
 * Real: every table from the Drizzle schema on PGlite, `promoteSessionToPlaybook`
 * and the run tool resolver reading the stored row. Stubbed: the conversion
 * receipt, the event log and side effects, and the capability registry.
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
vi.mock("../../focus-sessions/session-conversion.js", () => ({
  recordConversion: vi.fn(async () => ({
    created: { kind: "playbook", id: "x", name: "Promoted" },
    renamedFrom: null,
    renamedTo: "Promoted",
    undoUntil: "2099-01-01T00:00:00.000Z",
  })),
}));
vi.mock("../../../lib/event-helpers.js", () => ({
  logEvent: vi.fn(async () => undefined),
}));
vi.mock("@synap/events", () => ({ emitSideEffects: async () => {} }));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { LONG_RUN_WRITES, SHORT_RUN_FLOOR } from "@synap/playbooks";
import { promoteSessionToPlaybook } from "../playbook-lifecycle.js";
import { defaultDeps, resolveRunToolProfile } from "../run-tool-profile.js";

const OWNER = randomUUID();
const WS = randomUUID();
const ORIGIN = randomUUID();
const TOOL = randomUUID();
const SKILL = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const isArray = t.endsWith("[]");
    const base = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const type = isArray && !base.endsWith("[]") ? `${base}[]` : base;
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : c.name === "version"
          ? " default 1"
          : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  await q(`insert into users (id, email) values ($1, 'o@x.test')`, [OWNER]);
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'Studio',$2,'{}'::jsonb)`,
    [WS, OWNER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), WS, OWNER]
  );
  await q(
    `insert into tools (id, workspace_id, name) values ($1, $2, 'exa_search')`,
    [TOOL, WS]
  );
  await q(
    `insert into skills (id, workspace_id, name) values ($1, $2, 'source-triage')`,
    [SKILL, WS]
  );
  await q(
    `insert into playbooks (id, workspace_id, created_by, name, goal_template, executor, status, tools, stages, params, criteria, expected_outputs, guidance, requires, input_strategy, channel_spec, metadata, version)
     values ($1, $2, $3, 'Research a question', 'Research it', 'is-agent', 'active', '["web_search","search_external"]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{"kind":"none"}'::jsonb, '{}'::jsonb, '{}'::jsonb, 1)`,
    [ORIGIN, WS, OWNER]
  );
}, 120_000);

async function session(playbookId: string | null): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, workspace_id, user_id, goal, status, expected_outputs, criteria, metadata, playbook_id)
     values ($1, $2, $3, 'Research the market for Acme', 'closed', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, $4)`,
    [id, WS, OWNER, playbookId]
  );
  return id;
}

async function used(sessionId: string, kind: string, toId: string) {
  await q(
    `insert into links (id, workspace_id, from_type, from_id, to_type, to_id, link_type, metadata, created_by)
     values (gen_random_uuid(), $1, 'session', $2, $3, $4, 'used', '{}'::jsonb, $5)`,
    [WS, sessionId, kind, toId, OWNER]
  );
}

const deps = {
  ...defaultDeps,
  readRegistry: async () => ({ index: new Map(), capabilities: [] }),
};

describe("promoteSessionToPlaybook writes the one tools list", () => {
  it("declares the core's writes, the origin playbook's tools and the used capabilities by name; a run of it can write", async () => {
    const s = await session(ORIGIN);
    await used(s, "tool", TOOL);
    await used(s, "skill", SKILL);

    const out = await promoteSessionToPlaybook({
      sessionId: s,
      userId: OWNER,
      name: "Research for a client",
    });
    if (out.status !== "promoted") throw new Error(out.status);
    const { rows } = await q(`select tools from playbooks where id = $1`, [
      out.playbook.id,
    ]);
    const tools = (rows[0] as { tools: string[] }).tools;
    expect(tools).toEqual([
      ...LONG_RUN_WRITES,
      "web_search",
      "search_external",
      "exa_search",
      "source-triage",
    ]);

    const run = await resolveRunToolProfile(
      { playbookId: out.playbook.id, workspaceId: WS, userId: OWNER },
      deps
    );
    expect(run.runClass).toBe("short");
    expect(run.tools).toEqual([
      ...SHORT_RUN_FLOOR,
      ...LONG_RUN_WRITES,
      "web_search",
    ]);
    expect(run.tools).toContain("update_document");
    expect(run.tools).toContain("create_entity");
  });

  it("a session that followed no playbook and used nothing still gets the core's writes", async () => {
    const s = await session(null);
    const out = await promoteSessionToPlaybook({
      sessionId: s,
      userId: OWNER,
      name: "Plain work",
    });
    if (out.status !== "promoted") throw new Error(out.status);
    const { rows } = await q(`select tools from playbooks where id = $1`, [
      out.playbook.id,
    ]);
    expect((rows[0] as { tools: string[] }).tools).toEqual([
      ...LONG_RUN_WRITES,
    ]);
  });
});
