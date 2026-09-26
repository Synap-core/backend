/**
 * FOLLOW A PLAYBOOK with a live session — driven through the REAL door on
 * PGlite, never a hand-built object.
 *
 * Real: `updateFocusSession` (the MCP door's service), `followPlaybook`,
 * `mergeExpectedOutputs` / `sanitizeDeclaredOutputs` / `mergeCriteria` /
 * `collectPlaybookCriteria`, `projectSessionKind` (the reclassification this
 * feature turns on), `createLinks`, the `playbook_runs` ledger write, and the
 * `focus_session/update` executor on the approved path. Tables are generated
 * from the Drizzle definitions.
 *
 * Stubbed, and why:
 *  - `checkPermissionOrPropose` — the governance ladder has its own suites.
 *    Here it answers per (subjectType, action) so BOTH halves are reachable:
 *    the session update auto-approving while the GRANT WIDENING proposes is
 *    the discriminating case, and a single blanket stub cannot express it.
 *  - channel mint / realtime emit / block guidance — side effects with their
 *    own suites and their own connections.
 *
 * NOT covered, measured: the tRPC and Hub REST doors' argument plumbing
 * (typecheck + the cross-door parity tripwire only — this file drives the MCP
 * service), and true cross-connection lock contention (PGlite is ONE
 * connection).
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
vi.mock("../../../utils/permission-check.js", () => ({
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

import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { updateFocusSession } from "../update-session.js";
import { projectSessionKind } from "../session-kind.js";
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

/** A live human work session with one human-owned blocked slot and criteria. */
async function seedSession(
  opts: { outputs?: unknown[]; criteria?: unknown[]; metadata?: unknown } = {}
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions
       (id, user_id, title, goal, status, origin, expected_outputs, criteria, metadata, agent_ids, started_at, updated_at)
     values ($1, $2, 'Q3 billing', 'Ship billing to every customer', 'active', 'human',
             $3::jsonb, $4::jsonb, $5::jsonb, '{}', now(), now())`,
    [
      id,
      USER,
      JSON.stringify(
        opts.outputs ?? [
          {
            kind: "decision",
            label: "Pricing sign-off",
            status: "pending",
            owner: "human",
            blockedReason: "decision",
            why: "only you can price the enterprise tier",
            owedSince: "2026-09-01T10:00:00.000Z",
          },
        ]
      ),
      JSON.stringify(
        opts.criteria ?? [
          {
            key: "shipped",
            statement: "My own wording for shipped",
            check: { kind: "human" },
          },
        ]
      ),
      JSON.stringify(opts.metadata ?? {}),
    ]
  );
  return id;
}

async function seedPlaybook(
  opts: {
    stages?: unknown[];
    criteria?: unknown[];
    expectedOutputs?: unknown[];
  } = {}
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into playbooks
       (id, created_by, name, goal_template, executor, stages, criteria, expected_outputs, params, version, status, created_at, updated_at)
     values ($1, $2, 'Billing launch', 'Run the billing launch', 'is-agent',
             $3::jsonb, $4::jsonb, $5::jsonb, '[]'::jsonb, 3, 'active', now(), now())`,
    [
      id,
      USER,
      JSON.stringify(
        opts.stages ?? [
          { key: "discover", name: "Discover" },
          { key: "build", name: "Build", gate: { kind: "human" } },
        ]
      ),
      JSON.stringify(
        opts.criteria ?? [
          {
            key: "shipped",
            statement: "The playbook's wording for shipped",
            check: { kind: "judge" },
          },
          {
            key: "announced",
            statement: "Customers were told",
            check: { kind: "judge" },
          },
        ]
      ),
      JSON.stringify(
        opts.expectedOutputs ?? [{ kind: "document", label: "Launch note" }]
      ),
    ]
  );
  return id;
}

type Row = {
  id: string;
  title: string | null;
  goal: string;
  origin: string | null;
  status: string | null;
  playbook_id: string | null;
  current_stage: string | null;
  criteria: unknown;
  expected_outputs: unknown;
  metadata: Record<string, unknown>;
};

const readRow = async (id: string): Promise<Row> =>
  (await q<Row>(`select * from focus_sessions where id = $1`, [id])).rows[0];

