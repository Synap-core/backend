/**
 * A playbook may not be SAVED with a goal placeholder no run will fill
 * (founder decision 2026-09-28, space-brief plan item 9) — through the REAL
 * `playbooks.create` / `playbooks.update` procedures on PGlite. Only
 * governance, audit and side effects are stubbed.
 *
 * MEASURED DEFECT (live pod, 2026-09-28): 10 active playbooks carry a bare
 * `{{name}}` in their goal — e.g. AI Dev Session's `Run the dev task
 * "{{task}}"` with `params: []`. The run door substitutes `{name}` only, so
 * the agent is handed the literal braces, and `metadata.params` persists `{}`.
 *
 * Pinned:
 *  - create refuses an undeclared `{name}` and ANY bare `{{name}}`, before
 *    the governance gate and before a row exists, naming the fix;
 *  - a declared `{name}`, a rooted `{{trigger.payload.x}}` and braced prose
 *    are accepted;
 *  - update refuses only what the patch INTRODUCES: a stored row that already
 *    carries `{{task}}` stays editable (description, params, even the goal
 *    itself as long as it adds nothing new).
 *
 * NOT covered: the package installer and the loops door reach the same
 * `create` (so they inherit this), but are not driven here.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  gate: vi.fn(async () => ({ allowed: true })),
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
vi.mock("../utils/permission-check.js", () => ({
  checkPermissionOrPropose: h.gate,
  previewPermissionDecision: vi.fn(async () => ({ decision: "allow" })),
  proposedMessageFor: vi.fn(() => "proposed"),
}));
vi.mock("../utils/audit-log.js", () => ({ auditLog: vi.fn() }));
vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));
vi.mock("@synap/events", () => ({ emitSideEffects: async () => {} }));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { playbooksRouter } from "./playbooks.js";

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
const caller = () =>
  playbooksRouter.createCaller({
    authenticated: true,
    userId: OWNER,
    workspaceId: WS,
    workspaceRole: "owner",
  } as never);

const OWNER = randomUUID();
const WS = randomUUID();
const STORED = randomUUID();

async function playbookCount(): Promise<number> {
  const { rows } = await q(`select count(*)::int as n from playbooks`);
  return (rows[0] as { n: number }).n;
}

async function refusal(p: Promise<unknown>): Promise<string> {
  const err = await p.then(
    () => null,
    (e: unknown) => e as { code?: string; message?: string }
  );
  expect(err, "expected the door to refuse").not.toBeNull();
  expect(err!.code).toBe("BAD_REQUEST");
  return err!.message ?? "";
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
  // The live AI Dev Session shape: `{{task}}` with nothing declared.
  await q(
    `insert into playbooks (id, workspace_id, created_by, name, goal_template, params, input_strategy, channel_spec, expected_outputs, stages, criteria, status, executor, metadata, version)
     values ($1,$2,$3,'AI Dev Session','Run the dev task "{{task}}" as a staged work session','[]'::jsonb,'{"kind":"none"}'::jsonb,'{}'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'active','is-agent','{}'::jsonb,1)`,
    [STORED, WS, OWNER]
  );
});

const create = (goalTemplate: string, params: unknown[] = [], name = "P") =>
  caller().create({
    workspaceId: WS,
    name,
    goalTemplate,
    params,
    executor: "is-agent",
    status: "active",
  } as never);

describe("playbooks.create refuses goal placeholders no run will fill", () => {
  it("a bare {{task}} with nothing declared: refused before the gate, no row, fix named", async () => {
    const before = await playbookCount();
    const msg = await refusal(create('Run the dev task "{{task}}"'));
    expect(msg).toContain("{{task}}");
    expect(msg).toContain('"task"'); // declare it
    expect(msg).toContain("{{task}} → {task}"); // and respell it
    expect(h.gate).not.toHaveBeenCalled();
    expect(await playbookCount()).toBe(before);
  });

  it("an undeclared {lead} is refused; declaring it lets the same goal save", async () => {
    const msg = await refusal(
      create("Qualify {lead} for {segment}", [
        { name: "segment", type: "text" },
      ])
    );
    expect(msg).toContain("{lead}");
    expect(msg).not.toContain("{segment}");

    const ok = (await create(
      "Qualify {lead} for {segment}",
      [
        { name: "lead", type: "text", required: true },
        { name: "segment", type: "text" },
      ],
      "Qualify"
    )) as { status: string };
    expect(ok.status).toBe("created");
  });

  it("a DECLARED param written {{task}} is still refused — only the spelling is wrong", async () => {
    const msg = await refusal(
      create('Run "{{task}}"', [{ name: "task", type: "text" }])
    );
    expect(msg).toContain("{{task}} → {task}");
    expect(msg).not.toContain("Declare");
  });

  it("rooted automation paths and braced prose are not placeholders", async () => {
    const ok = (await create(
      "Summarise {{trigger.payload.title}} (see {the notes} below)",
      [],
      "Summarise"
    )) as { status: string };
    expect(ok.status).toBe("created");
  });
});

describe("playbooks.update refuses only what the patch introduces", () => {
  it("a stored {{task}} row stays editable: description, params, same goal", async () => {
    for (const patch of [
      { description: "tidy" },
      { params: [{ name: "area", type: "text" }] },
      { goalTemplate: 'Run the dev task "{{task}}" — staged, then report' },
    ]) {
      const r = (await caller().update({ id: STORED, ...patch } as never)) as {
        status: string;
      };
      expect(r.status, JSON.stringify(patch)).toBe("updated");
    }
  });

  it("a NEW undeclared placeholder in the patch is refused, naming only it", async () => {
    const msg = await refusal(
      caller().update({
        id: STORED,
        goalTemplate: 'Run the dev task "{{task}}" in {repo}',
      } as never)
    );
    expect(msg).toContain("{repo}");
    expect(msg).not.toContain("{{task}}");
    expect(h.gate).not.toHaveBeenCalled();
  });

  it("dropping the declaration a goal relies on is refused", async () => {
    await q(
      `update playbooks set goal_template = 'Review {area}', params = '[{"name":"area","type":"text"}]'::jsonb where id = $1`,
      [STORED]
    );
    const msg = await refusal(
      caller().update({ id: STORED, params: [] } as never)
    );
    expect(msg).toContain("{area}");
  });
});
