/**
 * S5 (structural plan, founder Q7) — filing a ROOT into a project or a goal
 * files its open sub-sessions too, in ONE governed write: one receipt (or one
 * proposal) for the batch, and one Undo that puts every row back. Closed
 * sub-sessions, and one placed elsewhere, stay where they are. An agent may do
 * it for its own fresh tree (D1's own-organise proof over every row);
 * otherwise the whole batch is one proposal.
 *
 * Real: the update door (`updateFocusSession`), the filing gate and its proof
 * (`own-organise.ts` with the real `isOwnFreshWork`), the tree walk and its
 * compare-and-set (`session-tree-filing.ts`) over real `spawned_from` links,
 * the undo stamp, the revert planner and undo engine, and the
 * `focus_session/update` executor for the approved path — all on PGlite.
 * Stubbed: `checkPermissionOrPropose` (answers as the `@own-organise` row
 * does: a receipt for a proven filing, a proposal for a forced one), the track
 * resolution (its own suites; here it hands back the goal a case files into),
 * channel mint, realtime emit, block guidance, the undo's event fan-out.
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
import { registerFocusSessionExecutors } from "../../../routers/proposals/executors/focus-session.js";
import { proposalExecRegistry } from "../../../routers/proposals/execution-registry.js";

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
const ELSEWHERE_PROJECT = randomUUID();

/** A session this agent opened through KEY, made now unless `ageHours`. */
async function ownSession(
  opts: {
    parentId?: string;
    status?: string;
    projectId?: string | null;
    ageHours?: number;
  } = {}
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions
       (id, user_id, workspace_id, project_id, track_id, title, goal, status, origin,
        expected_outputs, criteria, metadata, agent_ids, started_at, updated_at, created_at)
     values ($1, $2, null, $3, null, 'Security slice', 'Ship a slice', $4, 'agent',
             '[]'::jsonb, '[]'::jsonb, $5::jsonb, '{}', now(), now(),
             now() - make_interval(hours => $6))`,
    [
      id,
      USER,
      opts.projectId ?? null,
      opts.status ?? "active",
      JSON.stringify({ clientKey: `key:${KEY}|conv:c1` }),
      opts.ageHours ?? 0,
    ]
  );
  if (opts.parentId) {
    await q(
      `insert into links (id, from_type, from_id, to_type, to_id, link_type, created_by, metadata)
       values ($1, 'session', $2, 'session', $3, 'spawned_from', $4, '{}'::jsonb)`,
      [randomUUID(), id, opts.parentId, USER]
    );
  }
  return id;
}

/**
 * root ── open ── open grandchild
 *      ├─ open
 *      ├─ closed ── open grandchild (walked through, carried)
 *      └─ open, already in another project (stays, with its own child)
 */
async function seedTree(opts: { staleChild?: boolean } = {}) {
  const root = await ownSession();
  const a = await ownSession({ parentId: root });
  const aa = await ownSession({ parentId: a });
  const b = await ownSession({
    parentId: root,
    ageHours: opts.staleChild ? 25 : 0,
  });
  const closed = await ownSession({ parentId: root, status: "closed" });
  const underClosed = await ownSession({ parentId: closed });
  const elsewhere = await ownSession({
    parentId: root,
    projectId: ELSEWHERE_PROJECT,
  });
  const underElsewhere = await ownSession({
    parentId: elsewhere,
    projectId: ELSEWHERE_PROJECT,
  });
  return { root, a, aa, b, closed, underClosed, elsewhere, underElsewhere };
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

const placement = async (ids: string[]) => {
  const rows = (
    await q<{ id: string; project_id: string | null; track_id: string | null }>(
      `select id, project_id, track_id from focus_sessions where id = any($1::uuid[])`,
      [ids]
    )
  ).rows;
  return Object.fromEntries(
    rows.map((r) => [r.id, { project: r.project_id, goal: r.track_id }])
  );
};

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
  await q(
    `insert into projects (id, user_id, workspace_id, name, status, created_at, updated_at)
     values ($1, $2, null, 'Synap', 'active', now(), now())`,
    [SYNAP, USER]
  );
  registerFocusSessionExecutors();
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(
    "delete from focus_sessions; delete from proposals; delete from events; delete from links;"
  );
  permSpy.mockReset();
  governAsTheClassRow();
});

describe("filing a root files its open sub-sessions (S5, Q7)", () => {
  it("an agent's own fresh tree: ONE receipt files the root and its open sub-sessions; ONE Undo puts them all back", async () => {
    const t = await seedTree();
    const res = await asAgent(() =>
      updateFocusSession({
        sessionId: t.root,
        userId: USER,
        agentUserId: AGENT,
        projectId: SYNAP,
      })
    );
    expect(res.status).toBe("updated");
    // One governed decision for the batch, proven over every row it moves.
    expect(permSpy).toHaveBeenCalledTimes(1);
    expect(permSpy.mock.calls[0]![0]).toMatchObject({
      ownWorkOrganise: true,
      data: { projectId: SYNAP },
    });
    const carried = [t.a, t.aa, t.b, t.underClosed];
    expect(
      [
        ...(permSpy.mock.calls[0]![0].data as { subSessionIds: string[] })
          .subSessionIds,
      ].sort()
    ).toEqual([...carried].sort());
    expect(
      res.status === "updated" ? [...(res.subSessionsFiled ?? [])].sort() : []
    ).toEqual([...carried].sort());

    const after = await placement(Object.values(t));
    for (const id of [t.root, ...carried]) {
      expect(after[id]!.project, id).toBe(SYNAP);
    }
    // A closed sub-session is never moved; one placed elsewhere keeps its place.
    expect(after[t.closed]!.project).toBeNull();
    expect(after[t.elsewhere]!.project).toBe(ELSEWHERE_PROJECT);
    expect(after[t.underElsewhere]!.project).toBe(ELSEWHERE_PROJECT);

    const receipts = (
      await q<{ id: string }>(
        `select id from proposals where status = 'auto_approved'`
      )
    ).rows;
    expect(receipts).toHaveLength(1);
    const out = await undo(receipts[0]!.id);
    expect(out.skipped).toEqual([]);
    const undone = await placement(Object.values(t));
    for (const id of [t.root, ...carried, t.closed]) {
      expect(undone[id]!.project, id).toBeNull();
    }
    expect(undone[t.elsewhere]!.project).toBe(ELSEWHERE_PROJECT);
  });

  it("a goal filing carries the tree into the goal (and its project) the same way", async () => {
    const goal = randomUUID();
    h.goal = {
      set: { trackId: goal, trackStage: null, projectId: SYNAP },
      trackName: "Security",
      stageName: null,
      projectName: "Synap",
      trackProjectId: SYNAP,
      projectWorkspaceId: null,
    };
    const t = await seedTree();
    const res = await asAgent(() =>
      updateFocusSession({
        sessionId: t.root,
        userId: USER,
        agentUserId: AGENT,
        trackId: goal,
      })
    );
    expect(res.status).toBe("updated");
    const after = await placement(Object.values(t));
    for (const id of [t.root, t.a, t.aa, t.b, t.underClosed]) {
      expect(after[id], id).toEqual({ project: SYNAP, goal });
    }
    expect(after[t.closed]).toEqual({ project: null, goal: null });
  });

  it("FLOOR: a tree that is not all the agent's own fresh work is ONE proposal, nothing moved; approving it re-reads the tree and files it with one Undo", async () => {
    const t = await seedTree({ staleChild: true });
    const res = await asAgent(() =>
      updateFocusSession({
        sessionId: t.root,
        userId: USER,
        agentUserId: AGENT,
        projectId: SYNAP,
      })
    );
    expect(res.status).toBe("proposed");
    expect(permSpy).toHaveBeenCalledTimes(1);
    const gate = permSpy.mock.calls[0]![0];
    expect(gate).toMatchObject({ forcePropose: true });
    expect(gate).not.toHaveProperty("ownWorkOrganise");
    const data = gate.data as Record<string, unknown>;
    expect(data.subSessionIds).toEqual(
      expect.arrayContaining([t.a, t.aa, t.b, t.underClosed])
    );
    const before = await placement(Object.values(t));
    for (const id of Object.values(t)) {
      if (id === t.elsewhere || id === t.underElsewhere) continue;
      expect(before[id]!.project, id).toBeNull();
    }

    // Between filing and approval: `aa` is closed, and a session OUTSIDE the
    // tree (open, unfiled — it would pass the placement compare-and-set) is
    // slipped into the stored ids. Approval re-reads the tree: neither moves.
    await q(`update focus_sessions set status = 'closed' where id = $1`, [
      t.aa,
    ]);
    const stranger = await ownSession();
    data.subSessionIds = [...(data.subSessionIds as string[]), stranger];

    // The person approves the one proposal: the executor files the tree.
    const proposalId = randomUUID();
    await q(
      `insert into proposals (id, status, target_type, target_id, proposal_type, data, subject_user_id, agent_user_id)
       values ($1, 'pending', 'focus_session', $2, 'update', $3::jsonb, $4, $5)`,
      [proposalId, t.root, JSON.stringify({ data }), USER, AGENT]
    );
    const executor = proposalExecRegistry.resolveExact("focus_session/update")!;
    await executor.execute({
      proposal: {
        id: proposalId,
        targetId: t.root,
        workspaceId: null,
        projectId: null,
        subjectUserId: USER,
        agentUserId: AGENT,
        data: { data },
        targetType: "focus_session",
        proposalType: "update",
      },
      payload: null,
      userId: USER,
      input: { proposalId },
      deps: {
        reportProposalOutcome: () => undefined,
        emitProposalReviewed: () => undefined,
        emitSideEffects: () => undefined,
        notify: async () => undefined,
      },
    } as never);
    const approved = await placement([...Object.values(t), stranger]);
    for (const id of [t.root, t.a, t.b, t.underClosed]) {
      expect(approved[id]!.project, id).toBe(SYNAP);
    }
    for (const id of [t.closed, t.aa, stranger]) {
      expect(approved[id]!.project, id).toBeNull();
    }

    await undo(proposalId);
    const undone = await placement(Object.values(t));
    for (const id of [t.root, t.a, t.b, t.underClosed]) {
      expect(undone[id]!.project, id).toBeNull();
    }
  });

  it("a session with no sub-sessions files exactly as before (no batch key on the payload)", async () => {
    const lone = await ownSession();
    const res = await asAgent(() =>
      updateFocusSession({
        sessionId: lone,
        userId: USER,
        agentUserId: AGENT,
        projectId: SYNAP,
      })
    );
    expect(res.status).toBe("updated");
    expect(permSpy.mock.calls[0]![0].data).not.toHaveProperty("subSessionIds");
    expect(res).not.toHaveProperty("subSessionsFiled");
  });
});
