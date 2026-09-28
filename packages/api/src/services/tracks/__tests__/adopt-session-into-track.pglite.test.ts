/**
 * ADOPT an existing session into a track step — driven through the REAL
 * `updateFocusSession` (the MCP `update_session` door), the REAL
 * `focus_session/update` executor, the REAL `resolveSessionTrackFiling` +
 * tracks-service rules and the REAL project-path / stage-count reads, on
 * PGlite. Rows are read back (reachability, not shape).
 *
 * Stubbed, at infrastructure seams only: `checkPermissionOrPropose` (records
 * the call; proposes when `forcePropose` is set, so the agent path is
 * asserted), channel mint, realtime emit, block guidance. The proposal TITLE
 * is asserted with the REAL `buildProposalSummary` over the REAL gate payload.
 *
 * NOT covered here (typecheck only): the tRPC and Hub PATCH wrappers — they
 * call the same `resolveSessionTrackFiling` / `stampTrackFilingUses`.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
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
  return { ...actual, db: await h.init(), getDb: async () => h.init() };
});

const { permSpy } = vi.hoisted(() => ({
  permSpy: vi.fn(
    async (_args: Record<string, unknown>) => ({}) as Record<string, unknown>
  ),
}));
vi.mock("../../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: permSpy,
  proposedMessageFor: (_t: unknown, fallback: string) => fallback,
}));
vi.mock("../../focus-sessions/ensure-session-channel.js", () => ({
  ensureSessionChannel: vi.fn(async () => null),
}));
vi.mock("../../../utils/domain-event-bridge.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  emitHubRealtimeEvent: vi.fn(),
}));
vi.mock("../../focus-sessions/block-guidelines.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  guidanceForBlockedSlots: vi.fn(async () => undefined),
}));
vi.mock("@synap/events", () => ({ emitSideEffects: async () => undefined }));

import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { updateFocusSession } from "../../focus-sessions/update-session.js";
import { registerFocusSessionExecutors } from "../../../routers/proposals/executors/focus-session.js";
import { proposalExecRegistry } from "../../../routers/proposals/execution-registry.js";
import { buildProposalSummary } from "../../../utils/permission-check.js";
import { countTrackSessionsByStage } from "../tracks-service.js";
import { getProjectPath } from "../../projects/project-path.js";

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
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const USER = "user-1";
const OTHER = "user-2";
const AGENT = randomUUID();
const GOAL = "Define the Architech offer and ICP";

const STAGES = [
  { key: "offer", name: "Offer & buyer" },
  { key: "pricing", name: "Pricing" },
  { key: "crm", name: "Pipeline", domain: "crm-template" },
];

async function seedProject(owner = USER, name = "Launch The Architech") {
  const id = randomUUID();
  await q(
    `insert into projects (id, user_id, workspace_id, name, status, created_at, updated_at)
     values ($1, $2, null, $3, 'active', now(), now())`,
    [id, owner, name]
  );
  return id;
}

async function seedTrack(projectId: string, owner = USER) {
  const id = randomUUID();
  await q(
    `insert into project_tracks
       (id, project_id, user_id, name, definition_snapshot, method_version, current_stage, status, params, stage_history, metadata, created_at, updated_at)
     values ($1, $2, $3, 'Business Model (GRP)', $4::jsonb, '1', 'pricing', 'active', '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, now(), now())`,
    [id, projectId, owner, JSON.stringify({ stages: STAGES })]
  );
  return id;
}

async function seedSession(
  projectId: string | null,
  workspaceId: string | null = null
) {
  const id = randomUUID();
  await q(
    `insert into focus_sessions
       (id, user_id, title, goal, status, origin, project_id, workspace_id, expected_outputs, criteria, metadata, agent_ids, started_at, updated_at)
     values ($1, $2, null, $3, 'closed', 'human', $4, $5,
             '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}', now(), now())`,
    [id, USER, GOAL, projectId, workspaceId]
  );
  return id;
}

const rowOf = async (id: string) =>
  (
    await q<{
      track_id: string | null;
      track_stage: string | null;
      project_id: string | null;
      workspace_id: string | null;
    }>(
      `select track_id, track_stage, project_id, workspace_id from focus_sessions where id = $1`,
      [id]
    )
  ).rows[0]!;

async function approve(sessionId: string, gate: Record<string, unknown>) {
  const executor = proposalExecRegistry.resolveExact("focus_session/update")!;
  return executor.execute({
    proposal: {
      id: randomUUID(),
      targetId: sessionId,
      workspaceId: null,
      projectId: null,
      subjectUserId: USER,
      data: { data: gate },
      targetType: "focus_session",
      proposalType: "update",
    },
    payload: null,
    userId: USER,
    input: { proposalId: randomUUID() },
    deps: {
      reportProposalOutcome: () => undefined,
      emitProposalReviewed: () => undefined,
      emitSideEffects: () => undefined,
      notify: async () => undefined,
    },
  } as never);
}

beforeAll(async () => {
  await h.init();
  for (const value of Object.values(schema)) {
    if (value instanceof PgTable) {
      try {
        await h.client!.exec(ddlFor(value));
      } catch {
        // A table PGlite cannot express is not one these doors read.
      }
    }
  }
  // The `uses` door dedupes on the links edge index (ON CONFLICT).
  await h.client!.exec(
    "create unique index if not exists links_edge_uniq on links (from_type, from_id, to_type, to_id, link_type);"
  );
  registerFocusSessionExecutors();
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(
    "delete from focus_sessions; delete from project_tracks; delete from projects; delete from proposals; delete from links; delete from workspaces;"
  );
  permSpy.mockClear();
  permSpy.mockImplementation(async (args) =>
    args.agentUserId && args.forcePropose
      ? { proposalId: randomUUID(), proposalType: "update" }
      : {}
  );
});

describe("a person adopts their own session into a track step", () => {
  it("files it at the named step, and unfiles it with trackId null", async () => {
    const projectId = await seedProject();
    const trackId = await seedTrack(projectId);
    const sessionId = await seedSession(projectId);

    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      trackId,
      trackStage: "offer",
    });
    expect(res.status).toBe("updated");
    expect(await rowOf(sessionId)).toMatchObject({
      track_id: trackId,
      track_stage: "offer",
      project_id: projectId,
    });
    if (res.status === "updated") {
      expect(res.trackFiling).toMatchObject({
        trackName: "Business Model (GRP)",
        stageName: "Offer & buyer",
      });
    }

    await updateFocusSession({ sessionId, userId: USER, trackId: null });
    expect(await rowOf(sessionId)).toMatchObject({
      track_id: null,
      track_stage: null,
      project_id: projectId,
    });
  });

  it("no trackStage ⇒ the track's current step", async () => {
    const projectId = await seedProject();
    const trackId = await seedTrack(projectId);
    const sessionId = await seedSession(projectId);
    await updateFocusSession({ sessionId, userId: USER, trackId });
    expect((await rowOf(sessionId)).track_stage).toBe("pricing");
  });

  it("a session with NO project is filed into the track's project", async () => {
    const projectId = await seedProject();
    const trackId = await seedTrack(projectId);
    const sessionId = await seedSession(null);
    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      trackId,
      trackStage: "offer",
    });
    expect(res.status).toBe("updated");
    expect(await rowOf(sessionId)).toMatchObject({
      track_id: trackId,
      project_id: projectId,
    });
  });

  it("refuses a track of ANOTHER project, before governance", async () => {
    const projectId = await seedProject();
    const other = await seedProject(USER, "Other");
    const trackId = await seedTrack(other);
    const sessionId = await seedSession(projectId);
    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      trackId,
      trackStage: "offer",
    });
    expect(res.status).toBe("denied");
    if (res.status === "denied") expect(res.reason).toMatch(/another project/);
    expect(permSpy).not.toHaveBeenCalled();
    expect((await rowOf(sessionId)).track_id).toBeNull();
  });

  it("refuses a stage the track did not pin", async () => {
    const projectId = await seedProject();
    const trackId = await seedTrack(projectId);
    const sessionId = await seedSession(projectId);
    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      trackId,
      trackStage: "launch",
    });
    expect(res.status).toBe("denied");
    if (res.status === "denied")
      expect(res.reason).toMatch(/not a stage of "Business Model \(GRP\)"/);
    expect((await rowOf(sessionId)).track_id).toBeNull();
  });

  it("refuses a track the caller cannot see", async () => {
    const foreignProject = await seedProject(OTHER, "Foreign");
    const trackId = await seedTrack(foreignProject, OTHER);
    const sessionId = await seedSession(null);
    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      trackId,
    });
    expect(res.status).toBe("denied");
    expect(await rowOf(sessionId)).toMatchObject({
      track_id: null,
      project_id: null,
    });
  });
});

describe("an agent can only PROPOSE an adoption", () => {
  it("forces a proposal titled with track + step, and approval applies it", async () => {
    const projectId = await seedProject();
    const trackId = await seedTrack(projectId);
    const sessionId = await seedSession(projectId);

    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      agentUserId: AGENT,
      trackId,
      trackStage: "offer",
    });
    expect(res.status).toBe("proposed");
    const call = permSpy.mock.calls.at(-1)![0];
    expect(call.forcePropose).toBe(true);
    const gate = call.data as Record<string, unknown>;
    expect(gate).toMatchObject({ trackId, trackStage: "offer" });
    expect(buildProposalSummary("focus_session", "update", gate)).toBe(
      `File "${GOAL}" into Business Model (GRP) · Offer & buyer`
    );
    expect((await rowOf(sessionId)).track_id).toBeNull();

    await approve(sessionId, gate);
    expect(await rowOf(sessionId)).toMatchObject({
      track_id: trackId,
      track_stage: "offer",
    });
  });

  it("the title states the project change when filing sets it", async () => {
    const projectId = await seedProject();
    const trackId = await seedTrack(projectId);
    const sessionId = await seedSession(null);
    await updateFocusSession({
      sessionId,
      userId: USER,
      agentUserId: AGENT,
      trackId,
      trackStage: "offer",
    });
    const gate = permSpy.mock.calls.at(-1)![0].data as Record<string, unknown>;
    expect(buildProposalSummary("focus_session", "update", gate)).toBe(
      `File "${GOAL}" into Business Model (GRP) · Offer & buyer (and into project "Launch The Architech")`
    );
    await approve(sessionId, gate);
    expect(await rowOf(sessionId)).toMatchObject({
      track_id: trackId,
      project_id: projectId,
    });
  });

  it("approval RE-resolves: a stage dropped from the track is refused, not written", async () => {
    const projectId = await seedProject();
    const trackId = await seedTrack(projectId);
    const sessionId = await seedSession(projectId);
    await expect(
      approve(sessionId, {
        id: sessionId,
        goal: GOAL,
        trackId,
        trackStage: "launch",
      })
    ).rejects.toThrow(/not a stage/);
    expect((await rowOf(sessionId)).track_id).toBeNull();
  });
});

describe("the adopted session shows up in the track's reads", () => {
  it("the stage count and the project path place it in the lane at that step", async () => {
    const projectId = await seedProject();
    const trackId = await seedTrack(projectId);
    const sessionId = await seedSession(projectId);

    const before = await countTrackSessionsByStage(
      [{ id: trackId, projectId }],
      USER
    );
    expect(before.get(trackId)).toEqual({});

    await updateFocusSession({
      sessionId,
      userId: USER,
      trackId,
      trackStage: "offer",
    });

    const after = await countTrackSessionsByStage(
      [{ id: trackId, projectId }],
      USER
    );
    expect(after.get(trackId)).toEqual({ offer: 1 });

    const path = await getProjectPath({
      userId: USER,
      projectId,
      lens: "all",
      limit: 20,
      offset: 0,
    });
    const row = path?.items.find((r) => r.id === sessionId);
    expect(row).toMatchObject({ trackId, trackStage: "offer" });
  });
});

describe("a step that names a DOMAIN", () => {
  it("files without moving the session, says so, and stamps the project's use of its space", async () => {
    const projectId = await seedProject();
    const trackId = await seedTrack(projectId);
    const wsId = randomUUID();
    await q(
      `insert into workspaces (id, name, owner_id, created_at, updated_at) values ($1, 'Sales', $2, now(), now())`,
      [wsId, USER]
    );
    const sessionId = await seedSession(projectId, wsId);

    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      trackId,
      trackStage: "crm",
    });
    expect(res.status).toBe("updated");
    if (res.status !== "updated") return;
    expect(res.trackFiling?.domainNote).toMatch(
      /"crm-template" domain; this session stays in its current space/
    );
    expect(await rowOf(sessionId)).toMatchObject({
      track_stage: "crm",
      workspace_id: wsId,
    });
    expect(res.trackFiling?.usesStamped).toBe(true);
    const uses = await q<{ n: number }>(
      `select count(*)::int as n from links where from_type = 'project' and from_id = $1 and to_type = 'workspace' and to_id = $2 and link_type = 'uses'`,
      [projectId, wsId]
    );
    expect(uses.rows[0]!.n).toBe(1);
  });
});
