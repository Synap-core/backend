/**
 * DECISION D1 (2026-09-26): a session's title/goal/status/progress is CONTENT.
 * Every session READ outside the focus-sessions doors — the run ledger, the run
 * detail's session card, the workflow place + feed, diagnose/resolve, the
 * proposal spine's session name, and the link write gate — goes through the ONE
 * session read rule, `sessionReadableWhere` (owner, or on a HUMAN door a human
 * seat on the session's own minted room).
 *
 * Driven through the REAL services on PGlite; nothing between the stored row
 * and the asserted field is hand-built.
 *
 * The cast, all in one workspace W (every one of them a workspace member):
 *   OWNER      — owns the playbook session S and the standalone session T.
 *   MEMBER     — human seat on S's and T's minted rooms.
 *   COLLEAGUE  — workspace member, NOT on either roster (the leak this pins).
 *   "agent key of MEMBER" — MEMBER with `roster: false`, which is what
 *                `rosterReadFor(ctx)` answers when `agentUserId` is set.
 *
 * The tRPC doors' `rosterReadFor(ctx)` wiring is driven through real callers
 * for `runs.*` and `workflows.*` (section 8). NOT driven through a caller:
 * `proposals.list/get` (the service is, with the same flag).
 *
 * What this CANNOT see: production Postgres (tables are generated from the
 * Drizzle definitions without FKs / NOT NULL / enums).
 * `diagnose/index.ts`'s own session branch is unreachable through the door
 * for a non-reader: `resolveObjectKind` refuses first (asserted below), so a
 * revert of that branch ALONE stays green here — defense in depth, noted.
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
  const db = drizzle(client, {
    // `proposals.source` reads through the relational builder.
    schema: {
      proposals: actual.proposals as never,
      focusSessions: actual.focusSessions as never,
      workspaceMembers: actual.workspaceMembers as never,
      workspaces: actual.workspaces as never,
    },
  });
  // graph hydration reads through `getDb()`, everything else through `db`.
  return { ...actual, db, getDb: async () => db };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { listRuns, getRun } from "../index.js";
import {
  getWorkflowPlace,
  getWorkflowPlaceFeed,
} from "../../workflow-place/index.js";
import { diagnoseRouter } from "../../diagnose/index.js";
import { resolveObjectKind } from "../../diagnose/resolve-object-kind.js";
import { enrichProposalsForDisplay } from "../../../routers/proposals/display.js";
import { checkLinkEndpointsVisible } from "../../../routers/hub-protocol/rest/link-endpoint-visibility.js";
import { runsRouter } from "../../../routers/runs.js";
import { hydrateNodes } from "../../object-graph/graph-service.js";
import { proposalsRouter } from "../../../routers/proposals.js";
import { workflowsRouter } from "../../../routers/workflows.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

const OWNER = "owner-d1";
const MEMBER = "member-d1";
const COLLEAGUE = "colleague-d1";
const WS = randomUUID();
const PROJECT = randomUUID();
const PLAYBOOK = randomUUID();
const S = randomUUID(); // playbook session (has a run row)
const T = randomUUID(); // standalone work session
const RUN = randomUUID();
const ROOM_S = randomUUID();
const ROOM_T = randomUUID();
const S_GOAL = "Close the Acme renewal";
const T_GOAL = "Draft the pricing memo";

/** Who is reading, and through which door. */
const HUMAN = { roster: true } as const;
const AGENT_KEY = { roster: false } as const;

