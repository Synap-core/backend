/**
 * `synap_update_playbook` — an agent edits an EXISTING playbook over MCP
 * (task dc03b536: a fixing agent had to fall back to Hub REST
 * `PATCH /playbooks/:id`, because MCP could create a playbook but not edit one).
 *
 * SEAM: the REAL MCP handler → the REAL `updatePlaybookDoor` → the REAL
 * `playbooks.update` on PGlite (input schema, shared definition check,
 * governance call). Only the gate is a recorder that files a proposal, plus
 * audit/side effects.
 *
 * Pinned:
 *  - a patch reaches the gate as `playbook/update` carrying the patch, and an
 *    agent call comes back `proposed` with a reviewUrl; the row is unchanged;
 *  - a goal placeholder the patch introduces without declaring it is refused
 *    BEFORE the gate (the same check create/update/revise share);
 *  - a malformed stage is refused by `updateInputSchema`, never dropped;
 *  - no playbookId / nothing to change is an explicit error, not a no-op.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  gate: vi.fn(async (_opts: Record<string, unknown>) => ({
    granted: false,
    proposalId: "prop-1",
    proposalType: "playbook.update",
  })),
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
  return {
    ...actual,
    db,
    getDb: async () => db,
    eventRepository: {
      append: async () => undefined,
      emitCompleted: async () => undefined,
    },
  };
});
vi.mock("../../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: h.gate,
  previewPermissionDecision: vi.fn(async () => ({ decision: "allow" })),
}));
vi.mock("../../../utils/audit-log.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  auditLog: vi.fn(),
}));
vi.mock("../../../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: async () => {},
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { buildHandlers } from "./build.js";
import type { McpToolContext } from "./shared.js";

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

const OWNER = randomUUID();
const AGENT = randomUUID();
const WS = randomUUID();
const STORED = randomUUID();
const GOAL = "Estimate {client} work";

function ctx(args: Record<string, unknown>): McpToolContext {
  return {
    toolName: "synap_update_playbook",
    args,
    userId: OWNER,
    apiKeyScopes: ["mcp.read", "mcp.write"],
    agentUserId: AGENT,
  } as unknown as McpToolContext;
}

const update = (args: Record<string, unknown>) =>
  buildHandlers.synap_update_playbook!(ctx(args));

function payload(result: unknown): Record<string, unknown> {
  const r = result as { content: Array<{ text?: string }> };
  return JSON.parse(r.content[0]!.text!);
}

async function stored() {
  const { rows } = await q(
    `select goal_template, description, stages from playbooks where id = $1`,
    [STORED]
  );
  return rows[0] as {
    goal_template: string;
    description: string | null;
    stages: unknown;
  };
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  await q(`insert into users (id, email) values ($1, 'o@x.test')`, [OWNER]);
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'Builder',$2,'{}'::jsonb)`,
    [WS, OWNER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), WS, OWNER]
  );
}, 120_000);

beforeEach(async () => {
  h.gate.mockClear();
  await h.client!.exec(`delete from playbooks;`);
  await q(
    `insert into playbooks (id, workspace_id, created_by, name, description, goal_template, params, input_strategy, channel_spec, expected_outputs, stages, criteria, status, executor, metadata, version)
     values ($1,$2,$3,'Prepare a pre-sale estimate','old',$4,'[{"name":"client","type":"text"}]'::jsonb,'{"kind":"none"}'::jsonb,'{}'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'active','is-agent','{}'::jsonb,1)`,
    [STORED, WS, OWNER, GOAL]
  );
});

describe("synap_update_playbook → the governed playbooks.update", () => {
  it("files the patch as a playbook/update proposal and changes nothing yet", async () => {
    const stages = [{ key: "scope", name: "Scope", category: "started" }];
    const out = payload(
      await update({
        playbookId: STORED,
        description: "Free estimate, two days",
        stages,
        reasoning: "The founder asked for a scoping stage",
      })
    );
    expect(out).toMatchObject({ status: "proposed", proposalId: "prop-1" });
    expect(String(out.reviewUrl)).toContain("prop-1");
    expect(h.gate).toHaveBeenCalledTimes(1);
    expect(h.gate.mock.calls[0]![0]).toMatchObject({
      subjectType: "playbook",
      action: "update",
      agentUserId: AGENT,
      reasoning: "The founder asked for a scoping stage",
      data: {
        id: STORED,
        description: "Free estimate, two days",
        stages: [
          expect.objectContaining({ key: "scope", category: "started" }),
        ],
      },
    });
    expect(await stored()).toMatchObject({ description: "old", stages: [] });
  });

  it("refuses an undeclared goal placeholder before the gate", async () => {
    await expect(
      update({
        playbookId: STORED,
        goalTemplate: "Estimate {client} in {market}",
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("{market}"),
    });
    expect(h.gate).not.toHaveBeenCalled();
    expect((await stored()).goal_template).toBe(GOAL);
  });

  it("refuses a stage with no category (the update schema), never drops it", async () => {
    await expect(
      update({ playbookId: STORED, stages: [{ key: "scope", name: "Scope" }] })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(h.gate).not.toHaveBeenCalled();
  });

  it("says what is missing instead of doing nothing", async () => {
    expect(payload(await update({ description: "x" }))).toMatchObject({
      error: expect.stringContaining("playbookId is required"),
    });
    expect(payload(await update({ playbookId: STORED }))).toMatchObject({
      error: expect.stringContaining("Nothing to change"),
    });
    expect(h.gate).not.toHaveBeenCalled();
  });
});
