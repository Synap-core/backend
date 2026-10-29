/**
 * D1 (founder, 2026-10-29) — an agent files its OWN FRESH session into a GOAL
 * of the project it was told to focus on: applied at once, on ONE receipt,
 * with an Undo — but only when the filing writes no `project --uses-->
 * space` stamp, which an Undo cannot take back (wave lead decision a'). Every
 * other case keeps the forced proposal it had.
 *
 * Real: the update door (`updateFocusSession`), the filing gate and its proof
 * (`own-organise.ts` with the real `isOwnFreshWork` over the session row and
 * `events`), the `uses` rule (`trackFilingStampsUses`), the undo stamp, the
 * revert planner and the undo engine (`revertProposalCreations` →
 * `safeRevert`), all on PGlite.
 * Stubbed: `checkPermissionOrPropose` (answers as the seeded `@own-organise`
 * row does: granted with a receipt for a proven filing, a proposal for a
 * forced one), the track resolution (`resolveSessionTrackFiling`: its own
 * suites pin it; here it hands back the goal each case files into), channel
 * mint, realtime emit, block guidance, the undo's event fan-out.
 *
 * The measured case: Builder sessions filed into a goal of project Synap,
 * whose home space is Builder.
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
    /** The goal the stubbed resolver files into. */
    goal: null as null | Record<string, unknown>,
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
vi.mock("../../tracks/session-track-filing.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveSessionTrackFiling: async () => h.goal,
}));
vi.mock("../ensure-session-channel.js", () => ({
  ensureSessionChannel: vi.fn(async () => null),
}));
vi.mock("../../../utils/domain-event-bridge.js", () => ({
  emitHubRealtimeEvent: vi.fn(),
}));
vi.mock("../block-guidelines.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  guidanceForBlockedSlots: vi.fn(async () => undefined),
}));
vi.mock("../../../utils/domain-mutation.js", () => ({
  recordDomainMutation: vi.fn(async () => null),
}));

import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { updateFocusSession } from "../update-session.js";
import {
  planProposalRevert,
  type RevertPlannerInput,
} from "../../../routers/proposals/revert.js";
import { revertProposalCreations } from "../../proposals/revert-creations.js";

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
const AGENT = randomUUID();
const KEY = randomUUID();
const SYNAP = randomUUID();
const OTHER_PROJECT = randomUUID();
const BUILDER = randomUUID();
const ELSEWHERE = randomUUID();

