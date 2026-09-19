/**
 * The lessons scanner's DB TIER, driven END TO END on PGlite.
 *
 * Real: `handlePlaybookLessonsScan(playbookLessonsDbDeps + injected IS)` →
 * `loadCandidatePlaybooks`'s raw SQL → `loadPlaybookScorecardRows` → the
 * projection → `hasOpenRevision`'s predicate → `insertPendingProposal`. Only
 * the IS call is injected. NOTHING is hand-built in between, which is the
 * point: every invariant the pure tests cannot see here is a WHERE clause or a
 * column name, and a hand-built fake db would only prove the fake.
 *
 * Each fixture discriminates one rule of the SQL:
 *   - a playbook whose runs belong to ANOTHER user (the owner floor);
 *   - a closed run OUTSIDE the window (the closed_at cutoff);
 *   - an ARCHIVED playbook at full volume (the status filter);
 *   - a playbook with 2 closed runs (the HAVING count floor);
 *   - an open `playbook/update` proposal (hasOpenRevision's 4-part predicate,
 *     which is also what proves the row shape: targetType "playbook" +
 *     proposalType "update", NOT one "playbook/update" column).
 *
 * ── MEASURED BOUNDARY (found by mutation, not assumed) ─────────────────────
 * The window and the closed-status rule are each enforced TWICE — once in
 * `loadCandidatePlaybooks`'s prefilter and once downstream (the `closedAfter`
 * handed to `loadPlaybookScorecardRows`, and `projectPlaybookScorecard`'s own
 * `status === "closed"` filter). They MASK each other: breaking either one
 * alone leaves this file green, and only breaking BOTH turns it red. That is a
 * real property of the design (the prefilter is documented as a prefilter that
 * must never be stricter than the threshold), not a hole to paper over — but it
 * means this file proves "the window is enforced SOMEWHERE", not "the prefilter
 * clause is load-bearing". Verified by reverting each clause singly (green) and
 * both together (red).
 *
 * `hasOpenRevision`'s four conjuncts are NOT masked: each one alone turns this
 * file red, because the fixtures include a pending playbook/ARCHIVE of the same
 * playbook, a pending playbook/update of ANOTHER playbook, and a pending
 * entity/update sharing the id. Those three rows exist only to make the
 * mutation observable; without them every conjunct mutation stayed green.
 *
 * NOT covered: pg-boss registration (the queues-are-created tripwire owns it)
 * and true cross-connection concurrency (PGlite is one connection).
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

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  focusSessions,
  sessionEvaluations,
  proposals,
  playbooks,
  events,
  channels,
  projects,
} from "@synap/database/schema";
import {
  handlePlaybookLessonsScan,
  playbookLessonsDbDeps,
  WINDOW_DAYS,
  type PlaybookLessonsScanDeps,
} from "./playbook-lessons-scanner.js";

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

const OWNER = "user-owner";
const STRANGER = "user-stranger";

const STAGES = [
  {
    key: "ship",
    name: "Ship",
    category: "execute",
    goal: "Land the change",
    criteria: [
      {
        key: "tsc",
        statement: "Typecheck passes with 0 errors",
        required: true,
        check: { kind: "judge", hint: "read the gate output" },
      },
    ],
    lessons: ["Ship on Fridays"],
  },
];

async function playbook(opts: {
  name: string;
  status?: string;
  stages?: unknown;
}): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into playbooks (id, workspace_id, created_by, name, goal_template,
        stages, criteria, status, params, input_strategy, channel_spec,
        expected_outputs, version)
     values ($1, $2, $3, $4, 'do @{arg:thing}', $5::jsonb, '[]'::jsonb, $6,
        '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, 1)`,
    [
      id,
      randomUUID(),
      OWNER,
      opts.name,
      JSON.stringify(opts.stages ?? STAGES),
      opts.status ?? "active",
    ]
  );
  return id;
}

/** A closed run of `playbookId` with one judged verdict on `tsc`. */
async function run(opts: {
  playbookId: string;
  verdict: "pass" | "fail";
  userId?: string;
  closedDaysAgo?: number;
  status?: string;
}): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, playbook_id, criteria,
        expected_outputs, metadata, created_at, closed_at)
     values ($1, $2, 'run it', $3, $4, $5::jsonb, '[]'::jsonb, '{}'::jsonb,
        now() - interval '120 days', now() - ($6::int * interval '1 day'))`,
    [
      id,
      opts.userId ?? OWNER,
      opts.status ?? "closed",
      opts.playbookId,
      JSON.stringify(
        STAGES[0].criteria.map((c) => ({ ...c, stageKey: "ship" }))
      ),
      opts.closedDaysAgo ?? 3,
    ]
  );
  await q(
    `insert into session_evaluations (id, session_id, criterion_key, verdict,
        evaluator_kind, attempt, created_at)
     values ($1, $2, 'tsc', $3, 'ai', 1, now() - interval '2 days')`,
    [randomUUID(), id, opts.verdict]
  );
  return id;
}

/** `handlePlaybookLessonsScan` on the REAL db tier, with only the IS injected. */
function scan(
  reviseLessons: PlaybookLessonsScanDeps["reviseLessons"] = async () => [
    "NEVER close without a green typecheck",
  ]
) {
  return handlePlaybookLessonsScan({
    ...playbookLessonsDbDeps,
    reviseLessons,
  });
}

/** A PENDING proposal row, for the supersede predicate's discriminating cases. */
async function pendingProposal(opts: {
  targetType: string;
  proposalType: string;
  targetId: string;
}) {
  await q(
    `insert into proposals (id, workspace_id, target_type, proposal_type,
        target_id, status, data, created_by)
     values ($1, $2, $3, $4, $5, 'pending', '{}'::jsonb, $6)`,
    [
      randomUUID(),
      randomUUID(),
      opts.targetType,
      opts.proposalType,
      opts.targetId,
      OWNER,
    ]
  );
}

async function proposalRows() {
  const { rows } = await q<{
    id: string;
    target_type: string;
    proposal_type: string;
    target_id: string;
    status: string;
    subject_user_id: string | null;
    data: Record<string, unknown>;
  }>(
    `select id, target_type, proposal_type, target_id, status, subject_user_id, data
     from proposals order by created_at`
  );
  return rows;
}

beforeAll(async () => {
  await import("@synap/database");
  await h.client!.exec(
    [
      focusSessions,
      sessionEvaluations,
      proposals,
      playbooks,
      events,
      channels,
      projects,
    ]
      .map((t) => ddlFor(t as PgTable))
      .join("\n")
  );
});

beforeEach(async () => {
  await h.client!.exec(
    `truncate focus_sessions, session_evaluations, proposals, playbooks, events;`
  );
});

describe("lessons scanner — the real DB tier", () => {
  it("finds the playbook, files ONE proposal, and stores it as playbook + update", async () => {
    const pb = await playbook({ name: "Verified Wave" });
    await run({ playbookId: pb, verdict: "fail" });
    await run({ playbookId: pb, verdict: "fail" });
    await run({ playbookId: pb, verdict: "pass" });

    const filed = await scan();
    expect(filed).toHaveLength(1);

    const rows = await proposalRows();
    expect(rows).toHaveLength(1);
    // The executor key is `${targetType}/${proposalType}` — a single
    // "playbook/update" column would resolve to NOTHING on approval.
    expect(rows[0]).toMatchObject({
      target_type: "playbook",
      proposal_type: "update",
      target_id: pb,
      status: "pending",
      subject_user_id: OWNER,
    });
    const data = rows[0].data as {
      data: { id: string; stages: Array<{ lessons?: string[] }> };
      sourceSessionIds: string[];
      rationale: string;
      lessonsRevision: boolean;
    };
    expect(data.data.id).toBe(pb);
    // REPLACED, not appended — the stored stage no longer carries the old line.
    expect(data.data.stages[0].lessons).toEqual([
      "NEVER close without a green typecheck",
    ]);
    expect(data.sourceSessionIds).toHaveLength(3);
    expect(data.rationale).toContain("Verified Wave");
    expect(data.lessonsRevision).toBe(true);
  });

  it("OWNER FLOOR: another user's runs of the same playbook are a separate history", async () => {
    const pb = await playbook({ name: "Shared Playbook" });
    // Two failing runs for the owner, one for a stranger. Neither user alone
    // clears the floor; a scan that ignored user_id would see 3 and fire.
    await run({ playbookId: pb, verdict: "fail" });
    await run({ playbookId: pb, verdict: "fail" });
    await run({ playbookId: pb, verdict: "fail", userId: STRANGER });

    expect(await scan()).toEqual([]);
    expect(await proposalRows()).toEqual([]);
  });

  it(`WINDOW: a run closed more than ${WINDOW_DAYS} days ago is not evidence`, async () => {
    const pb = await playbook({ name: "Old Playbook" });
    await run({ playbookId: pb, verdict: "fail" });
    await run({ playbookId: pb, verdict: "fail" });
    await run({
      playbookId: pb,
      verdict: "fail",
      closedDaysAgo: WINDOW_DAYS + 5,
    });

    expect(await scan()).toEqual([]);
  });

  it("STATUS: only CLOSED runs count", async () => {
    const pb = await playbook({ name: "Busy Playbook" });
    await run({ playbookId: pb, verdict: "fail" });
    await run({ playbookId: pb, verdict: "fail" });
    await run({ playbookId: pb, verdict: "fail", status: "active" });

    expect(await scan()).toEqual([]);
  });

  it("an ARCHIVED playbook is never taught, however bad its history", async () => {
    const pb = await playbook({ name: "Retired", status: "archived" });
    await run({ playbookId: pb, verdict: "fail" });
    await run({ playbookId: pb, verdict: "fail" });
    await run({ playbookId: pb, verdict: "fail" });

    expect(await scan()).toEqual([]);
    expect(await proposalRows()).toEqual([]);
  });

  it("SUPERSEDE: an open playbook/update proposal blocks a second one", async () => {
    const pb = await playbook({ name: "Verified Wave" });
    await run({ playbookId: pb, verdict: "fail" });
    await run({ playbookId: pb, verdict: "fail" });
    await run({ playbookId: pb, verdict: "pass" });

    expect(await scan()).toHaveLength(1);
    const reviseAgain = vi.fn(async () => ["a second, different lesson"]);
    expect(await scan(reviseAgain)).toEqual([]);
    // Skipped before the IS is paid.
    expect(reviseAgain).not.toHaveBeenCalled();
    expect(await proposalRows()).toHaveLength(1);

    // …and once the human decides, the next pass is free to propose again.
    await q(`update proposals set status = 'approved'`);
    expect(await scan(reviseAgain)).toHaveLength(1);
    expect(reviseAgain).toHaveBeenCalledTimes(1);
  });

  /**
   * The DISCRIMINATING cases for `hasOpenRevision`'s 4-part predicate. Without
   * them the guard was vacuous: the only fixture row WAS a pending
   * playbook/update, so dropping any single conjunct changed nothing — verified
   * by mutation, which stayed green until these two rows existed.
   */
  it("SUPERSEDE is exact: another proposal TYPE, or another playbook, does not block", async () => {
    const pb = await playbook({ name: "Verified Wave" });
    const other = await playbook({ name: "Someone Else" });
    await run({ playbookId: pb, verdict: "fail" });
    await run({ playbookId: pb, verdict: "fail" });
    await run({ playbookId: pb, verdict: "pass" });

    // A pending ARCHIVE of this playbook rewrites no stages — it must not block.
    await pendingProposal({
      targetType: "playbook",
      proposalType: "archive",
      targetId: pb,
    });
    // A pending UPDATE of a DIFFERENT playbook must not block this one.
    await pendingProposal({
      targetType: "playbook",
      proposalType: "update",
      targetId: other,
    });
    // A pending update of an ENTITY that happens to share this id must not block.
    await pendingProposal({
      targetType: "entity",
      proposalType: "update",
      targetId: pb,
    });

    expect(await scan()).toHaveLength(1);
    const filed = (await proposalRows()).filter(
      (r) =>
        r.target_type === "playbook" &&
        r.proposal_type === "update" &&
        r.target_id === pb
    );
    expect(filed).toHaveLength(1);
  });

  it("IS unreachable ⇒ no row is written at all", async () => {
    const pb = await playbook({ name: "Verified Wave" });
    await run({ playbookId: pb, verdict: "fail" });
    await run({ playbookId: pb, verdict: "fail" });
    await run({ playbookId: pb, verdict: "pass" });

    expect(
      await scan(async () => {
        throw new Error("connect ECONNREFUSED");
      })
    ).toEqual([]);
    expect(await proposalRows()).toEqual([]);
  });
});
