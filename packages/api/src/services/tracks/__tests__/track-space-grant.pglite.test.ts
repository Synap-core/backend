/**
 * DECISION 2a — starting a track admits the agent working it into the track's
 * step spaces, SCOPED to that track. Driven on PGlite through the REAL
 * `checkPermissionOrPropose` (the join gate), the REAL `startTrack` /
 * `startStageSession` / `setTrackStatus`, the REAL `track/create` and
 * `focus_session/create` executors. Rows are read back (reachability).
 *
 *   G1 agent start → proposal whose summary states the consent → approve →
 *      the stage session in the step space starts with NO join request;
 *   G2 writes outside the track still hit the join gate: no track, a session
 *      in another space, a space the track does not name, another agent;
 *   G3 the grant ends when the track completes (and a reopen does not revive
 *      it) or is archived;
 *   G4 a person's own start admits the agent that works it.
 *
 * Stubbed at infrastructure seams only: side-effect emit, the event log
 * append, channel mint, realtime, block guidance, provenance links.
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

// The database package's own modules read `db` from client-pg, not the barrel.
vi.mock("../../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const d = await h.init();
  return {
    ...actual,
    db: d,
    getDb: async () => d,
    EventRepository: class {
      async append() {
        return { id: randomUUID() };
      }
      async emitCompleted() {}
    },
    eventRepository: {
      append: async () => ({ id: randomUUID() }),
      emitCompleted: async () => undefined,
    },
    resolveSessionProjectPlacement: async (
      _db: unknown,
      input: { explicitProjectId?: string | null }
    ) => ({ projectId: input.explicitProjectId ?? null }),
  };
});
vi.mock("@synap/events", () => ({ emitSideEffects: async () => {} }));
vi.mock("../../links/links-service.js", () => ({
  createLinks: async () => [],
  createLink: async () => ({}),
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
import * as schema from "@synap/database/schema";
import { checkPermissionOrPropose } from "../../../utils/permission-check.js";
import {
  setTrackStatus,
  startStageSession,
  startTrack,
} from "../tracks-service.js";
import { createFocusSession } from "../../focus-sessions/create-session.js";
import { proposalExecRegistry } from "../../../routers/proposals/execution-registry.js";
import { registerTrackExecutors } from "../../../routers/proposals/executors/track.js";
import { registerFocusSessionExecutors } from "../../../routers/proposals/executors/focus-session.js";
import type { ProposalExecutorArgs } from "../../../routers/proposals/execution-registry.js";

const USER = randomUUID();
const OTHER_USER = randomUUID();
const AGENT = randomUUID();
const OTHER_AGENT = randomUUID();
const HOME = randomUUID();
const STRAT = randomUUID();
const FIN = randomUUID();
const RES = randomUUID(); // a domain home the method never names
const METHOD = randomUUID();

const STAGES = [
  { key: "frame", name: "Frame", category: "planned", domain: "strategy" },
  { key: "fund", name: "Fund", category: "started", domain: "finance" },
  { key: "wrap", name: "Wrap", category: "completed" },
];

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const isArray = t.endsWith("[]");
    const base = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const type = isArray && !base.endsWith("[]") ? `${base}[]` : base;
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    let def = "";
    if (c.name === "created_at" || c.name === "updated_at")
      def = " default now()";
    else if (
      c.hasDefault &&
      c.default !== undefined &&
      typeof c.default !== "object"
    ) {
      const d = c.default as unknown;
      def =
        typeof d === "string"
          ? ` default '${d.replace(/'/g, "''")}'`
          : ` default ${String(d)}`;
    } else if (c.hasDefault && type === "jsonb") def = ` default '{}'::jsonb`;
    else if (c.hasDefault && type.endsWith("[]")) def = ` default '{}'`;
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const human = { userId: USER };
const agent = { userId: USER, agentUserId: AGENT, source: "mcp" };

async function newProject(): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into projects (id, user_id, workspace_id, name, status) values ($1, $2, $3, 'P', 'active')`,
    [id, USER, HOME]
  );
  return id;
}

async function joinRequests(workspaceId: string): Promise<number> {
  const { rows } = await q<{ n: number }>(
    `select count(*)::int as n from proposals where workspace_id = $1 and proposal_type = 'join'`,
    [workspaceId]
  );
  return rows[0]!.n;
}

async function trackGrant(trackId: string): Promise<Record<string, unknown>> {
  const { rows } = await q<{ g: Record<string, unknown> | null }>(
    `select metadata->'spaceGrant' as g from project_tracks where id = $1`,
    [trackId]
  );
  return rows[0]!.g ?? {};
}

async function approve(proposalId: string): Promise<void> {
  const { rows } = await q<Record<string, unknown>>(
    `select * from proposals where id = $1`,
    [proposalId]
  );
  const row = rows[0]!;
  const key = `${row.target_type}/${row.proposal_type}`;
  const exec = proposalExecRegistry.resolveExact(key);
  if (!exec) throw new Error(`no executor for ${key}`);
  await exec.execute({
    proposal: {
      id: row.id,
      targetType: row.target_type,
      targetId: row.target_id,
      proposalType: row.proposal_type,
      workspaceId: row.workspace_id,
      sessionId: row.session_id,
      projectId: row.project_id,
      subjectUserId: row.subject_user_id,
      correlationId: row.correlation_id,
      agentUserId: row.agent_user_id,
      data: row.data,
    },
    payload: null,
    userId: USER,
    input: { proposalId },
    ctx: {},
    deps: {
      reportProposalOutcome: () => {},
      emitProposalReviewed: () => {},
    },
  } as unknown as ProposalExecutorArgs);
}

/** An agent's start, approved by the person. Returns the track id. */
async function agentStartApproved(): Promise<{
  trackId: string;
  summary: string;
}> {
  const res = await startTrack({
    projectId: await newProject(),
    playbookId: METHOD,
    actor: agent,
  });
  if (res.status !== "proposed") throw new Error(`got ${res.status}`);
  const { rows } = await q<{ summary: string | null; data: unknown }>(
    `select data->>'summary' as summary, data from proposals where id = $1`,
    [res.proposalId]
  );
  await approve(res.proposalId);
  const { rows: t } = await q<{ id: string }>(
    `select id from project_tracks where id = $1`,
    [trackIdOf(rows[0]!.data)]
  );
  return { trackId: t[0]!.id, summary: String(rows[0]!.summary ?? "") };
}

