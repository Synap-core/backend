/**
 * TOOL LENS — "every run of this tool" (pod admin's tool page: Running now,
 * History, and Runs filtered to one tool).
 *
 * A capability run names its skill in three places, one per ledger it lands
 * in: a `capability.run` proposal's `data.skillId` (the capability door) or
 * `data.capabilityId` with `capabilityKind: "skill"` (`skills.execute`), a
 * direct run's `capability_run` event `data.skillId`, and a box run's
 * `box_runs.skill_id`. `RunScope.skillIds` filters all three, and
 * `resolveToolSkillIds` turns a capability into its member skills.
 *
 * PGlite, like the session-lens sibling: the rows are INSERTed and a real
 * engine decides which come back, so an assertion is about reachability, not
 * about the shape of a WHERE clause. Each lens assertion has a discriminating
 * row (another skill's run, a capture row) that is reachable without the lens.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
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

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  proposals,
  events,
  workspaces,
  workspaceMembers,
  podMembers,
  users,
  projectMembers,
  boxRuns,
  capabilities,
  links,
} from "@synap/database/schema";
import { listRuns } from "../index.js";
import { resolveToolSkillIds } from "../tool-lens.js";

type ColumnLike = {
  name: string;
  primary: boolean;
  hasDefault: boolean;
  default: unknown;
  getSQLType(): string;
};

/** Minimal DDL derived from the REAL Drizzle table config (as the
 *  session-lens sibling), so a column this reader depends on cannot go
 *  missing from the fixture while the test still passes. */
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = (cfg.columns as unknown as ColumnLike[]).map((c) => {
    const raw = c.getSQLType();
    const isArray = raw.endsWith("[]");
    const base = raw.replace(/\[\]$/, "").replace(/\(.*\)/, "");
    const type =
      /^(text|uuid|jsonb|boolean|integer|timestamp with time zone|timestamp)$/.test(
        base
      )
        ? base
        : "text";
    let def = "";
    if (c.hasDefault) {
      const d = c.default;
      if (isArray) def = " default '{}'";
      else if (typeof d === "number" || typeof d === "boolean")
        def = ` default ${d}`;
      else if (typeof d === "string")
        def = ` default '${d.replace(/'/g, "''")}'`;
      else if (d && typeof d === "object" && !("queryChunks" in d))
        def = ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
      else if (type === "uuid") def = " default gen_random_uuid()";
      else if (type.startsWith("timestamp")) def = " default now()";
    }
    return `"${c.name}" ${type}${isArray ? "[]" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const USER = "user-tool-lens";
const SKILL_A = randomUUID();
const SKILL_B = randomUUID();
/** A pod-wide capability whose one action is SKILL_A. */
const CAP = randomUUID();
/** A capability in a space the reader is not a member of. */
const CAP_HIDDEN = randomUUID();
const HIDDEN_SPACE = randomUUID();

/** Proposed run of SKILL_A through the capability door (`data.skillId`). */
const PROP_A_DOOR = randomUUID();
/** Proposed run of SKILL_A through `skills.execute` (`data.capabilityId`). */
const PROP_A_EXECUTE = randomUUID();
/** Proposed run of SKILL_B — the discriminating "other tool" row. */
const PROP_B = randomUUID();
/** Direct runs (event only, no proposal). */
const CORR_DIRECT_A = randomUUID();
const CORR_DIRECT_B = randomUUID();
/** Box runs. */
const BOX_A = randomUUID();
const BOX_B = randomUUID();
/** A capture.graph proposal: a ledger that names no skill. */
const CORR_CAPTURE = randomUUID();

const t = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString();

async function insertProposal(row: {
  id: string;
  proposalType: string;
  data: Record<string, unknown>;
  createdAt: string;
  correlationId?: string;
}) {
  await h.client!.query(
    `insert into proposals (id, proposal_type, target_type, target_id, status,
       correlation_id, workspace_id, created_at, reviewed_at, data)
     values ($1,$2,'capability','t','approved',$3,null,$4,$4,$5::jsonb)`,
    [
      row.id,
      row.proposalType,
      row.correlationId ?? randomUUID(),
      row.createdAt,
      JSON.stringify({ runResult: { ok: 1 }, ...row.data }),
    ]
  );
}

async function insertDirectEvent(row: {
  correlationId: string;
  skillId: string;
  timestamp: string;
}) {
  await h.client!.query(
    `insert into events (id, timestamp, subject_type, subject_id, type,
       user_id, correlation_id, data)
     values (gen_random_uuid(), $1, 'ai_decision', gen_random_uuid(),
       'ai_decision.completed', $2, $3, $4::jsonb)`,
    [
      row.timestamp,
      USER,
      row.correlationId,
      JSON.stringify({
        kind: "capability_run",
        skillId: row.skillId,
        verbId: "direct.verb",
        runResult: { ok: 1 },
      }),
    ]
  );
}

async function insertBoxRun(id: string, skillId: string, queuedAt: string) {
  await h.client!.query(
    `insert into box_runs (id, user_id, skill_id, spec, parameters, status, attempt, queued_at, created_at, updated_at)
     values ($1, $2, $3, $4::jsonb, '{}'::jsonb, 'queued', 0, $5, now(), now())`,
    [
      id,
      USER,
      skillId,
      JSON.stringify({ name: "chart_csv", language: "python" }),
      queuedAt,
    ]
  );
}

const ids = (runs: Array<{ id: string }>) => runs.map((r) => r.id).sort();

beforeAll(async () => {
  for (const table of [
    workspaces,
    workspaceMembers,
    proposals,
    events,
    podMembers,
    users,
    projectMembers,
    boxRuns,
    capabilities,
    links,
  ]) {
    await h.client!.exec(ddlFor(table as unknown as PgTable));
  }
  // A KNOWN principal: pod-wide rows are read only by a provisioned user.
  await h.client!.exec(
    `insert into users (id, email) values ('${USER}', '${USER}@example.test')`
  );
  await h.client!.query(
    `insert into capabilities (id, name, workspace_id) values ($1, 'Mail', null), ($2, 'Hidden', $3)`,
    [CAP, CAP_HIDDEN, HIDDEN_SPACE]
  );
  await h.client!.query(
    `insert into links (id, from_type, from_id, to_type, to_id, link_type)
     values (gen_random_uuid(), 'skill', $1, 'capability', $2, 'member_of'),
            (gen_random_uuid(), 'skill', $3, 'capability', $4, 'member_of')`,
    [SKILL_A, CAP, SKILL_B, CAP_HIDDEN]
  );
});

beforeEach(async () => {
  await h.client!.exec(
    `delete from proposals; delete from events; delete from box_runs;`
  );
  await insertProposal({
    id: PROP_A_DOOR,
    proposalType: "capability.run",
    data: { skillId: SKILL_A, verbId: "gmail_send" },
    createdAt: t(1),
  });
  await insertProposal({
    id: PROP_A_EXECUTE,
    proposalType: "capability.run",
    data: { capabilityKind: "skill", capabilityId: SKILL_A },
    createdAt: t(2),
  });
  await insertProposal({
    id: PROP_B,
    proposalType: "capability.run",
    data: { skillId: SKILL_B, verbId: "slack_post" },
    createdAt: t(3),
  });
  await insertProposal({
    id: randomUUID(),
    proposalType: "capture.graph",
    data: { skillId: SKILL_A },
    createdAt: t(4),
    correlationId: CORR_CAPTURE,
  });
  await insertDirectEvent({
    correlationId: CORR_DIRECT_A,
    skillId: SKILL_A,
    timestamp: t(5),
  });
  await insertDirectEvent({
    correlationId: CORR_DIRECT_B,
    skillId: SKILL_B,
    timestamp: t(6),
  });
  await insertBoxRun(BOX_A, SKILL_A, t(7));
  await insertBoxRun(BOX_B, SKILL_B, t(8));
});

describe("RunScope.skillIds — one tool's runs", () => {
  it("NON-VACUITY: with no tool lens, both tools' runs and the capture row are reachable", async () => {
    const capability = await listRuns({ userId: USER, flowType: "capability" });
    expect(ids(capability)).toEqual(
      ids([
        { id: PROP_A_DOOR },
        { id: PROP_A_EXECUTE },
        { id: PROP_B },
        { id: CORR_DIRECT_A },
        { id: CORR_DIRECT_B },
        { id: BOX_A },
        { id: BOX_B },
      ])
    );
    const capture = await listRuns({ userId: USER, flowType: "capture" });
    expect(capture.map((r) => r.id)).toContain(CORR_CAPTURE);
  });

  it("returns EXACTLY skill A's runs in all three ledgers, both proposal shapes included", async () => {
    const runs = await listRuns({
      userId: USER,
      flowType: "capability",
      scope: { skillIds: [SKILL_A] },
    });
    expect(ids(runs)).toEqual(
      ids([
        { id: PROP_A_DOOR },
        { id: PROP_A_EXECUTE },
        { id: CORR_DIRECT_A },
        { id: BOX_A },
      ])
    );
  });

  it("tracks the ARGUMENT: skill B's lens returns skill B's runs only", async () => {
    const runs = await listRuns({
      userId: USER,
      flowType: "capability",
      scope: { skillIds: [SKILL_B] },
    });
    expect(ids(runs)).toEqual(
      ids([{ id: PROP_B }, { id: CORR_DIRECT_B }, { id: BOX_B }])
    );
  });

  it("an EMPTY list matches nothing (a capability with no actions has no action runs)", async () => {
    const runs = await listRuns({
      userId: USER,
      flowType: "capability",
      scope: { skillIds: [] },
    });
    expect(runs).toEqual([]);
  });

  it("a ledger that names no skill contributes NOTHING under the lens, in the merged feed", async () => {
    const runs = await listRuns({
      userId: USER,
      scope: { skillIds: [SKILL_A] },
    });
    expect(runs.map((r) => r.id)).not.toContain(CORR_CAPTURE);
    expect(runs.map((r) => r.id)).toContain(PROP_A_DOOR);
  });
});

describe("resolveToolSkillIds — a tool's address", () => {
  it("a capability resolves to its member skills", async () => {
    expect(await resolveToolSkillIds(USER, { capabilityId: CAP })).toEqual([
      SKILL_A,
    ]);
  });

  it("a capability the reader cannot see is null, never an empty tool", async () => {
    expect(
      await resolveToolSkillIds(USER, { capabilityId: CAP_HIDDEN })
    ).toBeNull();
  });

  it("a skill is its own address", async () => {
    expect(await resolveToolSkillIds(USER, { skillId: SKILL_B })).toEqual([
      SKILL_B,
    ]);
  });
});
