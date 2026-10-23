/**
 * UNDO FOR A SESSION UPDATE (F4) — driven through the REAL doors on PGlite:
 * `updateFocusSession` (the MCP door's service) and the REAL
 * `focus_session/update` executor stamp the undo record; the REAL planner
 * (`planProposalRevert` / `revertableForRow`, what `proposals.list` serves as
 * `revertable`) reads it; the REAL undo engine (`revertProposalCreations` →
 * `safeRevert`) restores the columns.
 *
 * The rules under test:
 *  - an auto-approved rename / goal / progress change is undoable, and undo
 *    puts the earlier values back;
 *  - a value edited since is the person's, and is kept (compare-and-set);
 *  - an update that also changes something undo cannot restore (status,
 *    stage, deliverables, space, track…) is never stamped, so it is never
 *    offered an Undo;
 *  - an approved session filing is undoable (unfiled back), and a pending one
 *    already says so.
 *
 * Stubbed: `checkPermissionOrPropose` (the ladder has its own suites — the
 * stub inserts the receipt row the real gate would mint), channel mint,
 * realtime emit, block guidance, the undo's event fan-out.
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
// The undo engine's post-commit fan-out — not what this suite asserts.
vi.mock("../../../utils/domain-mutation.js", () => ({
  recordDomainMutation: vi.fn(async () => null),
}));

import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { updateFocusSession } from "../update-session.js";
import { registerFocusSessionExecutors } from "../../../routers/proposals/executors/focus-session.js";
import { proposalExecRegistry } from "../../../routers/proposals/execution-registry.js";
import {
  planProposalRevert,
  revertableForRow,
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

async function seedSession(projectId: string | null = null): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions
       (id, user_id, title, goal, status, origin, project_id, progress, expected_outputs, criteria, metadata, agent_ids, started_at, updated_at)
     values ($1, $2, 'Shell work', 'Ship the work shell', 'active', 'human', $3, 10,
             '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}', now(), now())`,
    [id, USER, projectId]
  );
  return id;
}

async function seedProject(): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into projects (id, user_id, workspace_id, name, status, created_at, updated_at)
     values ($1, $2, null, 'Synap', 'active', now(), now())`,
    [id, USER]
  );
  return id;
}

const sessionOf = async (sessionId: string) =>
  (
    await q<{
      title: string | null;
      goal: string;
      progress: number | null;
      project_id: string | null;
    }>(
      `select title, goal, progress, project_id from focus_sessions where id = $1`,
      [sessionId]
    )
  ).rows[0]!;

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

/** The gate auto-approves, minting the receipt the real gate would. */
function autoApprove(): void {
  permSpy.mockImplementation(async (args) => {
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
  });
}

const receiptId = () =>
  (
    permSpy.mock.results.at(-1)!.value as Promise<{
      autoApprovedProposalId: string;
    }>
  ).then((r) => r.autoApprovedProposalId);

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
  registerFocusSessionExecutors();
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(
    "delete from focus_sessions; delete from projects; delete from proposals;"
  );
  permSpy.mockReset();
  permSpy.mockImplementation(async () => ({}));
});

describe("an agent's auto-approved session update can be undone", () => {
  it("rename + goal + progress: the receipt is revertable, and undo restores them", async () => {
    const sessionId = await seedSession();
    autoApprove();

    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      agentUserId: AGENT,
      title: "Founder radar",
      goal: "Map the radar",
      progress: 40,
    });
    expect(res.status).toBe("updated");
    const id = await receiptId();
    expect(revertableForRow(await plannerRow(id))).toBe(true);

    const out = await undo(id);
    expect(out.skipped).toEqual([]);
    expect(await sessionOf(sessionId)).toEqual({
      title: "Shell work",
      goal: "Ship the work shell",
      progress: 10,
      project_id: null,
    });
  });

  it("a value the person edited since is kept, and nothing is restored", async () => {
    const sessionId = await seedSession();
    autoApprove();
    await updateFocusSession({
      sessionId,
      userId: USER,
      agentUserId: AGENT,
      title: "Founder radar",
    });
    const id = await receiptId();
    await q(`update focus_sessions set title = 'Mine now' where id = $1`, [
      sessionId,
    ]);

    const out = await undo(id);
    expect(out.skipped.map((s) => s.reason)).toEqual(["edited_since"]);
    expect((await sessionOf(sessionId)).title).toBe("Mine now");
  });

  it("an update that also changes the status is never offered an Undo", async () => {
    const sessionId = await seedSession();
    autoApprove();
    await updateFocusSession({
      sessionId,
      userId: USER,
      agentUserId: AGENT,
      title: "Founder radar",
      status: "paused",
    });
    const row = await plannerRow(await receiptId());
    expect(revertableForRow(row)).toBe(false);
    expect(planProposalRevert(row)).toMatchObject({ kind: "unsupported" });
  });
});

describe("an approved session filing can be undone", () => {
  it("pending says so, approval stamps it, undo unfiles it", async () => {
    const sessionId = await seedSession();
    const projectId = await seedProject();
    // File through the REAL door, so the pending row carries exactly the
    // payload the door builds (`sessionNameField` + `sessionFilingFields`).
    // A key the door adds that undo does not know makes this row
    // un-revertable, and this test red. It used to hand-build `{id, goal,
    // projectId}` and stayed green when the door's keys outran the allowlist.
    permSpy.mockImplementation(async (args) => {
      if (!args.forcePropose) return {};
      const id = randomUUID();
      await q(
        `insert into proposals (id, status, target_type, target_id, proposal_type, data, subject_user_id, agent_user_id)
         values ($1, 'pending', 'focus_session', $2, 'update', $3::jsonb, $4, $5)`,
        [
          id,
          (args.data as { id: string }).id,
          JSON.stringify({
            targetType: "focus_session",
            changeType: "update",
            data: args.data,
          }),
          USER,
          AGENT,
        ]
      );
      return { proposalId: id, proposalType: "update" };
    });
    await updateFocusSession({
      sessionId,
      userId: USER,
      agentUserId: AGENT,
      projectId,
    });
    const filed = (
      await q<{ id: string }>(
        `select id from proposals where status = 'pending' and target_id = $1`,
        [sessionId]
      )
    ).rows;
    expect(filed).toHaveLength(1);
    const proposalId = filed[0]!.id;
    const gate = (
      (await plannerRow(proposalId)).data as { data: Record<string, unknown> }
    ).data;
    expect(gate).toMatchObject({ id: sessionId, projectId });
    expect(revertableForRow(await plannerRow(proposalId))).toBe(true);

    const executor = proposalExecRegistry.resolveExact("focus_session/update")!;
    await executor.execute({
      proposal: {
        id: proposalId,
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
      input: { proposalId },
      deps: {
        reportProposalOutcome: () => undefined,
        emitProposalReviewed: () => undefined,
        emitSideEffects: () => undefined,
        notify: async () => undefined,
      },
    } as never);
    expect((await sessionOf(sessionId)).project_id).toBe(projectId);
    expect(revertableForRow(await plannerRow(proposalId))).toBe(true);

    await undo(proposalId);
    expect((await sessionOf(sessionId)).project_id).toBeNull();
  });

  it("a pending space move is not offered an Undo", async () => {
    const sessionId = await seedSession();
    expect(
      revertableForRow({
        status: "pending",
        targetType: "focus_session",
        targetId: sessionId,
        proposalType: "update",
        data: {
          targetType: "focus_session",
          changeType: "update",
          data: { id: sessionId, goal: "g", workspaceId: randomUUID() },
        },
      })
    ).toBe(false);
  });
});