const runsOf = (playbookId: string) =>
  q<{
    id: string;
    session_id: string;
    status: string;
    definition_snapshot: {
      stages?: { key: string }[];
      version?: number;
    } | null;
  }>(
    `select id, session_id, status, definition_snapshot from playbook_runs where playbook_id = $1`,
    [playbookId]
  ).then((r) => r.rows);

beforeAll(async () => {
  await h.init();
  for (const value of Object.values(schema)) {
    if (value instanceof PgTable) {
      try {
        await h.client!.exec(ddlFor(value));
      } catch {
        // A table whose DDL PGlite cannot express is not one these doors read.
      }
    }
  }
  // A KNOWN principal (Sites W2 S2): an id with no `users` row is an unknown
  // principal and reads no pod-level row (pod-wide globals, pod-visible
  // workspaces) — `podReaderWhere`. This fixture models provisioned users.
  await h.client!.exec(
    `insert into users (id, email) values ('${USER}', '${USER}@example.test')`
  );
  await h.client!.exec(
    `create unique index if not exists idx_links_unique_edge on links (from_type, from_id, to_type, to_id, link_type);`
  );
  registerFocusSessionExecutors();
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(
    "delete from focus_sessions; delete from playbooks; delete from playbook_runs; delete from links; delete from proposals;"
  );
  permSpy.mockClear();
  permSpy.mockImplementation(async () => ({}));
});

