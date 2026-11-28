/**
 * diagnose's duplicate numbers on a REAL Postgres (PGlite): the review queue's
 * duplicate clusters (`diagnose({type: "proposal"})`), the whole-pod
 * `duplicate_proposals` section (`diagnose()`) and an agent's `duplicateRate`
 * (`diagnose({agentId})`) count the SAME thing, a twin: the same change
 * proposed twice (findings 9ae52db7, fb1e620a). And the whole-pod
 * `failed_flows` section names budget stops apart, never as failures.
 *
 * Live before the fix: 7 "duplicate clusters", the largest 7 deletes of 7
 * different notes (every run of one capability shares the capability as its
 * target, and the review fingerprint grouped on that), and 44% duplicates for
 * an agent whose sampled writes were all different.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const schema = await import("@synap/database/schema");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        state.db = drizzle(client, { schema });
      }
      return state.db;
    },
    async clientPgModule() {
      const db = await state.init();
      return {
        db,
        sql: undefined,
        getDb: async () => db,
        setCurrentUser: async () => undefined,
        clearCurrentUser: async () => undefined,
        closeDatabase: async () => undefined,
      };
    },
  };
  return state;
});

vi.mock("../../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const d = await h.init();
  return { ...actual, db: d, getDb: async () => d };
});

// Two whole-pod signals these tests do not read report "not computed" (no
// section): the schema contract reads project twins over the raw postgres.js
// client (`sql`), which has no PGlite twin here, and the resources signal
// reads the host.
vi.mock("../schema-contract.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gatherSchemaContractSignal: async () => undefined,
}));
vi.mock("../resources.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gatherResourcesSignal: async () => undefined,
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { diagnoseRouter } from "../index.js";

const OWNER = randomUUID();
const AGENT = randomUUID();
const WS = randomUUID();
const CAPABILITY = randomUUID();
const SESSION = randomUUID();
const NOTE = randomUUID();
const PB_FAILING = randomUUID();
const PB_STOPPED = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

type ColumnLike = {
  name: string;
  primary: boolean;
  hasDefault: boolean;
  default: unknown;
  getSQLType(): string;
};

// The whole-pod read touches most tables: schema-qualified ones and column
// defaults included (the same builder as the quality-by-prompt-version test).
function defaultFor(c: ColumnLike, type: string): string {
  if (!c.hasDefault) return "";
  const d = c.default;
  if (typeof d === "number" || typeof d === "boolean") return ` default ${d}`;
  if (typeof d === "string") return ` default '${d.replace(/'/g, "''")}'`;
  if (type === "jsonb" && d && typeof d === "object" && !("queryChunks" in d)) {
    return ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
  }
  if (type === "uuid") return " default gen_random_uuid()";
  if (type.startsWith("timestamp")) return " default now()";
  return "";
}

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = (cfg.columns as unknown as ColumnLike[]).map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${defaultFor(c, type)}`;
  });
  const name = cfg.schema ? `"${cfg.schema}"."${cfg.name}"` : `"${cfg.name}"`;
  const pre = cfg.schema ? `create schema if not exists "${cfg.schema}"; ` : "";
  return `${pre}create table if not exists ${name} (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

/** One proposal row in WS, filed `minutesAgo` minutes ago. */
function add(row: {
  proposalType: string;
  targetType: string;
  targetId: string;
  status: string;
  data: unknown;
  agent?: boolean;
  dedupHash?: string;
  minutesAgo: number;
}) {
  return q(
    `insert into proposals (id, workspace_id, target_type, target_id, proposal_type, status, data, created_by, agent_user_id, dedup_hash, created_at)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, now() - make_interval(mins => $11::int))`,
    [
      randomUUID(),
      WS,
      row.targetType,
      row.targetId,
      row.proposalType,
      row.status,
      JSON.stringify(row.data),
      OWNER,
      row.agent ? AGENT : null,
      row.dedupHash ?? null,
      row.minutesAgo,
    ]
  );
}

const deleteRun = (noteId: string) => ({
  proposalType: "capability.run",
  targetType: "capability",
  targetId: CAPABILITY,
  data: { verbId: "entities.delete", params: { entityId: noteId } },
});

