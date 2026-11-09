/**
 * A RULE'S `playbook_run` HAND-OFF AND AWAIT ARE CHECKED WHEN IT IS WRITTEN
 * (runner engine slice 5, spec 7111934d §4). Before, an unknown, paused or
 * foreign agent, or a hand-off beside a proposal, was refused only when the
 * rule fired (`steps/playbook-run.ts`), long after its author left.
 *
 * Driven through the real resolver loader (`loadFlowValidationResolvers`, the
 * one the create and update doors call) on PGlite, with THE route's verdicts
 * (`namedVerdicts`) over real agents, then the real validator.
 *
 * Asserted (each rules out a rule the others would pass):
 *   - the person's own awake agent is accepted (no error at all);
 *   - an unknown id, a paused agent and another person's agent are refused,
 *     each by name with the route's sentence;
 *   - a hand-off or an await beside mode "propose" / "appointment" is refused;
 *   - an awaitTimeout past 30 days, or without await, is refused.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    close: () => Promise<void>;
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
  const mocked = { ...actual, getDb: async () => db };
  Object.defineProperty(mocked, "db", { get: () => db, enumerable: true });
  return mocked;
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { is } from "drizzle-orm";
import { PgTable as PgTableClass } from "drizzle-orm/pg-core";
import * as database from "@synap/database";
import { loadFlowValidationResolvers } from "./automations.js";
import { validateFlowDefinition } from "../services/automations/validate-flow.js";

const USER = randomUUID();
const OTHER = randomUUID();
const MINE = randomUUID();
const PAUSED = randomUUID();
const FOREIGN = randomUUID();
const NOBODY = randomUUID();
const WS = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = t.endsWith("[]") ? t : BASIC.test(t) ? t : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

/** A one-node flow: trigger → playbook_run with `data`. */
const flowWith = (...nodes: Array<Record<string, unknown>>) => ({
  nodes: [
    { id: "trigger", type: "trigger", data: { triggerType: "manual" } },
    ...nodes.map((data, i) => ({
      id: `run${i}`,
      type: "playbook_run",
      data: { playbookName: "Render a cut", ...data },
    })),
  ],
  edges: nodes.map((_, i) => ({
    id: `e${i}`,
    source: "trigger",
    target: `run${i}`,
  })),
});

async function check(flow: ReturnType<typeof flowWith>) {
  const resolvers = await loadFlowValidationResolvers(
    await database.getDb(),
    flow as never,
    WS,
    USER
  );
  // The playbook reference is not what this suite is about.
  return validateFlowDefinition(flow, {
    ...resolvers,
    playbookExists: () => true,
  }).errors.map((e) => ({
    nodeId: e.nodeId,
    code: e.code,
    message: e.message,
  }));
}

beforeAll(async () => {
  const seen = new Set<string>();
  for (const t of Object.values(database)) {
    if (!is(t, PgTableClass)) continue;
    const name = getTableConfig(t as PgTable).name;
    if (seen.has(name)) continue;
    seen.add(name);
    await h.client!.exec(ddlFor(t as PgTable));
  }
  expect(seen.size).toBeGreaterThan(50);
  await q(
    `insert into users (id, email, name, user_type, agent_type, created_by_user_id, agent_paused_at) values
      ($1, 'a@x.test', 'Antoine', 'human', null, null, null),
      ($2, 'o@x.test', 'Other', 'human', null, null, null),
      ($3, 'm@x.test', 'Claude Code', 'agent', 'claude-code', $1, null),
      ($4, 'p@x.test', 'Hermes', 'agent', 'hermes', $1, now()),
      ($5, 'f@x.test', 'Their editor', 'agent', 'claude-code', $2, null)`,
    [USER, OTHER, MINE, PAUSED, FOREIGN]
  );
  // Each agent's runner served it 30 s ago: a pull agent, awake.
  for (const [agent, owner] of [
    [MINE, USER],
    [PAUSED, USER],
    [FOREIGN, OTHER],
  ] as const) {
    await q(
      `insert into api_keys (id, user_id, key_type, is_active, linked_user_id, last_used_at, instance_label, worker_served_at, created_at)
       values ($1, $2, 'hub_inbound', true, $3, now(), 'mac', now() - interval '30 seconds', now())`,
      [randomUUID(), agent, owner]
    );
  }
});

