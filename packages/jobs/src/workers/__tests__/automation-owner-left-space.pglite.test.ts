/**
 * Audit F9 (2026-10-28): offboarding offboards. A space automation runs FOR a
 * person; once that person is no longer a member of the space, its reads and
 * outbound steps (which never consult the owner's role) must stop.
 *
 * Proved through the REAL `handleAutomationExecute` on PGlite, and the real
 * `pauseAutomationsOfRemovedMember` the member-removal door calls:
 *   1. a run whose owner left the space is refused before any step runs, the
 *      run reads `blocked_by_policy` with the reason, the automation is paused;
 *   2. an agent-owned automation stops when the agent's PERSON left;
 *   3. CONTROL: a member's automation runs its step;
 *   4. removal pauses exactly the removed person's (and their agents')
 *      active automations in that space.
 *
 * Stubbed (seams with their own suites): the IS command transport, session
 * open/close, narration.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  commandCalls: 0,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return {
    ...actual,
    db: drizzle(client, {
      schema: {
        automations: actual.automations as never,
        automationRuns: actual.automationRuns as never,
      },
    }),
    openRunSession: async () => ({ sessionId: randomUUID(), reused: false }),
  };
});
vi.mock("../../utils/post-run-summary.js", () => ({
  postRunSummary: async () => undefined,
  resolveRunChannel: async () => null,
}));
vi.mock("../../utils/session-close.js", () => ({
  closeSessionViaDoor: async () => null,
}));
vi.mock("../steps/command-skill-capability.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    executeCommandStep: async () => {
      h.commandCalls += 1;
      return { ok: true };
    },
  };
});

import { is, SQL } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import {
  db,
  pauseAutomationsOfRemovedMember,
  AUTOMATION_OWNER_LEFT_SPACE,
} from "@synap/database";
import { handleAutomationExecute } from "../automation-executor.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function sqlDefault(d: unknown): string {
  if (is(d, SQL)) {
    return (d as SQL).queryChunks
      .map((c) => {
        const v = (c as { value?: unknown }).value;
        return Array.isArray(v) ? v.join("") : "";
      })
      .join("");
  }
  if (typeof d === "string") return `'${d.replace(/'/g, "''")}'`;
  if (typeof d === "number" || typeof d === "boolean") return String(d);
  if (d && typeof d === "object") return `'${JSON.stringify(d)}'::jsonb`;
  return "";
}

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = t.endsWith("[]")
      ? t
      : BASIC.test(t)
        ? t.replace(/\(.*\)/, "")
        : "text";
    const def =
      !c.hasDefault ||
      (c.default !== null &&
        typeof c.default === "object" &&
        !is(c.default, SQL) &&
        !/^json/.test(type))
        ? ""
        : sqlDefault(c.default);
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def ? ` default ${def}` : ""}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const WS = "22222222-2222-4222-8222-222222222222";
const MEMBER = "33333333-3333-4333-8333-333333333333";
const LEFT = "44444444-4444-4444-8444-444444444444";
const LEFT_AGENT = "55555555-5555-4555-8555-555555555555";

const SINGLE_COMMAND = {
  nodes: [
    { id: "t", type: "trigger", data: {} },
    { id: "cmd", type: "command", data: { label: "c", commandId: "x" } },
  ],
  edges: [{ id: "e1", source: "t", target: "cmd" }],
};

async function automation(owner: string): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into automations (id, workspace_id, created_by, name, trigger_type, trigger_config, flow_definition, status, success_count, failure_count, run_count, version)
     values ($1, $2, $3, $4, 'cron', '{}'::jsonb, $5::jsonb, 'active', 0, 0, 0, 1)`,
    [id, WS, owner, `rule-${id}`, JSON.stringify(SINGLE_COMMAND)]
  );
  return id;
}

async function run(automationId: string): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into automation_runs (id, automation_id, workspace_id, triggered_by, trigger_payload, status, ai_dispatch_count, started_at)
     values ($1, $2, $3, 'system', '{}'::jsonb, 'running', 0, now())`,
    [id, automationId, WS]
  );
  return id;
}

const execute = (automationId: string, runId: string) =>
  handleAutomationExecute({
    data: {
      runId,
      automationId,
      workspaceId: WS,
      automationContext: {
        automationRunId: runId,
        automationId,
        chainDepth: 0,
      },
    } as never,
  });

const runRow = async (id: string) =>
  (
    await q<{ status: string; error_message: string | null }>(
      "select status, error_message from automation_runs where id = $1",
      [id]
    )
  ).rows[0]!;

const automationRow = async (id: string) =>
  (
    await q<{ status: string; error_message: string | null }>(
      "select status, error_message from automations where id = $1",
      [id]
    )
  ).rows[0]!;

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value as PgTable));
  }
}, 120_000);

beforeEach(async () => {
  h.commandCalls = 0;
  await h.client!.exec(
    "delete from automations; delete from automation_runs; delete from automation_step_runs; delete from users; delete from workspace_members;"
  );
  await q(
    `insert into users (id, email, user_type) values ($1, 'm@x.test', 'human'), ($2, 'l@x.test', 'human')`,
    [MEMBER, LEFT]
  );
  await q(
    `insert into users (id, email, user_type, created_by_user_id) values ($1, 'a@x.test', 'agent', $2)`,
    [LEFT_AGENT, LEFT]
  );
  // MEMBER is in the space; LEFT was removed from it (no row).
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'editor')`,
    [randomUUID(), WS, MEMBER]
  );
});

describe("a run whose person left the space is refused (audit F9)", () => {
  it("the removed owner's automation runs no step; the run is blocked and the automation paused", async () => {
    const a = await automation(LEFT);
    const r = await run(a);

    await execute(a, r);

    expect(h.commandCalls).toBe(0);
    expect(await runRow(r)).toMatchObject({
      status: "blocked_by_policy",
      error_message: AUTOMATION_OWNER_LEFT_SPACE,
    });
    expect(await automationRow(a)).toMatchObject({
      status: "paused",
      error_message: AUTOMATION_OWNER_LEFT_SPACE,
    });
  });

  it("an agent-owned automation stops when the agent's person left", async () => {
    const a = await automation(LEFT_AGENT);
    const r = await run(a);

    await execute(a, r);

    expect(h.commandCalls).toBe(0);
    expect((await runRow(r)).status).toBe("blocked_by_policy");
  });

  it("CONTROL: a member's automation runs its step", async () => {
    const a = await automation(MEMBER);
    const r = await run(a);

    await execute(a, r);

    expect(h.commandCalls).toBe(1);
    expect((await runRow(r)).status).not.toBe("blocked_by_policy");
    expect((await automationRow(a)).status).toBe("active");
  });
});

describe("removing a member pauses what runs for them in that space", () => {
  it("pauses the person's and their agents' active automations, and nobody else's", async () => {
    const own = await automation(LEFT);
    const agents = await automation(LEFT_AGENT);
    const others = await automation(MEMBER);

    const paused = await pauseAutomationsOfRemovedMember(db, {
      workspaceId: WS,
      userId: LEFT,
    });

    expect(paused).toBe(2);
    expect((await automationRow(own)).status).toBe("paused");
    expect((await automationRow(agents)).status).toBe("paused");
    expect((await automationRow(others)).status).toBe("active");
  });
});