function proposalRow(over: Record<string, unknown>) {
  const now = new Date();
  return {
    id: randomUUID(),
    status: "pending",
    proposalType: "create",
    targetType: "entity",
    targetId: randomUUID(),
    data: {},
    workspaceId: WS,
    projectId: null,
    threadId: null,
    sessionId: null,
    correlationId: null,
    agentUserId: null,
    subjectUserId: null,
    createdBy: OWNER,
    reviewedBy: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  } as never;
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  // Non-vacuity: every table the readers under test touch was created.
  for (const n of [
    "focus_sessions",
    "playbook_runs",
    "playbooks",
    "channels",
    "channel_members",
    "events",
    "users",
    "workspaces",
    "workspace_members",
    "links",
  ]) {
    expect(byName.has(n)).toBe(true);
  }
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  for (const u of [OWNER, MEMBER, COLLEAGUE]) {
    await q(`insert into users (id, user_type) values ($1, 'human')`, [u]);
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'editor')`,
      [randomUUID(), WS, u]
    );
  }
  await q(`insert into workspaces (id, name, owner_id) values ($1, 'W', $2)`, [
    WS,
    OWNER,
  ]);
  await q(
    `insert into playbooks (id, name, goal_template, workspace_id, status, version, executor, updated_at) values ($1, 'Renewals', 'g', $2, 'active', 1, 'agent', now())`,
    [PLAYBOOK, WS]
  );
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, project_id, playbook_id, goal, status, metadata, channel_id, progress, created_at, updated_at, started_at)
     values ($1, $2, $3, $4, $5, $6, 'active', '{}'::jsonb, $7, 40, now(), now(), now())`,
    [S, OWNER, WS, PROJECT, PLAYBOOK, S_GOAL, ROOM_S]
  );
  await q(
    `insert into focus_sessions (id, user_id, workspace_id, project_id, goal, status, metadata, channel_id, created_at, updated_at, started_at)
     values ($1, $2, $3, $4, $5, 'active', '{}'::jsonb, $6, now(), now(), now())`,
    [T, OWNER, WS, PROJECT, T_GOAL, ROOM_T]
  );
  await q(
    `insert into playbook_runs (id, workspace_id, playbook_id, session_id, status, summary, started_at)
     values ($1, $2, $3, $4, 'running', 'Renewal in flight', now())`,
    [RUN, WS, PLAYBOOK, S]
  );
  // Each session's OWN minted room: FK (channel_id) + stamp naming it.
  for (const [room, session] of [
    [ROOM_S, S],
    [ROOM_T, T],
  ]) {
    await q(
      `insert into channels (id, user_id, workspace_id, channel_type, context_object_type, context_object_id, created_at, updated_at)
       values ($1, $2, $3, 'group', 'focus_session', $4, now(), now())`,
      [room, OWNER, WS, session]
    );
    for (const m of [OWNER, MEMBER]) {
      await q(
        `insert into channel_members (id, channel_id, member_id, member_kind, role) values ($1, $2, $3, 'human', 'member')`,
        [randomUUID(), room, m]
      );
    }
  }
  await q(
    `insert into events (id, timestamp, type, subject_id, subject_type, data) values ($1, now(), 'focus_session.stage_advanced', $2, 'focus_session', $3::jsonb)`,
    [randomUUID(), S, JSON.stringify({ goal: S_GOAL })]
  );
});

// ── 1. listSessionRuns ───────────────────────────────────────────────────────
describe("run ledger — session runs", () => {
  const sessionRunIds = async (userId: string, door: { roster: boolean }) =>
    (await listRuns({ userId, flowType: "session", ...door })).map((r) => r.id);

  it("OMITS a colleague's session run", async () => {
    expect(await sessionRunIds(COLLEAGUE, HUMAN)).toEqual([]);
  });
  it("a roster human (human door) sees it; the owner always does", async () => {
    expect(await sessionRunIds(MEMBER, HUMAN)).toEqual([T]);
    expect(await sessionRunIds(OWNER, AGENT_KEY)).toEqual([T]);
  });
  it("the same member through an agent key sees none", async () => {
    expect(await sessionRunIds(MEMBER, AGENT_KEY)).toEqual([]);
  });
  it("getRun on a colleague's session is null (same as a missing id)", async () => {
    expect(
      await getRun({ userId: COLLEAGUE, flowType: "session", id: T, ...HUMAN })
    ).toBeNull();
    expect(
      (await getRun({ userId: MEMBER, flowType: "session", id: T, ...HUMAN }))
        ?.run.flowName
    ).toBe(T_GOAL);
  });
});

// ── 2. the playbook-run half (the 8th reader) ────────────────────────────────
describe("run ledger — playbook runs keep their row, never the session's", () => {
  const playbookRun = async (userId: string, door: { roster: boolean }) =>
    (await listRuns({ userId, flowType: "playbook", ...door })).find(
      (r) => r.id === RUN
    );

  it("a colleague sees the run but none of its session's room/project/subject/activity", async () => {
    const run = await playbookRun(COLLEAGUE, HUMAN);
    expect(run?.flowName).toBe("Renewals");
    expect(run?.channelId).toBeNull();
    expect(run?.projectId).toBeNull();
    expect(run?.lastActivityAt).toBeNull();
  });
  it("a roster human sees the session's room and project", async () => {
    const run = await playbookRun(MEMBER, HUMAN);
    expect(run?.channelId).toBe(ROOM_S);
    expect(run?.projectId).toBe(PROJECT);
    expect((await playbookRun(MEMBER, AGENT_KEY))?.channelId).toBeNull();
  });
  it("a project lens cannot be used as an oracle for where a colleague's session is filed", async () => {
    const lensed = (who: string) =>
      listRuns({
        userId: who,
        flowType: "playbook",
        scope: { projectId: PROJECT },
        ...HUMAN,
      });
    expect((await lensed(COLLEAGUE)).map((r) => r.id)).toEqual([]);
    expect((await lensed(MEMBER)).map((r) => r.id)).toEqual([RUN]);
  });
});