afterAll(async () => {
  await h.client?.close();
});

describe("a playbook_run hand-off is checked when the rule is written", () => {
  it("the person's own awake agent is accepted", async () => {
    expect(await check(flowWith({ handToAgentId: MINE }))).toEqual([]);
  });

  it("an unknown, a paused and another person's agent are refused by name", async () => {
    const errors = await check(
      flowWith(
        { handToAgentId: NOBODY },
        { handToAgentId: PAUSED },
        { handToAgentId: FOREIGN }
      )
    );
    expect(errors.map((e) => [e.nodeId, e.code])).toEqual([
      ["run0", "playbook_run_bad_hand_off"],
      ["run1", "playbook_run_bad_hand_off"],
      ["run2", "playbook_run_bad_hand_off"],
    ]);
    expect(errors[0]!.message).toContain("no such agent");
    expect(errors[1]!.message).toContain("Hermes is paused");
    expect(errors[2]!.message).toContain(
      "Their editor does not act for the person"
    );
  });
});

describe("hand-off and await are about a run", () => {
  it("beside a proposal or an appointment they are refused", async () => {
    const errors = await check(
      flowWith(
        { handToAgentId: MINE, mode: "propose" },
        { await: true, mode: "appointment" },
        { await: true, mode: "run" }
      )
    );
    expect(errors.map((e) => [e.nodeId, e.code])).toEqual([
      ["run0", "playbook_run_needs_run_mode"],
      ["run1", "playbook_run_needs_run_mode"],
    ]);
  });

  it("a timeout past 30 days, or without await, is refused", async () => {
    const errors = await check(
      flowWith(
        { await: true, awaitTimeout: "45d" },
        { awaitTimeout: "2h" },
        { await: true, awaitTimeout: "12h" }
      )
    );
    expect(errors.map((e) => [e.nodeId, e.code])).toEqual([
      ["run0", "playbook_run_bad_await_timeout"],
      ["run1", "playbook_run_bad_await_timeout"],
    ]);
  });
});

describe("await inside a loop is refused when the rule is written", () => {
  const loopFlow = (
    edges: Array<{ id: string; source: string; target: string }>
  ) => ({
    nodes: [
      { id: "trigger", type: "trigger", data: { triggerType: "manual" } },
      {
        id: "q",
        type: "query",
        data: { profileSlug: "client", limit: 20 },
      },
      {
        id: "loop",
        type: "loop",
        data: {
          iteratorExpression: "steps.q.output.entities",
          itemVariable: "item",
        },
      },
      {
        id: "render",
        type: "playbook_run",
        data: { playbookName: "Render a cut", await: true },
      },
    ],
    edges,
  });
  const codes = (flow: ReturnType<typeof loopFlow>) =>
    validateFlowDefinition(flow, { playbookExists: () => true }).errors.map(
      (e) => [e.nodeId, e.code]
    );

  it("an awaited playbook_run in a loop body is refused", () => {
    expect(
      codes(
        loopFlow([
          { id: "e0", source: "trigger", target: "q" },
          { id: "e1", source: "q", target: "loop" },
          { id: "e2", source: "loop", target: "render" },
        ])
      )
    ).toEqual([["render", "playbook_run_await_in_loop"]]);
  });

  it("the same node outside the loop is accepted", () => {
    expect(
      codes(
        loopFlow([
          { id: "e0", source: "trigger", target: "q" },
          { id: "e1", source: "q", target: "loop" },
          { id: "e2", source: "q", target: "render" },
        ])
      )
    ).toEqual([]);
  });
});