/** The gate a write made FROM a session in `workspaceId` goes through. */
function sessionWrite(
  workspaceId: string,
  sessionId: string,
  agentUserId = AGENT,
  opts: { userId?: string; action?: "create" | "delete" } = {}
) {
  return checkPermissionOrPropose({
    userId: opts.userId ?? USER,
    agentUserId,
    workspaceId,
    sessionId,
    subjectType: "entity",
    action: opts.action ?? "create",
    data: { title: "A note", profileSlug: "note" },
  });
}

/** The id the track was filed under — wherever the proposal nests its payload. */
function trackIdOf(data: unknown): string {
  const d = data as { id?: string; data?: { id?: string } };
  return d?.data?.id ?? d?.id ?? "";
}

function proposalTypeOf(r: unknown): string | undefined {
  return (r as { proposalType?: string }).proposalType;
}

async function openStageSession(trackId: string, stageKey: string) {
  const res = await startStageSession({ trackId, stageKey, actor: agent });
  if (res.status === "proposed") {
    // Admitted past the JOIN — the normal ladder may still propose it.
    expect(res.proposalType).not.toBe("join");
    await approve(res.proposalId);
    const again = await startStageSession({ trackId, stageKey, actor: agent });
    if (again.status === "proposed") throw new Error("still proposed");
    return again.session;
  }
  return res.session;
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  await q(
    `insert into users (id, email, name, user_type) values
      ($1, 'u@x.test', 'Ada', 'human'),
      ($2, 'a@x.test', 'Scout', 'agent'),
      ($3, 'b@x.test', 'Other', 'agent'),
      ($4, 'o@x.test', 'Bo', 'human')`,
    [USER, AGENT, OTHER_AGENT, OTHER_USER]
  );
  let minute = 0;
  for (const [id, name, slug] of [
    [HOME, "Home", null],
    [STRAT, "Strategy", "strategy"],
    [FIN, "Finance", "finance"],
    [RES, "Research", "research"],
  ] as const) {
    await q(
      `insert into workspaces (id, name, owner_id, workspace_type, package_slug, settings, created_at)
       values ($1, $2, $3, 'personal', $4, '{}'::jsonb, now() + ($5 || ' minutes')::interval)`,
      [id, name, USER, slug, String(minute++)]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
      [randomUUID(), id, USER]
    );
  }
  // Both agents belong to HOME only — every step space is a membership MISS.
  for (const a of [AGENT, OTHER_AGENT]) {
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'editor')`,
      [randomUUID(), HOME, a]
    );
  }
  await q(
    `insert into playbooks (id, workspace_id, created_by, name, goal_template, params, input_strategy, channel_spec, expected_outputs, stages, criteria, version, executor, status, scope, metadata, created_at, updated_at)
     values ($1, null, $2, 'Launch', 'Launch it', '[]', '{"kind":"none"}', '{}', '[]', $3::jsonb, '[]', 1, 'is-agent', 'active', 'project', '{}', now(), now())`,
    [METHOD, USER, JSON.stringify(STAGES)]
  );
  registerTrackExecutors();
  registerFocusSessionExecutors();
}, 120_000);

describe("G0 baseline — an agent that is not a member is join-gated", () => {
  it("a session write into Strategy with no track files a JOIN", async () => {
    const res = await createFocusSession({
      userId: USER,
      agentUserId: AGENT,
      workspaceId: STRAT,
      goal: "Unrelated strategy work",
    });
    expect(res.status).toBe("proposed");
    expect((res as { proposalType?: string }).proposalType).toBe("join");
  });
});

describe("G1 agent start → approve → stage session in the step space", () => {
  it("the proposal states the consent, the approval stamps the grant, and the stage session starts with no join", async () => {
    const before = await joinRequests(STRAT);
    const { trackId, summary } = await agentStartApproved();
    expect(summary).toBe(
      'Create Track "Launch" and let Scout work in Strategy, Finance for this track'
    );
    const grant = await trackGrant(trackId);
    expect(grant).toMatchObject({
      operatorUserId: USER,
      agentUserIds: [AGENT],
      workspaceIds: [STRAT, FIN],
      grantedBy: USER,
    });
    expect(grant.proposalId).toEqual(expect.any(String));
    expect(grant.endedAt).toBeUndefined();

    const session = await openStageSession(trackId, "frame");
    expect(session.workspaceId).toBe(STRAT);
    expect(session.trackId).toBe(trackId);
    // A write made FROM that session into its space: admitted past the join.
    expect(proposalTypeOf(await sessionWrite(STRAT, session.id))).not.toBe(
      "join"
    );
    expect(await joinRequests(STRAT)).toBe(before);
  });
});

describe("G1b consent is what the person read", () => {
  it("approval grants only the spaces the proposal LISTED (a narrowed payload never widens back)", async () => {
    const res = await startTrack({
      projectId: await newProject(),
      playbookId: METHOD,
      actor: agent,
    });
    if (res.status !== "proposed") throw new Error(`got ${res.status}`);
    // The payload the person approves lists Strategy only.
    await q(
      `update proposals set data = jsonb_set(data, '{data,spaceGrant,spaces}', $2::jsonb) where id = $1`,
      [
        res.proposalId,
        JSON.stringify([{ workspaceId: STRAT, name: "Strategy" }]),
      ]
    );
    const { rows } = await q<{ data: unknown }>(
      `select data from proposals where id = $1`,
      [res.proposalId]
    );
    await approve(res.proposalId);
    expect(await trackGrant(trackIdOf(rows[0]!.data))).toMatchObject({
      workspaceIds: [STRAT],
    });
  });
});

describe("G2 writes outside the track still hit the join gate", () => {
  it("a session of the track writing into a space the track does not name (Research)", async () => {
    const { trackId } = await agentStartApproved();
    const session = await openStageSession(trackId, "frame");
    expect(proposalTypeOf(await sessionWrite(RES, session.id))).toBe("join");
  });

  it("a session of the track writing into ANOTHER step space than its own (Finance from a Strategy step)", async () => {
    const { trackId } = await agentStartApproved();
    const session = await openStageSession(trackId, "frame");
    expect(proposalTypeOf(await sessionWrite(FIN, session.id))).toBe("join");
  });

  it("a stage session filed at a step that names another space", async () => {
    const { trackId } = await agentStartApproved();
    // Step "frame" names strategy — starting it into Finance is not the step's space.
    const res = await createFocusSession({
      userId: USER,
      agentUserId: AGENT,
      workspaceId: FIN,
      projectId: null,
      trackId,
      trackStage: "frame",
      goal: "Frame in the wrong space",
    });
    expect((res as { proposalType?: string }).proposalType).toBe("join");
  });

  it("another agent working the same track is not admitted", async () => {
    const { trackId } = await agentStartApproved();
    const session = await openStageSession(trackId, "frame");
    expect(
      proposalTypeOf(await sessionWrite(STRAT, session.id, OTHER_AGENT))
    ).toBe("join");
  });

  it("a session filed at the step but sitting in ANOTHER space (the project's home) cannot reach the step space", async () => {
    const { trackId } = await agentStartApproved();
    const [{ project_id }] = (
      await q<{ project_id: string }>(
        `select project_id from project_tracks where id = $1`,
        [trackId]
      )
    ).rows;
    const res = await createFocusSession({
      userId: USER,
      workspaceId: HOME,
      projectId: project_id,
      trackId,
      trackStage: "frame",
      goal: "Frame from home",
    });
    if (res.status === "proposed") throw new Error("human create proposed");
    expect(res.session.workspaceId).toBe(HOME);
    expect(proposalTypeOf(await sessionWrite(STRAT, res.session.id))).toBe(
      "join"
    );
  });

  it("the same agent acting for ANOTHER person is not admitted", async () => {
    const { trackId } = await agentStartApproved();
    const session = await openStageSession(trackId, "frame");
    expect(
      proposalTypeOf(
        await sessionWrite(STRAT, session.id, AGENT, { userId: OTHER_USER })
      )
    ).toBe("join");
  });

  it("a write needing more than an editor (delete) is not admitted", async () => {
    const { trackId } = await agentStartApproved();
    const session = await openStageSession(trackId, "frame");
    expect(
      proposalTypeOf(
        await sessionWrite(STRAT, session.id, AGENT, { action: "delete" })
      )
    ).toBe("join");
  });

  it("a write with no session (outside the track's sessions)", async () => {
    await agentStartApproved();
    const res = await checkPermissionOrPropose({
      userId: USER,
      agentUserId: AGENT,
      workspaceId: STRAT,
      subjectType: "entity",
      action: "create",
      data: { title: "Loose note", profileSlug: "note" },
    });
    expect(proposalTypeOf(res)).toBe("join");
  });
});

describe("G3 the grant ends with the track", () => {
  it("completing ends it (stamped), and reopening does not revive it", async () => {
    const { trackId } = await agentStartApproved();
    const session = await openStageSession(trackId, "frame");
    expect(proposalTypeOf(await sessionWrite(STRAT, session.id))).not.toBe(
      "join"
    );

    expect(
      (await setTrackStatus({ trackId, status: "completed", actor: human }))
        .status
    ).toBe("updated");
    expect(await trackGrant(trackId)).toMatchObject({
      endedReason: "completed",
      endedAt: expect.any(String),
    });
    expect(proposalTypeOf(await sessionWrite(STRAT, session.id))).toBe("join");

    await setTrackStatus({ trackId, status: "active", actor: human });
    expect(proposalTypeOf(await sessionWrite(STRAT, session.id))).toBe("join");
  });

  it("archiving ends it", async () => {
    const { trackId } = await agentStartApproved();
    const session = await openStageSession(trackId, "frame");
    await setTrackStatus({ trackId, status: "archived", actor: human });
    expect(await trackGrant(trackId)).toMatchObject({
      endedReason: "archived",
    });
    expect(proposalTypeOf(await sessionWrite(STRAT, session.id))).toBe("join");
  });
});

describe("G4 a person's own start", () => {
  it("admits the agent that works it, into the step spaces only", async () => {
    const res = await startTrack({
      projectId: await newProject(),
      playbookId: METHOD,
      actor: human,
    });
    if (res.status === "proposed") throw new Error("human start proposed");
    expect(await trackGrant(res.track.id)).toMatchObject({
      operatorUserId: USER,
      agentUserIds: null,
      workspaceIds: [STRAT, FIN],
    });
    const session = await openStageSession(res.track.id, "fund");
    expect(session.workspaceId).toBe(FIN);
    expect(proposalTypeOf(await sessionWrite(FIN, session.id))).not.toBe(
      "join"
    );
    expect(proposalTypeOf(await sessionWrite(RES, session.id))).toBe("join");
  });
});
