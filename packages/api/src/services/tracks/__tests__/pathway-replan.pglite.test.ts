/**
 * THE PATHWAY RE-PLAN on PGlite (pathway plan 368179d7, P9) — the REAL
 * `runPathwayReplan`, the REAL rows it reads (a pathway goal, its steps, their
 * `blocked_by` / `spawned_from` / `replaces` links, the loop's own
 * proposals), the REAL shared budget count (`loopProposalCounts`), the REAL
 * goal-loop reactor that routes a close to it and the REAL sweep.
 *
 * Stubbed, only at the seam it files through: `submitCaptureGraph` (proven on
 * its own in `submit-capture-graph.reason-and-cap.test.ts`) — a stand-in that
 * records the call and inserts the pending row the real door writes (its
 * `created_by`, the loop's facts on `data`), so the loop's own counts read it.
 * The goal loop's start door is stubbed as in `goal-loop.pglite.test.ts`.
 *
 * Each case names the WRONG rule it rules out.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  submits: [] as Array<Record<string, unknown>>,
  permCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const pg = drizzle(client, {
    schema: {
      focusSessions: actual.focusSessions as never,
      projectTracks: actual.projectTracks as never,
      projects: actual.projects as never,
    },
  });
  return {
    ...actual,
    db: pg,
    getDb: async () => pg,
    // The package's own reader closes over the package's `db`: the same read
    // (one `spawned_from` edge per child) against this PGlite.
    getParentSessionIds: async (ids: string[]) => {
      const { rows } = await client.query<{ from_id: string; to_id: string }>(
        `select from_id, to_id from links where link_type = 'spawned_from' and from_type = 'session' and to_type = 'session' and from_id = any($1)`,
        [ids]
      );
      return new Map(rows.map((r) => [r.from_id, r.to_id]));
    },
  };
});

vi.mock("../../capture-agent/submit-capture-graph.js", () => ({
  submitCaptureGraph: async (input: Record<string, unknown>) => {
    h.submits.push(input);
    const pod = input.filedByPod as {
      author: string;
      data: Record<string, unknown>;
    };
    const id = randomUUID();
    await h.client!.query(
      `insert into proposals (id, status, target_type, target_id, proposal_type, data, created_by, created_at)
       values ($1, 'pending', 'entity', $2, 'import.graph', $3::jsonb, $4, now())`,
      [
        id,
        randomUUID(),
        JSON.stringify({ ...pod.data, operations: [] }),
        pod.author,
      ]
    );
    return { proposalId: id, applied: false };
  },
}));

// The goal loop runs beside it on the same event: its start door proposes.
vi.mock("../../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: async (opts: Record<string, unknown>) => {
    h.permCalls.push(opts);
    return { granted: true };
  },
  proposedMessageFor: (_t: string, fallback: string) => fallback,
}));
vi.mock("../../playbooks/workers.js", () => ({
  listEnabledWorkers: vi.fn(async () => []),
}));
vi.mock("../../../notifications/NotificationService.js", () => ({
  NotificationService: { create: async () => randomUUID() },
}));
vi.mock("@synap/events", () => ({
  emitSideEffects: async () => undefined,
  registerReactor: () => {},
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  focusSessions,
  links,
  projects,
  projectTracks,
  proposals,
  sessionEvaluations,
  trackParticipants,
} from "@synap/database";
import {
  PATHWAY_REPLAN_AUTHOR,
  runPathwayReplan,
  sweepPathwayReplans,
} from "../pathway-replan.js";
import { goalLoopReactor } from "../goal-loop-reactor.js";

const OWNER = "user-owner";
const OTHER = "user-other";
const PROJECT = randomUUID();

const CRITERIA = [
  { key: "draft", statement: "The deck is drafted", check: { kind: "judge" } },
  {
    key: "polish",
    statement: "Copy polished",
    required: false,
    check: { kind: "judge" },
  },
];

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const def =
      c.name === "id"
        ? " default gen_random_uuid()"
        : c.name === "created_at" || c.name === "updated_at"
          ? " default now()"
          : c.name === "metadata"
            ? " default '{}'::jsonb"
            : "";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

async function goal(workKind: string | null = "pathway"): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into project_tracks (id, project_id, user_id, name, status, work_kind)
     values ($1, $2, $3, $4, 'active', $5)`,
    [id, PROJECT, OWNER, "Fund Synap", workKind]
  );
  return id;
}

async function step(
  goalId: string,
  opts: {
    title?: string;
    status?: string;
    owner?: string;
    report?: Record<string, unknown> | null;
    closedDaysAgo?: number;
  } = {}
): Promise<string> {
  const id = randomUUID();
  const ended = ["closed", "cancelled", "failed"].includes(
    opts.status ?? "active"
  );
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, track_id, project_id, status, title, goal, criteria, expected_outputs, verification_report, metadata, closed_at, created_at, updated_at)
     values ($1, $2, null, $3, $4, $5, $6, 'Raise the seed round', $7::jsonb, '[]'::jsonb, $8::jsonb, '{}'::jsonb,
             ${ended ? `now() - ($9::int * interval '1 day')` : "null"}, now(), now())`,
    [
      id,
      opts.owner ?? OWNER,
      goalId,
      PROJECT,
      opts.status ?? "active",
      opts.title ?? `Step ${id.slice(0, 4)}`,
      JSON.stringify(CRITERIA),
      opts.report ? JSON.stringify(opts.report) : null,
      ...(ended ? [opts.closedDaysAgo ?? 0] : []),
    ]
  );
  return id;
}

async function link(type: string, fromId: string, toId: string) {
  await q(
    `insert into links (id, from_type, from_id, to_type, to_id, link_type, metadata, created_at)
     values (gen_random_uuid(), 'session', $1, 'session', $2, $3, '{}'::jsonb, now())`,
    [fromId, toId, type]
  );
}

type Plan = {
  sessions: Array<Record<string, unknown>>;
  links?: Array<Record<string, unknown>>;
  edits?: Array<Record<string, unknown>>;
};
const lastPlan = () => h.submits.at(-1)!.plan as Plan;

beforeAll(async () => {
  for (const t of [
    focusSessions,
    links,
    projects,
    projectTracks,
    proposals,
    sessionEvaluations,
    trackParticipants,
  ]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
  await q(
    `insert into projects (id, user_id, workspace_id, name, status) values ($1, $2, null, 'Company', 'active')`,
    [PROJECT, OWNER]
  );
}, 120_000);

beforeEach(async () => {
  h.submits.length = 0;
  h.permCalls.length = 0;
});

describe("runPathwayReplan — ONE revision for a step that ended without delivering", () => {
  it("retries the step and moves the open steps waiting on it onto the retry", async () => {
    const g = await goal();
    const root = await step(g, { title: "Fund Synap" });
    const pitch = await step(g, { title: "Pitch deck", status: "cancelled" });
    await link("spawned_from", pitch, root);
    const meetings = await step(g, {
      title: "Investor meetings",
      status: "forming",
    });
    const done = await step(g, { title: "Old follow-up", status: "closed" });
    const foreign = await step(g, { title: "Their step", owner: OTHER });
    for (const dep of [meetings, done, foreign]) {
      await link("blocked_by", dep, pitch);
    }

    const r = await runPathwayReplan(g);

    expect(r).toMatchObject({ status: "proposed", replanFor: [pitch] });
    expect(h.submits).toHaveLength(1);
    const filed = h.submits[0]!;
    // Pending for a person: the pod files it, no agent key rides it.
    expect(filed.agentUserId).toBeUndefined();
    expect(filed.userId).toBe(OWNER);
    expect(filed.filedByPod).toEqual({
      author: PATHWAY_REPLAN_AUTHOR,
      data: { replanOf: g, replanFor: [pitch] },
    });
    expect(String(filed.summary)).toContain(
      '"Pitch deck" ended without delivering'
    );
    const plan = lastPlan();
    expect(plan.sessions).toEqual([
      {
        ref: `retry-${pitch}`,
        title: "Retry: Pitch deck",
        goal: "Raise the seed round",
        trackId: g,
        parentSessionId: root,
        // Its REQUIRED criteria, same keys; the optional one is not carried.
        criteria: [CRITERIA[0]],
      },
    ]);
    // Rules out: re-pointing a step that ended, or another owner's (the plan
    // door floors every edit on ONE owner).
    expect(plan.edits).toEqual([
      {
        op: "remove_link",
        type: "blocked_by",
        fromSessionId: meetings,
        toSessionId: pitch,
      },
    ]);
    expect(plan.links).toEqual([
      { type: "blocked_by", fromSessionId: meetings, toRef: `retry-${pitch}` },
    ]);
  });

  it("an expected end never fires it: delivered, or skipped as an arm not taken", async () => {
    // Rules out: re-planning on every close (P9 b), or on a branch not taken.
    const g = await goal();
    await step(g, { status: "closed" });
    await step(g, {
      status: "cancelled",
      report: {
        notTaken: {
          decisionId: randomUUID(),
          option: "b",
          chosenOption: "a",
          at: new Date().toISOString(),
        },
      },
    });
    expect(await runPathwayReplan(g)).toEqual({
      status: "held",
      hold: "nothing_ended",
    });
    expect(h.submits).toEqual([]);
  });

  it("a step closed anyway with required work open fires it", async () => {
    // Rules out: reading `closed` as delivered (founder, 2026-11-20).
    const g = await goal();
    const s = await step(g, {
      status: "closed",
      report: { closedNotDone: { reason: "criterion failed" } },
    });
    expect(await runPathwayReplan(g)).toMatchObject({
      status: "proposed",
      replanFor: [s],
    });
  });

  it("only a pathway: any other goal's ended step proposes nothing", async () => {
    const g = await goal("project");
    await step(g, { status: "failed" });
    expect(await runPathwayReplan(g)).toEqual({
      status: "held",
      hold: "not_pathway",
    });
    expect(h.submits).toEqual([]);
  });

  it("only ends of the budget window: history is never re-planned", async () => {
    const g = await goal();
    await step(g, { status: "cancelled", closedDaysAgo: 30 });
    expect(await runPathwayReplan(g)).toMatchObject({ hold: "nothing_ended" });
  });

  it("a step a person already replaced (`replaces`) is not re-planned again", async () => {
    const g = await goal();
    const s = await step(g, { status: "cancelled" });
    const instead = await step(g);
    await link("replaces", instead, s);
    expect(await runPathwayReplan(g)).toMatchObject({ hold: "nothing_ended" });
  });
});

describe("one pending per pathway, budgeted, never the same step twice", () => {
  it("holds while its revision waits; a step it named is never named again", async () => {
    const g = await goal();
    const a = await step(g, { status: "cancelled" });
    expect(await runPathwayReplan(g)).toMatchObject({ status: "proposed" });
    const b = await step(g, { status: "failed" });
    // Rules out: a second revision while the first waits on the person.
    expect(await runPathwayReplan(g)).toEqual({
      status: "held",
      hold: "proposal_pending",
    });
    // The person rejects it: they decided about `a`. Only `b` is re-planned.
    await q(
      `update proposals set status = 'rejected' where created_by = $1 and data->>'replanOf' = $2`,
      [PATHWAY_REPLAN_AUTHOR, g]
    );
    expect(await runPathwayReplan(g)).toMatchObject({
      status: "proposed",
      replanFor: [b],
    });
    expect(
      h.submits.map(
        (s) =>
          (s.filedByPod as { data: { replanFor: string[] } }).data.replanFor
      )
    ).toEqual([[a], [b]]);
  });

  it("the week's budget (the goal's own) caps it", async () => {
    const g = await goal();
    for (let i = 0; i < 3; i++) {
      await q(
        `insert into proposals (id, status, target_type, target_id, proposal_type, data, created_by, created_at)
         values (gen_random_uuid(), 'rejected', 'entity', gen_random_uuid(), 'import.graph', $1::jsonb, $2, now())`,
        [JSON.stringify({ replanOf: g, replanFor: [] }), PATHWAY_REPLAN_AUTHOR]
      );
    }
    await step(g, { status: "cancelled" });
    expect(await runPathwayReplan(g)).toEqual({
      status: "held",
      hold: "budget_used",
    });
  });

  it("a retry it proposed that ends without delivering too stops it", async () => {
    // Rules out: retrying forever (the goal loop stops after two tries).
    const g = await goal();
    const first = await step(g, { status: "cancelled", closedDaysAgo: 2 });
    const retry = await step(g, { status: "failed" });
    await q(
      `insert into proposals (id, status, target_type, target_id, proposal_type, data, created_by, created_at)
       values (gen_random_uuid(), 'approved', 'entity', gen_random_uuid(), 'import.graph', $1::jsonb, $2, now() - interval '8 days')`,
      [
        JSON.stringify({
          replanOf: g,
          replanFor: [first],
          materialized: {
            byOp: {
              [`retry-${first}`]: { op: "create_session", sessionId: retry },
            },
          },
        }),
        PATHWAY_REPLAN_AUTHOR,
      ]
    );
    expect(await runPathwayReplan(g)).toEqual({
      status: "held",
      hold: "stopped",
      stoppedOn: [retry],
    });
    expect(h.submits).toEqual([]);
  });
});

describe("its seams: the goal loop's", () => {
  it("a step's close reaches it through the goal-loop reactor", async () => {
    const g = await goal();
    const s = await step(g, { status: "cancelled" });
    await goalLoopReactor.handler(
      {
        subjectType: "focus_session",
        action: "closed",
        subjectId: s,
        userId: OWNER,
        data: { sessionId: s },
      } as never,
      {} as never
    );
    expect(h.submits).toHaveLength(1);
    expect(
      (h.submits[0]!.filedByPod as { data: { replanFor: string[] } }).data
        .replanFor
    ).toEqual([s]);
  });

  it("the hourly sweep reaches every active pathway", async () => {
    const g = await goal();
    await step(g, { status: "cancelled" });
    const swept = await sweepPathwayReplans();
    expect(swept.proposed).toBeGreaterThanOrEqual(1);
    expect(swept.failed).toBe(0);
    expect(
      h.submits.some(
        (s) =>
          (s.filedByPod as { data: { replanOf: string } }).data.replanOf === g
      )
    ).toBe(true);
  });
});