// ── 3. the run detail's session card ─────────────────────────────────────────
describe("run detail — session card", () => {
  const detail = (userId: string, door: { roster: boolean }) =>
    getRun({ userId, flowType: "playbook", id: RUN, ...door });

  it("a colleague gets no card and the private-session marker", async () => {
    const d = await detail(COLLEAGUE, HUMAN);
    expect(d?.playbookDetail?.session).toBeNull();
    expect(d?.playbookDetail?.sessionPrivate).toBe(true);
    expect(JSON.stringify(d)).not.toContain(S_GOAL);
  });
  it("a roster human gets the card; an agent key of the same member does not", async () => {
    const d = await detail(MEMBER, HUMAN);
    expect(d?.playbookDetail?.session?.goal).toBe(S_GOAL);
    expect(d?.playbookDetail?.sessionPrivate).toBe(false);
    expect(
      (await detail(MEMBER, AGENT_KEY))?.playbookDetail?.session
    ).toBeNull();
  });
});

// ── 4. workflow place + feed ─────────────────────────────────────────────────
describe("workflow place — sessions and their events", () => {
  const place = (userId: string, door: { roster: boolean }) =>
    getWorkflowPlace({ kind: "playbook", id: PLAYBOOK, userId, ...door });
  const feed = (userId: string, door: { roster: boolean }) =>
    getWorkflowPlaceFeed({ kind: "playbook", id: PLAYBOOK, userId, ...door });

  it("a colleague sees the playbook but not the session nor its events", async () => {
    const p = await place(COLLEAGUE, HUMAN);
    expect(p?.definition.name).toBe("Renewals");
    expect(p?.sessions).toEqual([]);
    expect(JSON.stringify(p)).not.toContain(S_GOAL);
    expect((await feed(COLLEAGUE, HUMAN)).items).toEqual([]);
  });
  it("a roster human sees both; an agent key of the same member sees neither", async () => {
    expect((await place(MEMBER, HUMAN))?.sessions.map((s) => s.id)).toEqual([
      S,
    ]);
    expect((await feed(MEMBER, HUMAN)).items.length).toBe(1);
    expect((await place(MEMBER, AGENT_KEY))?.sessions).toEqual([]);
    expect((await feed(MEMBER, AGENT_KEY)).items).toEqual([]);
  });
});

// ── 5. diagnose / resolve (agent doors: owner-only) ──────────────────────────
describe("diagnose + resolve — not found, identical to a nonexistent id", () => {
  it("resolve answers null for a colleague and for the member's agent key", async () => {
    expect(await resolveObjectKind(T, COLLEAGUE)).toBeNull();
    expect(await resolveObjectKind(T, MEMBER)).toBeNull();
    expect((await resolveObjectKind(T, OWNER))?.kind).toBe("session");
  });
  it("diagnose gives a colleague the same answer as a random id", async () => {
    const ghost = randomUUID();
    const mine = await diagnoseRouter({ userId: COLLEAGUE, id: T });
    const none = await diagnoseRouter({ userId: COLLEAGUE, id: ghost });
    expect(JSON.stringify(mine).replace(T, "X")).toBe(
      JSON.stringify(none).replace(ghost, "X")
    );
    expect(JSON.stringify(mine)).not.toContain(T_GOAL);
    expect(
      JSON.stringify(await diagnoseRouter({ userId: OWNER, id: T }))
    ).toContain(T_GOAL);
  });
});

// ── 6. proposal spine ────────────────────────────────────────────────────────
describe("proposal spine — the session name", () => {
  const spine = async (userId: string, door: { roster: boolean }) =>
    (
      await enrichProposalsForDisplay(
        [proposalRow({ sessionId: T })],
        userId,
        door
      )
    )[0] as unknown as { sessionGoal?: string; sessionPrivate?: true };

  it("a colleague gets the private marker and no title", async () => {
    const row = await spine(COLLEAGUE, HUMAN);
    expect(row.sessionPrivate).toBe(true);
    expect(row.sessionGoal).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain(T_GOAL);
  });
  it("a roster human gets the title; an agent key of the same member does not", async () => {
    const human = await spine(MEMBER, HUMAN);
    expect(human.sessionGoal).toBe(T_GOAL);
    expect(human.sessionPrivate).toBeUndefined();
    expect((await spine(MEMBER, AGENT_KEY)).sessionPrivate).toBe(true);
  });
  it("a session that does not exist is NOT called private", async () => {
    const [row] = (await enrichProposalsForDisplay(
      [proposalRow({ sessionId: randomUUID() })],
      COLLEAGUE,
      HUMAN
    )) as unknown as Array<{ sessionPrivate?: true }>;
    expect(row!.sessionPrivate).toBeUndefined();
  });
});

