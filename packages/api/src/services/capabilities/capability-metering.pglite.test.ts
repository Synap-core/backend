/**
 * METERING through the real run door: `executeCapability` → the run recorder →
 * `emitAiDecision` → `auditLog` → the real `EventRepository` INSERT, on PGlite.
 * The assertions read the `events` row back, so a meter that is computed but
 * never reaches the `provider` / `cost_usd` / `latency_ms` columns fails here.
 *
 *  - a verb that declares `metadata.metering` with a `costPath`: the price the
 *    provider reported lands in `cost_usd` (source "provider");
 *  - the same verb when the provider reports nothing: `cost_usd` IS NULL, never 0
 *    (the run is metered — `provider` is set — but unpriced);
 *  - a declared price table: `cost_usd` = the declared price (source "price_table");
 *  - a failed run: metered, unpriced;
 *  - no declaration: no meter at all (the columns stay NULL as before);
 *  - the at-most-once path (a verb that is not read-only) is metered too.
 *
 * Stubbed, and why: the code-skill sandbox (returns what a provider returns),
 * the gate (always `run`: governance is not under test), and the recall deposit
 * (embedding + knowledge write, unrelated to the receipt).
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  return {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
    sandbox: { success: true, result: null } as {
      success: boolean;
      result?: unknown;
      error?: string;
    },
  };
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client);
  // The run recorder's writer (`auditLog` → `new EventRepository(sql)`) speaks
  // `sql.unsafe(text, params)`: routed onto PGlite so the row really lands.
  const sql = Object.assign(
    () => {
      throw new Error("tagged sql is not available in this suite");
    },
    {
      unsafe: async (text: string, params: unknown[] = []) =>
        (await client.query(text, params)).rows,
    }
  );
  return {
    ...actual,
    db: h.db,
    sql,
    knowledgeRepository: { saveFact: async () => undefined },
  };
});
vi.mock("@synap/ai-embeddings", () => ({
  generateEmbedding: async () => new Array(1536).fill(0),
}));
vi.mock("./gate-capability-execution.js", () => ({
  gateCapabilityExecution: async () => ({ decision: "run" }),
}));
vi.mock("../skills/run-skill.js", () => ({
  runSkill: vi.fn(async () => h.sandbox),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { SQL } from "drizzle-orm";
import {
  skills,
  events,
  capabilityRunReceipts,
  links,
} from "@synap/database/schema";
import { executeCapability } from "./execute-capability.js";

const USER = "user-metering";

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const columns = cfg.columns.map((c) => {
    let type = c.getSQLType();
    if (/vector/.test(type) || c.columnType === "PgEnumColumn") type = "text";
    let def = "";
    const d = c.default as unknown;
    if (d !== undefined && !(d instanceof SQL)) {
      if (typeof d === "string") def = ` default '${d.replace(/'/g, "''")}'`;
      else if (typeof d === "number" || typeof d === "boolean")
        def = ` default ${d}`;
      else if (type.endsWith("[]")) def = ` default '{}'`;
      else def = ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
    } else if (type.startsWith("timestamp") && c.hasDefault) {
      def = " default now()";
    } else if (c.primary && type === "uuid") {
      def = " default gen_random_uuid()";
    }
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${columns.join(", ")});`;
}

/** A pod-scope code verb with the given metadata; returns its name. */
async function seedVerb(metadata: Record<string, unknown>): Promise<string> {
  const name = `search_${randomUUID().slice(0, 8)}`;
  await h.client!.query(
    `insert into skills (id, name, kind, scope, status, approved, user_id, metadata)
     values ($1, $2, 'code', 'pod', 'active', true, $3, $4::jsonb)`,
    [randomUUID(), name, USER, JSON.stringify(metadata)]
  );
  return name;
}

interface RunRow {
  provider: string | null;
  cost_usd: string | null;
  latency_ms: number | null;
  data: { kind: string; verbId: string; meter?: Record<string, unknown> };
}