describe("attach: the session BECOMES A RUN of the playbook", () => {
  it("writes playbookId, reclassifies work→run, and joins the playbook's runs", async () => {
    const sessionId = await seedSession();
    const playbookId = await seedPlaybook();

    const before = await readRow(sessionId);
    expect(
      projectSessionKind({
        origin: before.origin,
        playbookId: before.playbook_id,
        metadata: before.metadata,
        status: before.status,
      })
    ).toBe("work");

    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      followPlaybookId: playbookId,
    });
    expect(res.status).toBe("updated");
    if (res.status !== "updated") return;
    expect(res.follow).toMatchObject({
      action: "attached",
      playbookId,
      playbookName: "Billing launch",
      becameRun: true,
      stageKey: null,
    });

    const after = await readRow(sessionId);
    expect(after.playbook_id).toBe(playbookId);
    expect(
      projectSessionKind({
        origin: after.origin,
        playbookId: after.playbook_id,
        metadata: after.metadata,
        status: after.status,
      })
    ).toBe("run");

    // It appears in the PLAYBOOK's runs — the founder's whole reason.
    const runs = await runsOf(playbookId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ session_id: sessionId, status: "running" });

    // …and carries the provenance edge an instantiate writes, so "every run of
    // this playbook" is ONE graph query however the run began.
    const edges = await q<{ to_id: string }>(
      `select to_id from links where from_id = $1 and link_type = 'instantiated_from'`,
      [sessionId]
    );
    expect(edges.rows).toEqual([{ to_id: playbookId }]);
  });

  it("PINS the definition: the run row carries a definitionSnapshot", async () => {
    const sessionId = await seedSession();
    const playbookId = await seedPlaybook();
    await updateFocusSession({
      sessionId,
      userId: USER,
      followPlaybookId: playbookId,
    });
    const [run] = await runsOf(playbookId);
    // Without this, `resolveStageGateForSession` falls back to the LIVE
    // playbook and the definition drifts under a running session.
    expect(run.definition_snapshot?.version).toBe(3);
    expect(run.definition_snapshot?.stages?.map((s) => s.key)).toEqual([
      "discover",
      "build",
    ]);
  });

  it("NEVER auto-seeds currentStage — NULL without a key, set with one", async () => {
    const a = await seedSession();
    const playbookId = await seedPlaybook();
    await updateFocusSession({
      sessionId: a,
      userId: USER,
      followPlaybookId: playbookId,
    });
    expect((await readRow(a)).current_stage).toBeNull();

    const b = await seedSession();
    const res = await updateFocusSession({
      sessionId: b,
      userId: USER,
      followPlaybookId: playbookId,
      followStageKey: "build",
    });
    expect((await readRow(b)).current_stage).toBe("build");
    expect(res.status === "updated" && res.follow?.stageKey).toBe("build");
  });

  it("REFUSES an unknown stage key, names the valid ones, and changes NOTHING", async () => {
    const sessionId = await seedSession();
    const playbookId = await seedPlaybook();
    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      followPlaybookId: playbookId,
      followStageKey: "ship",
    });
    expect(res.status).toBe("updated");
    if (res.status !== "updated") return;
    expect(res.follow).toBeUndefined();
    expect(res.followRefusal).toContain('"discover"');
    expect(res.followRefusal).toContain('"build"');

    const row = await readRow(sessionId);
    expect(row.playbook_id).toBeNull();
    expect(row.current_stage).toBeNull();
    expect(await runsOf(playbookId)).toEqual([]);
  });

  it("MERGES criteria and deliverables — a live blocked slot survives intact", async () => {
    const sessionId = await seedSession();
    const playbookId = await seedPlaybook();
    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      followPlaybookId: playbookId,
    });
    expect(res.status === "updated" && res.follow).toMatchObject({
      mergedCriteria: 1,
      mergedOutputs: 1,
    });

    const row = await readRow(sessionId);
    // CRITERIA: the caller's wording WINS on a shared key; the playbook's own
    // key is added. A clobber would read "The playbook's wording for shipped".
    expect(row.criteria).toEqual([
      {
        key: "shipped",
        statement: "My own wording for shipped",
        check: { kind: "human" },
      },
      {
        key: "announced",
        statement: "Customers were told",
        check: { kind: "judge" },
      },
    ]);
    // DELIVERABLES: the human-owned blocked slot survives BYTE-IDENTICAL —
    // its owner, its classified blocker, its one-line why and above all its
    // `owedSince` clock, which the "needs you" feed ages rows by.
    expect(row.expected_outputs).toEqual([
      {
        kind: "decision",
        label: "Pricing sign-off",
        status: "pending",
        owner: "human",
        blockedReason: "decision",
        why: "only you can price the enterprise tier",
        owedSince: "2026-09-01T10:00:00.000Z",
      },
      { kind: "document", label: "Launch note" },
    ]);
  });

  it("NEVER rewrites title, goal or origin", async () => {
    const sessionId = await seedSession();
    const playbookId = await seedPlaybook();
    const before = await readRow(sessionId);
    await updateFocusSession({
      sessionId,
      userId: USER,
      followPlaybookId: playbookId,
    });
    const after = await readRow(sessionId);
    // `goal` is the dedup key (`findOpenSessionTwin`); `origin` answers what
    // shaped the row and a PERSON opened it.
    expect(after.title).toBe(before.title);
    expect(after.goal).toBe(before.goal);
    expect(after.origin).toBe("human");
    expect(after.metadata).toMatchObject({ followedVia: "attach" });
    expect(typeof after.metadata.followedAt).toBe("string");
  });

  it("a GRANT WIDENING files a proposal instead of widening silently", async () => {
    const sessionId = await seedSession();
    const playbookId = await seedPlaybook();
    // The playbook grants a tool — read at RUN TIME from these links, so the
    // attach alone would widen what the session may call.
    await q(
      `insert into links (id, from_type, from_id, to_type, to_id, link_type, metadata, created_at)
       values (gen_random_uuid(), 'playbook', $1, 'tool', $2, 'grants', '{}'::jsonb, now())`,
      [playbookId, randomUUID()]
    );
    permSpy.mockImplementation(async (args) =>
      args.action === "grant_capability"
        ? { proposalId: "prop-grant-1", proposalType: "focus_session.grant" }
        : {}
    );

    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      agentUserId: AGENT,
      followPlaybookId: playbookId,
    });
    expect(res.status).toBe("updated");
    if (res.status !== "updated") return;
    expect(res.follow).toBeUndefined();
    expect(res.followRefusal).toMatch(/widen/i);

    const row = await readRow(sessionId);
    expect(row.playbook_id).toBeNull();
    expect(await runsOf(playbookId)).toEqual([]);
    expect(
      permSpy.mock.calls.some(
        ([a]) =>
          a.subjectType === "focus_session" && a.action === "grant_capability"
      )
    ).toBe(true);
  });

  it("refuses a SECOND playbook while one is followed", async () => {
    const sessionId = await seedSession();
    const first = await seedPlaybook();
    const second = await seedPlaybook();
    await updateFocusSession({
      sessionId,
      userId: USER,
      followPlaybookId: first,
    });
    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      followPlaybookId: second,
    });
    expect(res.status === "updated" && res.followRefusal).toMatch(
      /already follows/
    );
    expect((await readRow(sessionId)).playbook_id).toBe(first);
  });
});