/** A session this agent opened through KEY, made now unless `ageHours`. */
async function ownSession(opts: {
  workspaceId?: string | null;
  projectId?: string | null;
  trackId?: string | null;
  ageHours?: number;
}): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions
       (id, user_id, workspace_id, project_id, track_id, title, goal, status, origin,
        expected_outputs, criteria, metadata, agent_ids, started_at, updated_at, created_at)
     values ($1, $2, $3, $4, $5, 'Security headers', 'Ship the headers', 'active', 'agent',
             '[]'::jsonb, '[]'::jsonb, $6::jsonb, '{}', now(), now(),
             now() - make_interval(hours => $7))`,
    [
      id,
      USER,
      opts.workspaceId ?? null,
      opts.projectId ?? null,
      opts.trackId ?? null,
      JSON.stringify({ clientKey: `key:${KEY}|conv:c1` }),
      opts.ageHours ?? 0,
    ]
  );
  return id;
}

/** The goal the stubbed resolver hands back, shaped as `SessionTrackFiling`. */
function fileInto(goal: {
  trackId: string;
  projectId: string;
  homeWorkspaceId: string | null;
  setsProject: boolean;
}) {
  h.goal = {
    set: {
      trackId: goal.trackId,
      trackStage: null,
      ...(goal.setsProject ? { projectId: goal.projectId } : {}),
    },
    trackName: "Security",
    stageName: null,
    projectName: goal.setsProject ? "Synap" : null,
    trackProjectId: goal.projectId,
    projectWorkspaceId: goal.homeWorkspaceId,
  };
}

/** The gate answers as the `@own-organise` row does, minting the receipt. */
function governAsTheClassRow(): void {
  permSpy.mockImplementation(async (args) => {
    if (args.ownWorkOrganise) {
      const id = randomUUID();
      await q(
        `insert into proposals (id, status, target_type, target_id, proposal_type, data, subject_user_id, agent_user_id)
         values ($1, 'auto_approved', 'focus_session', $2, 'focus_session.update', $3::jsonb, $4, $5)`,
        [
          id,
          (args.data as { id: string }).id,
          JSON.stringify({ ...(args.data as object), _autoApprove: {} }),
          USER,
          AGENT,
        ]
      );
      return { granted: true, autoApprovedProposalId: id };
    }
    if (args.forcePropose) {
      return { proposalId: randomUUID(), proposalType: "update" };
    }
    return { granted: true };
  });
}

async function asAgent<T>(fn: () => Promise<T>): Promise<T> {
  const { runWithCallingKey } = await import("@synap/database");
  return runWithCallingKey(KEY, fn);
}

const fileSession = (sessionId: string, trackId: string) =>
  asAgent(() =>
    updateFocusSession({
      sessionId,
      userId: USER,
      agentUserId: AGENT,
      trackId,
    })
  );

const rowOf = async (sessionId: string) =>
  (
    await q<{ project_id: string | null; track_id: string | null }>(
      `select project_id, track_id from focus_sessions where id = $1`,
      [sessionId]
    )
  ).rows[0]!;

const receipts = async (sessionId: string) =>
  (
    await q<{ id: string }>(
      `select id from proposals where target_id = $1 and status = 'auto_approved'`,
      [sessionId]
    )
  ).rows.map((r) => r.id);

async function plannerRow(proposalId: string): Promise<RevertPlannerInput> {
  const row = (
    await q<{
      status: string;
      target_type: string;
      target_id: string;
      proposal_type: string;
      data: unknown;
    }>(
      `select status, target_type, target_id, proposal_type, data from proposals where id = $1`,
      [proposalId]
    )
  ).rows[0]!;
  return {
    status: row.status,
    targetType: row.target_type,
    targetId: row.target_id,
    proposalType: row.proposal_type,
    data: row.data,
  };
}

async function undo(proposalId: string) {
  const row = await plannerRow(proposalId);
  const plan = planProposalRevert(row);
  if (plan.kind !== "delete-creations") {
    throw new Error(`not undoable: ${JSON.stringify(plan)}`);
  }
  return revertProposalCreations({
    proposal: {
      id: proposalId,
      workspaceId: null,
      sessionId: null,
      data: row.data,
    },
    plan,
    userId: USER,
  });
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
  await q(
    `insert into users (id, name, email, user_type, agent_metadata) values ($1,'Claude Code','a@x','agent',$2::jsonb)`,
    [AGENT, JSON.stringify({ agentType: "claude-code", focusProjectId: SYNAP })]
  );
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(
    "delete from focus_sessions; delete from proposals; delete from events;"
  );
  permSpy.mockReset();
  governAsTheClassRow();
});

describe("D1: an agent files its own fresh session into a goal of its focus project", () => {
  it("THE MEASURED CASE: a Builder session into a Synap goal (home Builder) — one receipt, Undo restores the previous goal", async () => {
    const previousGoal = randomUUID();
    const goal = randomUUID();
    const sessionId = await ownSession({
      workspaceId: BUILDER,
      projectId: SYNAP,
      trackId: previousGoal,
    });
    fileInto({
      trackId: goal,
      projectId: SYNAP,
      homeWorkspaceId: BUILDER,
      setsProject: false,
    });

    const res = await fileSession(sessionId, goal);
    expect(res.status).toBe("updated");
    expect(permSpy).toHaveBeenCalledTimes(1);
    expect(permSpy.mock.calls[0]![0]).toMatchObject({
      forcePropose: false,
      ownWorkOrganise: true,
    });
    expect(await rowOf(sessionId)).toEqual({
      project_id: SYNAP,
      track_id: goal,
    });

    const [receipt] = await receipts(sessionId);
    expect(receipt).toBeDefined();
    const out = await undo(receipt!);
    expect(out.skipped).toEqual([]);
    expect(await rowOf(sessionId)).toEqual({
      project_id: SYNAP,
      track_id: previousGoal,
    });
  });

  it("a session in no space, with no project: filed into the goal and its project; Undo restores both to null", async () => {
    const goal = randomUUID();
    const sessionId = await ownSession({});
    fileInto({
      trackId: goal,
      projectId: SYNAP,
      homeWorkspaceId: BUILDER,
      setsProject: true,
    });

    expect((await fileSession(sessionId, goal)).status).toBe("updated");
    expect(await rowOf(sessionId)).toEqual({
      project_id: SYNAP,
      track_id: goal,
    });

    const [receipt] = await receipts(sessionId);
    await undo(receipt!);
    expect(await rowOf(sessionId)).toEqual({
      project_id: null,
      track_id: null,
    });
  });

  it("a session in ANOTHER space (a `uses` stamp would be written) stays a proposal, unwritten", async () => {
    const goal = randomUUID();
    const sessionId = await ownSession({
      workspaceId: ELSEWHERE,
      projectId: SYNAP,
    });
    fileInto({
      trackId: goal,
      projectId: SYNAP,
      homeWorkspaceId: BUILDER,
      setsProject: false,
    });

    expect((await fileSession(sessionId, goal)).status).toBe("proposed");
    expect(permSpy.mock.calls[0]![0]).toMatchObject({ forcePropose: true });
    expect(permSpy.mock.calls[0]![0]).not.toHaveProperty("ownWorkOrganise");
    expect((await rowOf(sessionId)).track_id).toBeNull();
    expect(await receipts(sessionId)).toEqual([]);
  });

  it("a goal of a project the agent was NOT told to focus on stays a proposal", async () => {
    const goal = randomUUID();
    const sessionId = await ownSession({});
    fileInto({
      trackId: goal,
      projectId: OTHER_PROJECT,
      homeWorkspaceId: null,
      setsProject: true,
    });

    expect((await fileSession(sessionId, goal)).status).toBe("proposed");
    expect(permSpy.mock.calls[0]![0]).toMatchObject({ forcePropose: true });
    expect((await rowOf(sessionId)).track_id).toBeNull();
  });

  it("a session a PERSON touched, or older than 24 h, stays a proposal", async () => {
    const goal = randomUUID();
    fileInto({
      trackId: goal,
      projectId: SYNAP,
      homeWorkspaceId: BUILDER,
      setsProject: true,
    });

    const touched = await ownSession({});
    await q(
      `insert into events (id, timestamp, type, subject_id, subject_type, data, source, user_id)
       values ($1, now(), 'focus_session.update.completed', $2, 'focus_session', '{}'::jsonb, 'api', $3)`,
      [randomUUID(), touched, USER]
    );
    expect((await fileSession(touched, goal)).status).toBe("proposed");

    const old = await ownSession({ ageHours: 25 });
    expect((await fileSession(old, goal)).status).toBe("proposed");

    for (const call of permSpy.mock.calls) {
      expect(call[0]).toMatchObject({ forcePropose: true });
    }
    expect((await rowOf(touched)).track_id).toBeNull();
    expect((await rowOf(old)).track_id).toBeNull();
  });
});