/** The ONE `capability_run` event the run wrote. */
async function runRow(verbId: string): Promise<RunRow> {
  const { rows } = await h.client!.query<RunRow>(
    `select provider, cost_usd, latency_ms, data from events
      where data->>'kind' = 'capability_run' and data->>'verbId' = $1`,
    [verbId]
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

const EXA_METER = {
  provider: "exa",
  unit: "search",
  costPath: "costDollars.total",
};

beforeAll(async () => {
  // `links`: the run reads the verb's declared tools (`requires` edges) for
  // its verb act on every run since R2 (one skill door).
  for (const t of [skills, events, capabilityRunReceipts, links]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
});

beforeEach(() => {
  h.sandbox = { success: true, result: null };
});

async function run(verbId: string) {
  return executeCapability({
    verbId,
    parameters: { query: "synap" },
    workspaceId: null,
    userId: USER,
  });
}

describe("capability run metering (receipt on the run's own event)", () => {
  it("a reported price lands in cost_usd, with its provider and latency", async () => {
    const verb = await seedVerb({ readOnly: true, metering: EXA_METER });
    h.sandbox = {
      success: true,
      result: { results: [], costDollars: { total: 0.005 } },
    };
    expect((await run(verb)).kind).toBe("run");

    const row = await runRow(verb);
    expect(row.provider).toBe("exa");
    expect(Number(row.cost_usd)).toBe(0.005);
    expect(row.latency_ms).not.toBeNull();
    expect(row.data.meter).toMatchObject({
      provider: "exa",
      unit: "search",
      quantity: 1,
      costUsd: 0.005,
      costSource: "provider",
    });
  });

  it("an unreported price stays NULL — metered, never a fabricated 0", async () => {
    const verb = await seedVerb({ readOnly: true, metering: EXA_METER });
    h.sandbox = { success: true, result: { results: [], costDollars: null } };
    await run(verb);

    const row = await runRow(verb);
    expect(row.provider).toBe("exa");
    expect(row.cost_usd).toBeNull();
    expect(row.data.meter).toMatchObject({ costUsd: null, costSource: null });
  });

  it("a declared price table prices the run when the provider reports none", async () => {
    const verb = await seedVerb({
      readOnly: true,
      metering: { provider: "acme", unit: "search", costUsd: 0.01 },
    });
    h.sandbox = { success: true, result: { results: [] } };
    await run(verb);

    const row = await runRow(verb);
    expect(Number(row.cost_usd)).toBe(0.01);
    expect(row.data.meter).toMatchObject({ costSource: "price_table" });
  });

  it("a failed run is metered and unpriced", async () => {
    const verb = await seedVerb({
      readOnly: true,
      metering: { ...EXA_METER, costUsd: 0.01 },
    });
    h.sandbox = { success: false, error: "provider down" };
    expect((await run(verb)).kind).toBe("error");

    const row = await runRow(verb);
    expect(row.provider).toBe("exa");
    expect(row.cost_usd).toBeNull();
  });

  it("a verb that declares no meter writes none", async () => {
    const verb = await seedVerb({ readOnly: true });
    h.sandbox = { success: true, result: { costDollars: { total: 1 } } };
    await run(verb);

    const row = await runRow(verb);
    expect(row.provider).toBeNull();
    expect(row.cost_usd).toBeNull();
    expect(row.latency_ms).toBeNull();
    expect(row.data.meter).toBeUndefined();
  });

  it("the at-most-once path (a verb not declared read-only) is metered too", async () => {
    const verb = await seedVerb({ metering: EXA_METER });
    h.sandbox = { success: true, result: { costDollars: { total: 0.02 } } };
    expect((await run(verb)).kind).toBe("run");

    const row = await runRow(verb);
    expect(Number(row.cost_usd)).toBe(0.02);
    const { rows } = await h.client!.query(
      `select 1 from capability_run_receipts where verb_id = $1`,
      [verb]
    );
    expect(rows, "the run took the receipted path").toHaveLength(1);
  });
});
