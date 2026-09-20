/**
 * The playbook scorecard on PGlite — the real SQL (owner floor, playbook
 * filter, close-event count subquery) feeding the real projection.
 *
 * Every fixture session exists to DISCRIMINATE one rule; the comment on each
 * says which wrong rule it would expose.
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
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
  focusSessions,
  sessionEvaluations,
  events,
} from "@synap/database/schema";
import { db } from "@synap/database";
import {
  computePlaybookScorecard,
  loadPlaybookScorecardRows,
  findOverrides,
} from "./playbook-scorecard.js";

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

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const PLAYBOOK = randomUUID();
const OTHER_PLAYBOOK = randomUUID();
const CRITERIA = [
  { key: "tsc", statement: "Typecheck passes", check: { kind: "evidence" } },
  { key: "copy", statement: "Copy reads well", check: { kind: "judge" } },
];

async function session(opts: {
  status?: string;
  userId?: string;
  playbookId?: string;
  slots?: unknown[];
  closes?: number;
  /** Stamps `metadata.followedVia` — the ATTACHED marker the SQL reads. */
  attached?: boolean;
}): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, playbook_id, criteria, expected_outputs, metadata, closed_at)
     values ($1, $2, 'g', $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, now())`,
    [
      id,
      opts.userId ?? "user-1",
      opts.status ?? "closed",
      opts.playbookId ?? PLAYBOOK,
      JSON.stringify(CRITERIA),
      JSON.stringify(opts.slots ?? []),
      JSON.stringify(
        opts.attached ? { followedVia: "attach", followedAt: "2026-09-20" } : {}
      ),
    ]
  );
  for (let i = 0; i < (opts.closes ?? 1); i++) {
    await q(
      `insert into events (type, subject_id, subject_type, data, user_id, source)
       values ('focus_session.closed.completed', $1, 'focus_session', '{}'::jsonb, 'user-1', 'api')`,
      [id]
    );
  }
  return id;
}

let t = 0;
async function row(
  sessionId: string,
  key: string,
  verdict: string,
  kind: string,
  rationale = "r"
) {
  t++;
  await q(
    `insert into session_evaluations (session_id, user_id, criterion_key, verdict, evaluator_kind, rationale, created_at)
     values ($1, 'user-1', $2, $3, $4, $5, now() + ($6::int * interval '1 second'))`,
    [sessionId, key, verdict, kind, rationale, t]
  );
}

let ids: Record<string, string> = {};

beforeAll(async () => {
  await h.client!.exec(
    [focusSessions, sessionEvaluations, events]
      .map((x) => ddlFor(x as PgTable))
      .join("\n")
  );
  // S1: judge FAILED, a person PASSED it — the one real override.
  ids.s1 = await session({});
  await row(ids.s1, "tsc", "pass", "evidence");
  await row(ids.s1, "copy", "fail", "judge");
  await row(ids.s1, "copy", "pass", "human", "judge misread the tone");
  // S2: the person AGREES with the judge — not an override (rules out "any human row").
  ids.s2 = await session({});
  await row(ids.s2, "copy", "pass", "judge");
  await row(ids.s2, "copy", "pass", "human");
  // S3: judge could not measure, person fills in FAIL — not an override
  // (rules out "differs from ANY earlier row", which would count unmeasured).
  ids.s3 = await session({});
  await row(ids.s3, "copy", "unmeasured", "judge");
  await row(ids.s3, "copy", "fail", "human");
  // S4: failed twice, escalated to a person (owed criterion slot).
  ids.s4 = await session({
    slots: [
      { kind: "criterion", label: "Check: Copy reads well", owner: "human" },
      { kind: "document", label: "Notes" },
    ],
  });
  await row(ids.s4, "copy", "fail", "capability");
  await row(ids.s4, "copy", "fail", "judge");
  // S5: closed once, open again — reopened, and NOT closed.
  ids.s5 = await session({ status: "active" });
  // S6: closed twice — reopened; closed with no rows (not "evaluated").
  ids.s6 = await session({ closes: 2 });
  // Outside the floor: another person's session, another playbook's session.
  ids.other = await session({ userId: "user-2" });
  await row(ids.other, "copy", "fail", "judge");
  ids.otherPb = await session({ playbookId: OTHER_PLAYBOOK });
  await row(ids.otherPb, "copy", "fail", "judge");
});

describe("playbook scorecard on real SQL", () => {
  it("counts runs, evaluated runs and reopened runs through the owner + playbook floor", async () => {
    const card = await computePlaybookScorecard(db, {
      playbookId: PLAYBOOK,
      userId: "user-1",
    });
    expect(card.runs).toEqual({
      total: 6,
      closed: 5,
      evaluated: 4,
      reopened: 2,
      // Every fixture above was INSTANTIATED; the attached split is exercised
      // by its own case below, on a playbook of its own.
      instantiated: 6,
      attached: 0,
    });
    expect(card.escalations).toBe(1);
  });

  it("override = a person disagreeing with the latest measured non-human verdict — S1 only", async () => {
    const card = await computePlaybookScorecard(db, {
      playbookId: PLAYBOOK,
      userId: "user-1",
    });
    expect(card.overrides).toBe(1);
    const { evaluations } = await loadPlaybookScorecardRows(db, {
      playbookIds: [PLAYBOOK],
      userId: "user-1",
    });
    expect(findOverrides(evaluations)).toEqual([
      {
        sessionId: ids.s1,
        criterionKey: "copy",
        rationale: "judge misread the tone",
      },
    ]);
  });

  it("pass rate per criterion uses the CURRENT verdict (human wins) and excludes unmeasured", async () => {
    const card = await computePlaybookScorecard(db, {
      playbookId: PLAYBOOK,
      userId: "user-1",
    });
    const copy = card.criteria.find((c) => c.key === "copy")!;
    // S1 pass (human over judge), S2 pass, S3 fail, S4 fail, S6 unmeasured.
    expect(copy).toMatchObject({
      sessions: 5,
      passed: 2,
      failed: 2,
      unmeasured: 1,
      passRate: 0.5,
      overrides: 1,
      required: true,
    });
    const tsc = card.criteria.find((c) => c.key === "tsc")!;
    expect(tsc).toMatchObject({
      passed: 1,
      failed: 0,
      unmeasured: 4,
      passRate: 1,
    });
  });

  it("an ATTACHED run is counted, reported APART, and read from the real column", async () => {
    // The DISCRIMINATING pair: one session instantiated, one attached, same
    // playbook, same criteria. A rule that only counted `playbook_id` (or one
    // that dropped attached runs entirely) gives 2/0 or 1/0 here — both wrong,
    // and in opposite directions. The marker is `metadata.followedVia`, so
    // this also drives the `#>>` projection through real SQL rather than
    // hand-building the row the projection reads.
    const mixed = randomUUID();
    await session({ playbookId: mixed });
    await session({ playbookId: mixed, attached: true });
    const card = await computePlaybookScorecard(db, {
      playbookId: mixed,
      userId: "user-1",
    });
    expect(card.runs).toMatchObject({
      total: 2,
      instantiated: 1,
      attached: 1,
    });
    const { sessions } = await loadPlaybookScorecardRows(db, {
      playbookIds: [mixed],
      userId: "user-1",
    });
    expect(sessions.map((s) => s.attached).sort()).toEqual([false, true]);
  });

  it("nothing measured ⇒ passRate null, never 0", async () => {
    const unmeasured = randomUUID();
    await session({ playbookId: unmeasured });
    const card = await computePlaybookScorecard(db, {
      playbookId: unmeasured,
      userId: "user-1",
    });
    expect(card.runs.closed).toBe(1);
    expect(card.criteria.map((c) => c.passRate)).toEqual([null, null]);
  });
});
