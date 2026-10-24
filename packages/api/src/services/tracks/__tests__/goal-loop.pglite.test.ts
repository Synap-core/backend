/**
 * THE GOAL LOOP on PGlite (work model W4) — the REAL `runGoalLoop`, the REAL
 * runs read (`loadGoalRuns` → `deriveGoalCriteria`), the REAL session start
 * door (`createFocusSession`, whose gate payload is what the person reviews),
 * the REAL goal write door (`setTrackDirection`, `startTrack`), the REAL
 * event reactor and the REAL sweep. Rows are read back from PGlite.
 *
 * Stubbed, only at infrastructure seams: `checkPermissionOrPropose` — a
 * stand-in that PROPOSES for an agent or a forced proposal (inserting the
 * pending row the real door would, so the loop's own counts read it) and
 * GRANTS a person; the notification write (it inserts the row, so the once-
 * per-stop check reads it); `emitSideEffects`; realtime; the session channel.
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
  permCalls: [] as Array<Record<string, unknown>>,
  emits: [] as Array<Record<string, unknown>>,
  notifications: [] as Array<Record<string, unknown>>,
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
      playbooks: actual.playbooks as never,
      projects: actual.projects as never,
    },
  });
  return {
    ...actual,
    db: pg,
    getDb: async () => pg,
    EventRepository: class {
      async append() {}
    },
    recordSessionSpawn: async () => ({
      linked: true,
      suspendedIntentRecorded: false,
    }),
    resolveSessionProjectPlacement: async (
      _db: unknown,
      input: { explicitProjectId?: string | null }
    ) => ({ projectId: input.explicitProjectId ?? null }),
  };
});

vi.mock("../../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: async (opts: Record<string, unknown>) => {
    h.permCalls.push(opts);
    if (opts.agentUserId || opts.forcePropose) {
      const id = randomUUID();
      await h.client!.query(
        `insert into proposals (id, status, target_type, target_id, proposal_type, data, created_at)
         values ($1, 'pending', $2, $3, $4, $5::jsonb, now())`,
        [
          id,
          opts.subjectType,
          (opts.data as { id?: string })?.id ?? id,
          opts.action,
          JSON.stringify({ data: opts.data }),
        ]
      );
      return {
        granted: false,
        proposalId: id,
        proposalType: `${opts.subjectType}.${opts.action}`,
        summary: "",
        reasoning: "",
        reviewPath: "/open/x",
        reviewUrl: "https://pod/open/x",
      };
    }
    return { granted: true };
  },
  proposedMessageFor: (_t: string, fallback: string) => fallback,
}));
vi.mock("../../../utils/event-backed-proposal.js", () => ({
  createEventBackedProposal: async () => ({
    proposal: { id: randomUUID(), status: "pending" },
  }),
}));
vi.mock("../../../notifications/NotificationService.js", () => ({
  NotificationService: {
    create: async (input: Record<string, unknown>) => {
      h.notifications.push(input);
      await h.client!.query(
        `insert into notifications (id, user_id, type, group_key, title, body, created_at)
         values (gen_random_uuid(), $1, $2, $3, 't', 'b', now())`,
        [input.userId, input.type, input.groupKey]
      );
      return randomUUID();
    },
  },
}));
vi.mock("../../links/links-service.js", () => ({
  createLinks: async () => [],
}));
vi.mock("@synap/events", () => ({
  emitSideEffects: async (p: Record<string, unknown>) => {
    h.emits.push(p);
  },
  registerReactor: () => {},
}));
vi.mock("../../focus-sessions/ensure-session-channel.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  ensureSessionChannel: async () => null,
}));
vi.mock("../../../utils/domain-event-bridge.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  emitHubRealtimeEvent: () => undefined,
}));
vi.mock("../../focus-sessions/block-guidelines.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  guidanceForBlockedSlots: async () => undefined,
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  focusSessions,
  notifications,
  playbooks,
  projects,
  projectTracks,
  proposals,
  workspaces,
  workspaceMembers,
  users,
  links,
  sessionEvaluations,
  podMembers,
  projectMembers,
  trackParticipants,
} from "@synap/database";
import { runGoalLoop, sweepGoalLoops } from "../goal-loop.js";
import { goalLoopReactor } from "../goal-loop-reactor.js";
import { setTrackDirection, startTrack } from "../tracks-service.js";

const OWNER = "user-owner";
const STARTER = "user-starter";
const JUDGE = "user-judge";
const AGENT = "agent-1";
const PROJECT = randomUUID();

const CRITERIA = [
  {
    key: "pages",
    statement: "All 12 pages migrated",
    check: { kind: "judge" },
  },
  {
    key: "links",
    statement: "No broken links",
    check: { kind: "judge" },
  },
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
        : c.name === "started_at" ||
            c.name === "created_at" ||
            c.name === "updated_at"
          ? " default now()"
          : c.name === "metadata" ||
              c.name === "definition_snapshot" ||
              c.name === "params"
            ? " default '{}'::jsonb"
            : c.name === "stage_history"
              ? " default '[]'::jsonb"
              : c.name === "method_version"
                ? " default '1'"
                : "";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

async function goal(opts: {
  name?: string;
  status?: string;
  loop?: Record<string, unknown> | null;
  criteria?: unknown[] | null;
  endState?: string | null;
}): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into project_tracks (id, project_id, user_id, name, status, criteria, end_state, loop)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb)`,
    [
      id,
      PROJECT,
      OWNER,
      opts.name ?? `Goal ${id.slice(0, 6)}`,
      opts.status ?? "active",
      opts.criteria === null ? null : JSON.stringify(opts.criteria ?? CRITERIA),
      opts.endState ?? "The new site is live",
      opts.loop === null
        ? null
        : JSON.stringify(opts.loop ?? { on: true, perWeek: 3 }),
    ]
  );
  return id;
}

async function run(
  goalId: string,
  status: string,
  grades: Array<{
    key: string;
    verdict: "pass" | "fail";
    kind?: "judge" | "human";
    at?: string;
  }> = []
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, track_id, project_id, status, goal, criteria, expected_outputs, metadata, created_at, updated_at)
     values ($1, $2, null, $3, $4, $5, 'work', $6::jsonb, '[]'::jsonb, '{}'::jsonb, now(), now())`,
    [id, OWNER, goalId, PROJECT, status, JSON.stringify(CRITERIA)]
  );
  for (const g of grades) {
    await q(
      `insert into session_evaluations (id, session_id, user_id, criterion_key, attempt, verdict, evaluator_kind, evaluator_id, evidence, created_at)
       values (gen_random_uuid(), $1, $2, $3, 1, $4, $5, $6, '{}'::jsonb, $7)`,
      [
        id,
        OWNER,
        g.key,
        g.verdict,
        g.kind ?? "judge",
        g.kind === "human" ? OWNER : "model-x",
        g.at ?? new Date().toISOString(),
      ]
    );
  }
  return id;
}

function loopCalls() {
  return h.permCalls.filter(
    (c) => (c.data as { goalLoopOf?: string } | undefined)?.goalLoopOf
  );
}

beforeAll(async () => {
  for (const t of [
    focusSessions,
    notifications,
    proposals,
    users,
    workspaces,
    workspaceMembers,
    links,
    playbooks,
    projects,
    projectTracks,
    sessionEvaluations,
    podMembers,
    projectMembers,
    // Who is on a goal (W3): the owner seat the loop asks; `startTrack` seeds it.
    trackParticipants,
  ]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
  await q(
    `insert into users (id, email) values ($1, 'o@x.test'), ($2, 's@x.test'), ($3, 'j@x.test')`,
    [OWNER, STARTER, JUDGE]
  );
  await q(
    `insert into projects (id, user_id, workspace_id, name, status) values ($1, $2, null, 'Website', 'active')`,
    [PROJECT, OWNER]
  );
}, 120_000);

beforeEach(() => {
  h.permCalls.length = 0;
  h.emits.length = 0;
  h.notifications.length = 0;
});

describe("runGoalLoop — proposes the next run", () => {
  it("proposes ONE run filed into the goal, carrying every unmet criterion by the same key", async () => {
    const id = await goal({ name: "Migrate the site" });
    const r = await runGoalLoop(id);
    expect(r).toMatchObject({
      status: "proposed",
      carry: ["pages", "links", "polish"],
    });
    const [call] = loopCalls();
    // Rules out: a run STARTED in the owner's name (no forced proposal).
    expect(call).toMatchObject({
      userId: OWNER,
      subjectType: "focus_session",
      action: "create",
      forcePropose: true,
    });
    expect(call!.agentUserId).toBeUndefined();
    const data = call!.data as Record<string, unknown>;
    expect(data).toMatchObject({
      trackId: id,
      goalLoopOf: id,
      title: "Next run: Migrate the site",
    });
    // The SAME keys as the goal's — so the goal's marks count the run's grades.
    expect((data.criteria as Array<{ key: string }>).map((c) => c.key)).toEqual(
      ["pages", "links", "polish"]
    );
    // The goal's end state rides as the run's brief.
    expect(String(data.goal)).toContain(
      "What done looks like: The new site is live"
    );
    expect(String(data.goal)).toContain("- No broken links");
    // No session was written: a proposal only.
    const { rows } = await q(
      `select id from focus_sessions where track_id = $1`,
      [id]
    );
    expect(rows).toHaveLength(0);
  });

  it("one pending at a time", async () => {
    const id = await goal({});
    expect((await runGoalLoop(id)).status).toBe("proposed");
    // Rules out: a second proposal while the first waits on a person.
    expect(await runGoalLoop(id)).toMatchObject({
      status: "held",
      hold: "proposal_pending",
    });
    expect(loopCalls()).toHaveLength(1);
  });

  it("spends at most perWeek proposals in seven days, whatever became of them", async () => {
    const id = await goal({ loop: { on: true, perWeek: 2 } });
    for (let i = 0; i < 2; i++) {
      expect((await runGoalLoop(id)).status).toBe("proposed");
      // A person declines it: no longer pending, still counted.
      await q(
        `update proposals set status = 'rejected' where data->'data'->>'goalLoopOf' = $1`,
        [id]
      );
    }
    expect(await runGoalLoop(id)).toMatchObject({
      status: "held",
      hold: "budget_used",
    });
    // A proposal older than the window no longer counts.
    await q(
      `update proposals set created_at = now() - interval '8 days' where data->'data'->>'goalLoopOf' = $1`,
      [id]
    );
    expect((await runGoalLoop(id)).status).toBe("proposed");
  });

  it("carries only what is not met — a person's pass is met", async () => {
    const id = await goal({});
    await run(id, "closed", [
      { key: "pages", verdict: "pass", kind: "human" },
      { key: "links", verdict: "fail" },
    ]);
    expect(await runGoalLoop(id)).toMatchObject({
      status: "proposed",
      carry: ["links", "polish"],
    });
    // Rules out: the run carrying a met criterion (asserted on the payload a
    // person approves, not on the decision).
    const data = loopCalls().at(-1)!.data as {
      criteria: Array<{ key: string }>;
      goal: string;
    };
    expect(data.criteria.map((c) => c.key)).toEqual(["links", "polish"]);
    expect(data.goal).not.toContain("All 12 pages migrated");
  });

  it("holds while a run filed into the goal is open", async () => {
    const id = await goal({});
    await run(id, "active");
    expect(await runGoalLoop(id)).toMatchObject({ hold: "run_open" });
  });

  it("holds when only an optional criterion is unmet", async () => {
    const id = await goal({});
    await run(id, "closed", [
      { key: "pages", verdict: "pass", kind: "human" },
      { key: "links", verdict: "pass", kind: "human" },
    ]);
    expect(await runGoalLoop(id)).toMatchObject({ hold: "nothing_unmet" });
  });

  it("holds when the loop is off, never set, or the goal is not active", async () => {
    expect(
      await runGoalLoop(await goal({ loop: { on: false } }))
    ).toMatchObject({ hold: "loop_off" });
    // Rules out: an existing goal (no loop stored) proposing after deploy.
    expect(await runGoalLoop(await goal({ loop: null }))).toMatchObject({
      hold: "loop_off",
    });
    expect(await runGoalLoop(await goal({ status: "paused" }))).toMatchObject({
      hold: "not_active",
    });
    expect(await runGoalLoop(await goal({ criteria: null }))).toMatchObject({
      hold: "no_criteria",
    });
    expect(loopCalls()).toHaveLength(0);
  });
});

describe("runGoalLoop — stops and asks after the same criterion fails twice", () => {
  it("stops, asks the owner ONCE, and starts again when the loop is switched on again", async () => {
    const id = await goal({
      name: "Fix the links",
      loop: { on: true, perWeek: 3, onAt: "2026-01-01T00:00:00.000Z" },
    });
    const first = await run(id, "closed", [
      { key: "links", verdict: "fail", at: "2026-10-01T10:00:00.000Z" },
    ]);
    const second = await run(id, "closed", [
      { key: "links", verdict: "fail", at: "2026-10-02T10:00:00.000Z" },
    ]);

    const r = await runGoalLoop(id);
    expect(r).toMatchObject({
      status: "held",
      hold: "stopped",
      stoppedOn: [{ key: "links", sessionIds: [first, second] }],
    });
    expect(loopCalls()).toHaveLength(0);
    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0]).toMatchObject({
      type: "track.loop_stopped",
      userId: OWNER,
      sourceType: "track",
      sourceId: id,
      data: {
        trackName: "Fix the links",
        criterionStatement: "No broken links",
        runs: 2,
      },
    });

    // The hourly re-check reads the same stop: no second ask.
    await runGoalLoop(id);
    expect(h.notifications).toHaveLength(1);

    // The owner switches the loop on again ("try again") through the door.
    const res = await setTrackDirection({
      trackId: id,
      loop: { on: true },
      actor: { userId: OWNER },
    });
    expect(res.status).toBe("updated");
    expect(await runGoalLoop(id)).toMatchObject({ status: "proposed" });
  });
});

describe("the goal write door — the loop is a person's switch", () => {
  it("a person's switch-on applies, stamped with who and when", async () => {
    const id = await goal({ loop: null });
    const res = await setTrackDirection({
      trackId: id,
      loop: { on: true, perWeek: 5 },
      actor: { userId: OWNER },
    });
    expect(res.status).toBe("updated");
    const [row] = (
      await q<{ loop: Record<string, unknown> }>(
        `select loop from project_tracks where id = $1`,
        [id]
      )
    ).rows;
    expect(row!.loop).toMatchObject({ on: true, perWeek: 5, by: OWNER });
    expect(typeof row!.loop.onAt).toBe("string");
    // The switch-on reaches the loop through its event seam.
    expect(h.emits).toContainEqual(
      expect.objectContaining({
        subjectType: "track",
        action: "update",
        data: expect.objectContaining({ trackId: id, loop: "on" }),
      })
    );
  });

  it("an agent's switch-on is ALWAYS a proposal (forced), never applied", async () => {
    const id = await goal({ loop: null });
    const res = await setTrackDirection({
      trackId: id,
      loop: { on: true },
      actor: { userId: OWNER, agentUserId: AGENT, isHubProtocol: true },
    });
    expect(res.status).toBe("proposed");
    const call = h.permCalls.find((c) => (c.data as { id?: string }).id === id);
    expect(call).toMatchObject({ forcePropose: true });
    const [row] = (
      await q<{ loop: unknown }>(
        `select loop from project_tracks where id = $1`,
        [id]
      )
    ).rows;
    expect(row!.loop).toBeNull();
  });

  it("a new goal with criteria is born with its loop OFF (GOAL_LOOP_DEFAULT_ON)", async () => {
    const res = await startTrack({
      projectId: PROJECT,
      name: "Born today",
      criteria: CRITERIA.slice(0, 2),
      actor: { userId: OWNER },
    });
    expect(res.status).toBe("started");
    const [row] = (
      await q<{ id: string; loop: unknown }>(
        `select id, loop from project_tracks where name = 'Born today'`
      )
    ).rows;
    expect(row!.loop).toBeNull();
    expect(await runGoalLoop(row!.id)).toMatchObject({ hold: "loop_off" });
  });
});

describe("the person the loop asks is the goal's OWNER seat", () => {
  it("proposes in the owner's name and asks the owner — not the starter, not the judge", async () => {
    // Rules out: `project_tracks.user_id` (the starter) or the judge seat
    // answering "who owns this goal".
    const id = await goal({ name: "Owned by the seat" });
    await q(`update project_tracks set user_id = $1 where id = $2`, [
      STARTER,
      id,
    ]);
    for (const [who, role] of [
      [OWNER, "owner"],
      [JUDGE, "judge"],
    ] as const) {
      await q(
        `insert into track_participants (id, track_id, principal_kind, principal_id, role, decided_by, created_at)
         values (gen_random_uuid(), $1, 'person', $2, $3, $2, now())`,
        [id, who, role]
      );
    }
    expect((await runGoalLoop(id)).status).toBe("proposed");
    expect(loopCalls().at(-1)).toMatchObject({ userId: OWNER });

    await q(
      `update proposals set status = 'rejected' where data->'data'->>'goalLoopOf' = $1`,
      [id]
    );
    await run(id, "closed", [
      { key: "links", verdict: "fail", at: "2026-10-03T10:00:00.000Z" },
    ]);
    await run(id, "closed", [
      { key: "links", verdict: "fail", at: "2026-10-04T10:00:00.000Z" },
    ]);
    expect(await runGoalLoop(id)).toMatchObject({ hold: "stopped" });
    expect(h.notifications.at(-1)).toMatchObject({
      type: "track.loop_stopped",
      userId: OWNER,
    });
  });
});

describe("the seams that run it", () => {
  it("a run of the goal closing makes it propose its next run", async () => {
    const id = await goal({});
    const closed = await run(id, "closed", [{ key: "pages", verdict: "fail" }]);
    await goalLoopReactor.handler(
      {
        subjectType: "focus_session",
        action: "closed",
        subjectId: closed,
        userId: OWNER,
        workspaceId: null,
        data: { sessionId: closed },
      } as never,
      {} as never
    );
    expect(loopCalls()).toHaveLength(1);
    expect((loopCalls()[0]!.data as { trackId: string }).trackId).toBe(id);
  });

  it("the hourly sweep re-checks every active goal whose loop is on", async () => {
    const id = await goal({ name: "Swept" });
    const off = await goal({ name: "Not swept", loop: { on: false } });
    const r = await sweepGoalLoops();
    expect(r.failed).toBe(0);
    const proposedFor = loopCalls().map(
      (c) => (c.data as { trackId: string }).trackId
    );
    expect(proposedFor).toContain(id);
    expect(proposedFor).not.toContain(off);
  });
});