beforeAll(async () => {
  await h.init();
  for (const table of Object.values(schema)) {
    try {
      getTableConfig(table as PgTable);
    } catch {
      continue;
    }
    await h.client!.exec(ddlFor(table as PgTable)).catch(() => undefined);
  }
  await q(
    `insert into users (id, email, name, user_type) values ($1, 'o@x.test', 'Owner', 'human')`,
    [OWNER]
  );
  await q(
    `insert into users (id, email, name, user_type, agent_type, created_by_user_id) values ($1, 'a@x.test', 'Agent', 'agent', 'claude-code', $2)`,
    [AGENT, OWNER]
  );
  await q(`insert into workspaces (id, name, owner_id) values ($1, 'W', $2)`, [
    WS,
    OWNER,
  ]);
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
    [randomUUID(), WS, OWNER]
  );

  // THE REVIEW QUEUE (pending, the owner's): seven deletes of seven different
  // notes, and one delete of one note filed twice.
  for (let i = 0; i < 7; i++)
    await add({
      ...deleteRun(randomUUID()),
      status: "pending",
      minutesAgo: 10 + i,
    });
  for (let i = 0; i < 2; i++)
    await add({
      proposalType: "delete",
      targetType: "entity",
      targetId: NOTE,
      status: "pending",
      data: { data: { id: NOTE } },
      minutesAgo: 20 + i,
    });

  // THE AGENT'S WEEK: seven deletes of seven different notes (no stored hash,
  // as a row filed before the column), and one session update it withdrew and
  // filed again. The withdraw stamped `withdrawReason` into the old row's
  // payload; both rows keep the hash the change had when filed.
  for (let i = 0; i < 7; i++)
    await add({
      ...deleteRun(randomUUID()),
      status: "approved",
      agent: true,
      minutesAgo: 30 + i,
    });
  const update = {
    proposalType: "update",
    targetType: "focus_session",
    targetId: SESSION,
    data: { data: { status: "paused" } },
    agent: true,
    dedupHash: "filed-change-hash",
  };
  await add({
    ...update,
    status: "withdrawn",
    data: { ...update.data, withdrawReason: "filing it again" },
    minutesAgo: 41,
  });
  await add({ ...update, status: "pending", minutesAgo: 40 });

  // THE FLOWS: one playbook failed today; another stopped at its budget twice
  // (failed + stop_reason budget), and once more 10 days ago, outside the
  // 7-day window.
  for (const [id, name] of [
    [PB_FAILING, "Breaks"],
    [PB_STOPPED, "Hits its budget"],
  ])
    await q(
      `insert into playbooks (id, name, workspace_id) values ($1, $2, $3)`,
      [id, name, WS]
    );
  const run = (
    playbookId: string,
    stopReason: string | null,
    hoursAgo: number
  ) =>
    q(
      `insert into playbook_runs (id, playbook_id, workspace_id, status, stop_reason, started_at, completed_at)
       values ($1, $2, $3, 'failed', $4, now() - make_interval(hours => $5::int), now() - make_interval(hours => $5::int))`,
      [randomUUID(), playbookId, WS, stopReason, hoursAgo]
    );
  await run(PB_FAILING, null, 2);
  await run(PB_STOPPED, "budget", 3);
  await run(PB_STOPPED, "budget", 5);
  await run(PB_STOPPED, "budget", 240);
});

type Section = {
  key: string;
  status: string;
  headline: string;
  detail: Record<string, unknown>;
};
async function globalSection(key: string): Promise<Section> {
  const report = (await diagnoseRouter({ userId: OWNER })) as unknown as {
    sections: Section[];
  };
  const section = report.sections.find((s) => s.key === key);
  if (!section) throw new Error(`no ${key} section: ${JSON.stringify(report)}`);
  return section;
}

describe("diagnose counts real twins, the same way in both numbers", () => {
  it("the review queue: seven deletes of seven notes are no cluster; one delete filed twice is one", async () => {
    const report = await diagnoseRouter({ userId: OWNER, type: "proposal" });
    if (!("mode" in report) || report.mode !== "class")
      throw new Error(JSON.stringify(report));
    // 7 + 2 of the owner's, + the agent's refile.
    expect(report.detail.pending).toBe(10);
    expect(report.detail.duplicateClusters).toEqual([
      { targetLabel: expect.any(String), count: 2 },
    ]);
    expect(report.summary).toContain("1 duplicate cluster(s)");
  });

  it("the whole-pod section marks the SAME twins as the review queue, not the review groups", async () => {
    const classReport = await diagnoseRouter({
      userId: OWNER,
      type: "proposal",
    });
    if (!("mode" in classReport) || classReport.mode !== "class")
      throw new Error(JSON.stringify(classReport));
    const section = await globalSection("duplicate_proposals");
    expect(section.detail.clusters).toEqual(
      classReport.detail.duplicateClusters
    );
    expect(section.detail.clusters).toEqual([
      { targetLabel: expect.any(String), count: 2 },
    ]);
    expect(section.status).toBe("attention");
  });

  it("the agent card: the withdraw-and-refile is its only twin pair", async () => {
    const report = await diagnoseRouter({ userId: OWNER, agentId: AGENT });
    if (!("mode" in report) || report.mode !== "agent")
      throw new Error(JSON.stringify(report));
    expect(report.duplicateSample.size).toBe(9);
    expect(report.rates.duplicateRate).toBeCloseTo(2 / 9, 4);
  });
});

describe("diagnose() names budget stops apart from failing flows", () => {
  it("counts the flow that stopped in the window as information, never as failing", async () => {
    const section = await globalSection("failed_flows");
    // Only the real failure makes the section degraded.
    expect(section.detail.failingFlows).toBe(1);
    expect(section.status).toBe("degraded");
    // The budget stops: one flow, its two stops inside the 7 days.
    expect(section.detail.stoppedFlows).toBe(1);
    expect(section.detail.stoppedRuns).toBe(2);
    expect(section.headline).toContain("1 flow(s) stopped at their budget");
  });
});