// ── 7. link write gate (agent doors: owner-only) ─────────────────────────────
describe("link write gate — refuses a session the caller cannot read", () => {
  const link = (userId: string) =>
    checkLinkEndpointsVisible(
      { fromType: "session", fromId: T, toType: "session", toId: T },
      userId,
      WS
    );
  it("refuses a colleague and the member's agent key; admits the owner", async () => {
    expect((await link(COLLEAGUE))?.status).toBe(404);
    expect((await link(MEMBER))?.status).toBe(404);
    expect(await link(OWNER)).toBeNull();
  });
});

// ── 8. the tRPC doors pass `rosterReadFor(ctx)` ──────────────────────────────
describe("human tRPC doors widen; the same user's agent key does not", () => {
  const ctx = (userId: string, agentUserId?: string) =>
    ({
      authenticated: true,
      userId,
      ...(agentUserId ? { agentUserId } : {}),
    }) as never;

  it("runs.list / runs.get", async () => {
    const human = runsRouter.createCaller(ctx(MEMBER));
    const agent = runsRouter.createCaller(ctx(MEMBER, "agent-of-member"));
    expect(
      (await human.list({ flowType: "session" })).runs.map((r) => r.id)
    ).toEqual([T]);
    expect((await agent.list({ flowType: "session" })).runs).toEqual([]);
    expect(
      (await human.get({ flowType: "playbook", id: RUN }))?.playbookDetail
        ?.session?.goal
    ).toBe(S_GOAL);
    expect(
      (await agent.get({ flowType: "playbook", id: RUN }))?.playbookDetail
        ?.sessionPrivate
    ).toBe(true);
  });

  it("workflows.place / workflows.placeFeed", async () => {
    const human = workflowsRouter.createCaller(ctx(MEMBER));
    const agent = workflowsRouter.createCaller(ctx(MEMBER, "agent-of-member"));
    const input = { kind: "playbook" as const, id: PLAYBOOK };
    expect((await human.place(input))?.sessions.map((s) => s.id)).toEqual([S]);
    expect((await agent.place(input))?.sessions).toEqual([]);
    expect((await human.placeFeed(input)).items.length).toBe(1);
    expect((await agent.placeFeed(input)).items).toEqual([]);
  });
});

// ── 9. graph node labels (hydration: owner-only) ─────────────────────────────
describe("graph — a session node is labelled only for its owner", () => {
  const label = async (userId: string) =>
    (
      await hydrateNodes(userId, [{ kind: "session", id: T }], {
        kind: "all",
      } as never)
    ).get(`session:${T}`)?.name;
  it("a colleague gets no node; the owner gets the goal", async () => {
    expect(await label(COLLEAGUE)).toBeUndefined();
    expect(await label(OWNER)).toBe(T_GOAL);
  });
});

// ── 10. proposals.source — the session target ────────────────────────────────
describe("proposals.source — a colleague's session is omitted, never named", () => {
  it("a colleague sees the proposal's sources without the session; a roster human sees it", async () => {
    const pid = randomUUID();
    await q(
      `insert into proposals (id, workspace_id, target_type, target_id, proposal_type, status, data, session_id, created_by, created_at, updated_at)
       values ($1, $2, 'entity', $3, 'create', 'pending', '{}'::jsonb, $4, $5, now(), now())`,
      [pid, WS, randomUUID(), T, OWNER]
    );
    const source = (userId: string) =>
      proposalsRouter
        .createCaller({ authenticated: true, userId } as never)
        .source({ proposalId: pid });
    const theirs = await source(COLLEAGUE);
    expect(JSON.stringify(theirs)).not.toContain(T_GOAL);
    expect(
      (theirs as { targets: Array<{ kind: string }> }).targets.map(
        (t) => t.kind
      )
    ).not.toContain("session");
    // A Hub Protocol caller (no `agentUserId`, e.g. `GET /proposals/:id`) is
    // an agent door: owner-only, like `AccessContext.from`.
    const hub = await proposalsRouter
      .createCaller({
        authenticated: true,
        userId: MEMBER,
        isHubProtocol: true,
      } as never)
      .source({ proposalId: pid });
    expect(JSON.stringify(hub)).not.toContain(T_GOAL);
    const member = await source(MEMBER);
    expect(
      (
        member as { targets: Array<{ kind: string; label: string }> }
      ).targets.find((t) => t.kind === "session")?.label
    ).toBe(T_GOAL);
  });
});
