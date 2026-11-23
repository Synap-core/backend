/**
 * A capture plan's ARM on an EXISTING decision (`links[]` `toEntityId` +
 * `option`) is judged at PREFLIGHT, with the dependency door's own words
 * (`armOptionProblem`). Before, only an in-plan decision was checked at
 * propose time: an arm on an existing decision naming an option it does not
 * list was FILED, and failed only when the person approved it.
 *
 * Real: the preflight (`preflightPlanOperations`), its pure half, the entity
 * visibility floor and the arm rule, on PGlite with every schema table.
 * Nothing stubbed but the database handle.
 *
 * Each case names the wrong rule it rules out.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 120_000 });

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const pg = drizzle(client);
  h.db = pg;
  return { ...actual, db: pg, getDb: async () => pg };
});

import { allSchemaTables, pgliteTableDdl } from "../../../__tests__/pglite-ddl.js";
import { preflightPlanOperations } from "../capture-plan-preflight.js";
import type { CompositeProposalOperation } from "@synap-core/types/proposals";

const OWNER = "user-owner";

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

async function entity(
  type: string,
  properties: Record<string, unknown>
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into entities (id, user_id, workspace_id, type, title, properties, system_data)
     values ($1, $2, null, $3, $4, $5::jsonb, '{}'::jsonb)`,
    [id, OWNER, type, `${type} ${id.slice(0, 4)}`, JSON.stringify(properties)]
  );
  return id;
}

const OPTIONS = {
  decisionOptions: [
    { label: "Raise", value: "raise" },
    { label: "Bootstrap", value: "bootstrap" },
  ],
};

/** A one-step plan whose step waits on `toEntityId`, naming `option`. */
function plan(toEntityId: string, option?: string): CompositeProposalOperation[] {
  return [
    { op: "create_session", ref: "step", goal: "Run the raise" },
    {
      op: "create_link",
      type: "blocked_by",
      fromRef: "step",
      toEntityId,
      ...(option !== undefined ? { option } : {}),
    },
  ] as CompositeProposalOperation[];
}

async function problemsOf(ops: CompositeProposalOperation[]) {
  const { problems } = await preflightPlanOperations(
    h.db as never,
    ops,
    OWNER,
    { workspaceId: null }
  );
  return problems;
}

beforeAll(async () => {
  for (const t of allSchemaTables()) await h.client!.exec(pgliteTableDdl(t));
  await q(`insert into users (id, email) values ($1, 'o@x.test')`, [OWNER]);
});

describe("capture plan preflight — an arm on an existing decision", () => {
  it("refuses an option the decision does not list, on the link step, naming the options it has (rules out 'only an in-plan decision is checked')", async () => {
    const d = await entity("decision", OPTIONS);
    const problems = await problemsOf(plan(d, "sell"));
    expect(problems).toEqual([
      expect.objectContaining({
        opIndex: 1,
        op: "create_link",
        message:
          '"sell" is not an option of this decision. Its options: "raise", "bootstrap".',
      }),
    ]);
  });

  it("accepts an option the decision lists, by its key (rules out 'every arm on an existing decision is refused')", async () => {
    const d = await entity("decision", OPTIONS);
    expect(await problemsOf(plan(d, "raise"))).toEqual([]);
  });

  it("refuses an arm on an entity that is not a decision, and on a decision with no options", async () => {
    const task = await entity("task", OPTIONS);
    expect((await problemsOf(plan(task, "raise"))).map((p) => p.message)).toEqual([
      "Only a wait on a decision can name an option (an arm).",
    ]);
    const bare = await entity("decision", {});
    expect((await problemsOf(plan(bare, "raise"))).map((p) => p.message)).toEqual([
      "This decision lists no options (decisionOptions): give it its options, then name one.",
    ]);
  });

  it("a plain wait on an existing decision (no option) is not an arm and passes", async () => {
    const d = await entity("decision", {});
    expect(await problemsOf(plan(d))).toEqual([]);
  });

  it("an unseen decision is reported once as not found, never also judged as an arm (no existence oracle)", async () => {
    const ghost = randomUUID();
    expect((await problemsOf(plan(ghost, "raise"))).map((p) => p.message)).toEqual([
      `entity ${ghost} was not found`,
    ]);
  });
});
