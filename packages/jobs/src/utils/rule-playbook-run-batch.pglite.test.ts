/**
 * ONE batch, ONE proposal — `proposeRulePlaybookRun` on PGlite, real SQL.
 *
 * A propose-mode activator ("Qualify a lead", `{on: created, mode: propose}`)
 * fires once per attached role. An import of 101 leads used to file 101
 * proposals and flood the queue. The attach event now names its batch
 * (`data.batchId`, the facet door), and every subject of ONE batch joins ONE
 * pending proposal for that rule, which lists them (`subjectIds`) and says how
 * many. A single event (no batch) is filed exactly as before.
 *
 * Discriminating rows: the same batch → one proposal of N; no batch → N
 * proposals (the rival "coalesce everything per rule" would merge them); a
 * different batch → its own proposal (the rival "coalesce per rule while one
 * is pending" would merge them); a repeated subject → not counted twice.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
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
vi.mock("./realtime-broadcast.js", () => ({
  broadcastNotification: vi.fn(async () => undefined),
}));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { proposals, users, entities } from "@synap/database/schema";
import {
  proposeRulePlaybookRun,
  readBatchSubjectIds,
} from "./automation-governance.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
type ColumnLike = {
  name: string;
  primary: boolean;
  hasDefault: boolean;
  default: unknown;
  getSQLType(): string;
};
function defaultFor(c: ColumnLike, type: string): string {
  if (!c.hasDefault) return "";
  const d = c.default;
  if (type.endsWith("[]")) return " default '{}'";
  if (typeof d === "number" || typeof d === "boolean") return ` default ${d}`;
  if (typeof d === "string") return ` default '${d.replace(/'/g, "''")}'`;
  if (d && typeof d === "object" && !("queryChunks" in d)) {
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
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const OWNER = randomUUID();
const WS = randomUUID();
const PB = randomUUID();
let AUTOMATION = randomUUID();

const propose = (subjectId: string, batchId?: string) =>
  proposeRulePlaybookRun({
    ownerId: OWNER,
    workspaceId: WS,
    automationId: AUTOMATION,
    playbookId: PB,
    playbookName: "Qualify a lead",
    params: {},
    subjectId,
    ...(batchId ? { batchId, batchSubjectKind: "lead" } : {}),
  });

const pendingRuns = async () =>
  (
    await h.client!.query<{ data: Record<string, unknown> }>(
      `select data from proposals where data->>'automationId' = $1 and status = 'pending'`,
      [AUTOMATION]
    )
  ).rows.map((r) => r.data);

beforeAll(async () => {
  await h.client!.exec(ddlFor(proposals as unknown as PgTable));
  await h.client!.exec(ddlFor(users as unknown as PgTable));
  await h.client!.exec(ddlFor(entities as unknown as PgTable));
  await h.client!.query(
    `insert into users (id, email, user_type) values ($1, 'o@example.test', 'human')`,
    [OWNER]
  );
}, 60_000);

beforeEach(() => {
  AUTOMATION = randomUUID();
});

describe("proposeRulePlaybookRun — one batch files ONE proposal", () => {
  it("every subject of one batch joins one proposal, which counts them", async () => {
    const batch = randomUUID();
    const subjects = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const names = [
      "Ada Lovelace",
      "Grace Hopper",
      "Mary Jackson",
      "Katherine Johnson",
    ];
    for (const [i, id] of subjects.entries()) {
      await h.client!.query(
        `insert into entities (id, user_id, type, title) values ($1, $2, 'person', $3)`,
        [id, OWNER, names[i]]
      );
    }
    const results = [];
    for (const s of subjects) results.push(await propose(s, batch));
    const rows = await pendingRuns();
    expect(rows).toHaveLength(1);
    expect(new Set(results.map((r) => r.proposalId)).size).toBe(1);
    const inner = rows[0]!.data as Record<string, unknown>;
    expect(readBatchSubjectIds(inner)).toEqual(subjects);
    // The first subject stays `subjectId`: a batch of one runs like a single.
    expect(inner.subjectId).toBe(subjects[0]);
    // The title, through the vocabulary door — what every renderer shows.
    expect(rows[0]!.summary).toBe(
      'Run Template "Qualify a lead" for 4 new leads'
    );
    // The pod's words name the first subjects, and how many more — as the
    // POLICY reason, never the proposer's WHY.
    expect(rows[0]).not.toHaveProperty("reasoning");
    expect(rows[0]!.policyReason).toBe(
      'Ada Lovelace, Grace Hopper, Mary Jackson + 1 more arrived together and matched this rule — approving starts "Qualify a lead" on each; rejecting starts none.'
    );
  });

  it("concurrent records of one batch still file ONE proposal", async () => {
    const batch = randomUUID();
    const subjects = Array.from({ length: 6 }, () => randomUUID());
    await Promise.all(subjects.map((s) => propose(s, batch)));
    const rows = await pendingRuns();
    expect(rows).toHaveLength(1);
    expect(
      readBatchSubjectIds(rows[0]!.data as Record<string, unknown>).sort()
    ).toEqual([...subjects].sort());
  });

  it("a repeated subject is not counted twice", async () => {
    const batch = randomUUID();
    const s = randomUUID();
    await propose(s, batch);
    const again = await propose(s, batch);
    expect(again.deduped).toBe(true);
    const rows = await pendingRuns();
    expect(
      readBatchSubjectIds(rows[0]!.data as Record<string, unknown>)
    ).toEqual([s]);
  });

  it("no batch: each event files its own proposal, exactly as before", async () => {
    await propose(randomUUID());
    await propose(randomUUID());
    const rows = await pendingRuns();
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r).not.toHaveProperty("batchId");
      expect(r).not.toHaveProperty("summary");
      expect(r.data).not.toHaveProperty("subjectIds");
      // No stored WHY: the review names the rule as the origin, so the old
      // "a rule … asks before starting this playbook" placeholder is gone.
      expect(r).not.toHaveProperty("reasoning");
    }
  });

  it("a different batch files its own proposal", async () => {
    await propose(randomUUID(), randomUUID());
    await propose(randomUUID(), randomUUID());
    expect(await pendingRuns()).toHaveLength(2);
  });
});