describe("release: the session is work again, and keeps what it learned", () => {
  it("clears playbookId, cancels the run, KEEPS the merged criteria", async () => {
    const sessionId = await seedSession();
    const playbookId = await seedPlaybook();
    await updateFocusSession({
      sessionId,
      userId: USER,
      followPlaybookId: playbookId,
    });

    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      followPlaybookId: null,
    });
    expect(res.status).toBe("updated");
    if (res.status !== "updated") return;
    expect(res.follow).toMatchObject({
      action: "detached",
      playbookId: null,
      playbookName: "Billing launch",
      becameRun: false,
      mergedCriteria: 2,
      mergedOutputs: 2,
    });
    expect(res.follow?.note).toMatch(/STAY/);

    const row = await readRow(sessionId);
    expect(row.playbook_id).toBeNull();
    expect(
      projectSessionKind({
        origin: row.origin,
        playbookId: row.playbook_id,
        metadata: row.metadata,
        status: row.status,
      })
    ).toBe("work");
    // Deleting work a person may already have graded is worse than residue.
    expect(
      (row.criteria as unknown[]).map((c) => (c as { key: string }).key)
    ).toEqual(["shipped", "announced"]);
    expect((row.expected_outputs as unknown[]).length).toBe(2);
    expect(typeof row.metadata.unfollowedAt).toBe("string");

    const runs = await runsOf(playbookId);
    // `cancelled`, not `failed`: the run did not fail, and a `failed` row would
    // grade the playbook for a person's change of mind.
    expect(runs.map((r) => r.status)).toEqual(["cancelled"]);
  });

  it("is REFUSED while a stage gate is pending", async () => {
    const sessionId = await seedSession();
    const playbookId = await seedPlaybook();
    await updateFocusSession({
      sessionId,
      userId: USER,
      followPlaybookId: playbookId,
    });
    await q(
      `insert into proposals (id, status, proposal_type, target_type, target_id, data, created_at, updated_at)
       values (gen_random_uuid(), 'pending', 'focus_session.stage_gate', 'focus_session', $1,
               $2::jsonb, now(), now())`,
      [
        sessionId,
        JSON.stringify({ changeType: "stage_gate", stageKey: "build" }),
      ]
    );

    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      followPlaybookId: null,
    });
    expect(res.status === "updated" && res.followRefusal).toMatch(
      /waiting for approval/
    );
    expect((await readRow(sessionId)).playbook_id).toBe(playbookId);
    expect((await runsOf(playbookId))[0].status).toBe("running");
  });

  it("refuses a release when nothing is followed", async () => {
    const sessionId = await seedSession();
    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      followPlaybookId: null,
    });
    expect(res.status === "updated" && res.followRefusal).toMatch(
      /does not follow a playbook/
    );
  });
});

describe("the PROPOSED path is not a silent no-op", () => {
  it("an AI attach rides the proposal and LANDS on approval", async () => {
    const sessionId = await seedSession();
    const playbookId = await seedPlaybook();
    permSpy.mockImplementation(async (args) =>
      args.subjectType === "focus_session" && args.action === "update"
        ? { proposalId: randomUUID(), proposalType: "update" }
        : {}
    );

    const proposed = await updateFocusSession({
      sessionId,
      userId: USER,
      agentUserId: AGENT,
      followPlaybookId: playbookId,
      followStageKey: "build",
    });
    expect(proposed.status).toBe("proposed");
    // The gate payload CARRIES the follow — without it the executor has
    // nothing to apply and approving changes nothing.
    const gate = permSpy.mock.calls.find(
      ([a]) => a.subjectType === "focus_session" && a.action === "update"
    )![0].data as Record<string, unknown>;
    expect(gate).toMatchObject({
      followPlaybookId: playbookId,
      followStageKey: "build",
    });
    expect((await readRow(sessionId)).playbook_id).toBeNull();

    const proposalId = randomUUID();
    await q(
      `insert into proposals (id, status, proposal_type, target_type, target_id, data, created_at, updated_at)
       values ($1, 'pending', 'update', 'focus_session', $2, $3::jsonb, now(), now())`,
      [proposalId, sessionId, JSON.stringify({ data: gate })]
    );
    permSpy.mockImplementation(async () => ({}));
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

    const row = await readRow(sessionId);
    expect(row.playbook_id).toBe(playbookId);
    expect(row.current_stage).toBe("build");
    expect((await runsOf(playbookId)).map((r) => r.status)).toEqual([
      "running",
    ]);
  });
});
