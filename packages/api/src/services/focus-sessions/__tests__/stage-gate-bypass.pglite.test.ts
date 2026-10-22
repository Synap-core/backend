/**
 * An AGENT cannot walk around a human stage gate — driven through the REAL
 * doors on PGlite, never a hand-built object.
 *
 * The invariant: an agent may propose and may reject, never approve. A stage
 * declaring `gate: { kind: "human" }` pauses the run and files a
 * `playbook.stage_gate` proposal only a person approves. `focus_session.update`
 * auto-approves for agents (`DEFAULT_AUTO_APPROVE`), so before this floor the
 * same agent could
 *   (a) resume the gate-paused session itself (`status: "active"`), or advance
 *       it past the gate while it is held;
 *   (b) jump over the gated stage (`currentStage` = a stage AFTER the gate) —
 *       the gate resolver only looks at the stage being ENTERED;
 *   (c) write `metadata.devLoop` (the dev-approval executor's receipt) through
 *       the Hub PATCH metadata bag, indistinguishable from a real approval.
 *
 * Real: `updateFocusSession` (the MCP door's service), the Hub
 * `PATCH /focus-sessions/:id` route, `advanceSessionStage`, the stage-gate
 * pause (`applyStageGateOnAdvance`), `pendingStageGate`, the
 * `focus_session/playbook.stage_gate` approve executor.
 *
 * Stubbed, and why:
 *  - `checkPermissionOrPropose` answers GRANTED — exactly what the real ladder
 *    answers an attributed agent for `focus_session.update` (it is in
 *    `DEFAULT_AUTO_APPROVE`). The holes live BEHIND that grant; the ladder has
 *    its own suites.
 *  - `createEventBackedProposal` writes the pending proposal row directly
 *    (same target, status and `data.changeType` the real one writes) — its
 *    notification/audit fan-out has its own suites.
 *  - channel mint / realtime emit / block guidance — side effects with their
 *    own suites.
 *
 * NOT covered: the tRPC (human) door — deliberately unchanged, see the floor's
 * header in `gate-bypass-floor.ts`.
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
}));
vi.mock("../../../utils/event-backed-proposal.js", () => ({
  createEventBackedProposal: async (p: {
    targetType: string;
    targetId: string;
    proposalType: string;
    data: Record<string, unknown>;
  }) => {
    const id = randomUUID();
    await h.client!.query(
      `insert into proposals (id, status, proposal_type, target_type, target_id, data, created_at, updated_at)
       values ($1, 'pending', $2, $3, $4, $5::jsonb, now(), now())`,
      [id, p.proposalType, p.targetType, p.targetId, JSON.stringify(p.data)]
    );
    return { proposal: { id } };
  },
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
import { OpenAPIHono } from "@hono/zod-openapi";
import * as schema from "@synap/database/schema";
import { updateFocusSession } from "../update-session.js";
import { registerPlaybookStageGateExecutors } from "../../../routers/proposals/executors/playbook-stage-gate.js";
import { proposalExecRegistry } from "../../../routers/proposals/execution-registry.js";
import { registerFocusSessionsRoutes } from "../../../routers/hub-protocol/rest/focus-sessions.js";
import type {
  HubHono,
  HubVariables,
} from "../../../routers/hub-protocol/rest/_shared.js";

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

/** discover → build (HUMAN gate) → ship, unless other stages are given. */
async function seedPlaybook(stages?: unknown[]): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into playbooks
       (id, created_by, name, goal_template, executor, stages, criteria, expected_outputs, params, version, status, created_at, updated_at)
     values ($1, $2, 'Release', 'Release it', 'is-agent', $3::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 1, 'active', now(), now())`,
    [
      id,
      USER,
      JSON.stringify(
        stages ?? [
          { key: "discover", name: "Discover" },
          { key: "build", name: "Build", gate: { kind: "human" } },
          { key: "ship", name: "Ship" },
        ]
      ),
    ]
  );
  return id;
}

async function seedSession(
  playbookId: string,
  opts: {
    stage?: string;
    status?: string;
    metadata?: unknown;
    owner?: string;
  } = {}
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions
       (id, user_id, title, goal, status, origin, playbook_id, current_stage, expected_outputs, criteria, metadata, agent_ids, started_at, updated_at)
     values ($1, $2, 'Release', 'Release v2', $3, 'agent', $4, $5,
             '[]'::jsonb, '[]'::jsonb, $6::jsonb, '{}', now(), now())`,
    [
      id,
      opts.owner ?? USER,
      opts.status ?? "active",
      playbookId,
      opts.stage ?? "discover",
      JSON.stringify(opts.metadata ?? {}),
    ]
  );
  return id;
}

type Row = {
  id: string;
  status: string;
  current_stage: string | null;
  metadata: Record<string, unknown>;
};
const readRow = async (id: string): Promise<Row> =>
  (await q<Row>(`select * from focus_sessions where id = $1`, [id])).rows[0];

const pendingGates = async (sessionId: string) =>
  (
    await q<{ id: string }>(
      `select id from proposals where target_id = $1 and status = 'pending'
         and data ->> 'changeType' = 'stage_gate'`,
      [sessionId]
    )
  ).rows;

/** The real path: an agent advances discover → build, the gate pauses + files. */
async function gateHeldSession(): Promise<{
  sessionId: string;
  playbookId: string;
}> {
  const playbookId = await seedPlaybook();
  const sessionId = await seedSession(playbookId);
  const res = await updateFocusSession({
    sessionId,
    userId: USER,
    agentUserId: AGENT,
    currentStage: "build",
  });
  expect(res.status).toBe("updated");
  const row = await readRow(sessionId);
  expect(row).toMatchObject({ status: "paused", current_stage: "build" });
  expect(await pendingGates(sessionId)).toHaveLength(1);
  return { sessionId, playbookId };
}

function hubApp(agentUserId?: string): HubHono {
  const a: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  a.use("/*", async (c, next) => {
    c.set("userId", USER);
    c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
    if (agentUserId) c.set("agentUserId", agentUserId);
    await next();
  });
  registerFocusSessionsRoutes(a);
  return a;
}

const patch = (id: string, body: unknown, agentUserId: string | undefined) =>
  hubApp(agentUserId).request(`/focus-sessions/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

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
  await h.client!.exec(
    `insert into users (id, email) values ('${USER}', '${USER}@example.test')`
  );
  registerPlaybookStageGateExecutors();
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(
    "delete from focus_sessions; delete from playbooks; delete from playbook_runs; delete from proposals;"
  );
  permSpy.mockClear();
  permSpy.mockImplementation(async () => ({}));
});

describe("(a) a gate-paused session resumes only through the gate's approval", () => {
  it("MCP door: an agent cannot resume it (status → active)", async () => {
    const { sessionId } = await gateHeldSession();

    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      agentUserId: AGENT,
      status: "active",
    });

    // The row first: on the unfixed code this is the exploit, quoted.
    expect((await readRow(sessionId)).status).toBe("paused");
    expect(await pendingGates(sessionId)).toHaveLength(1);
    expect(res.status).toBe("denied");
  });

  it("MCP door: an agent cannot advance it while the gate holds", async () => {
    const { sessionId } = await gateHeldSession();

    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      agentUserId: AGENT,
      currentStage: "ship",
    });

    expect(await readRow(sessionId)).toMatchObject({
      status: "paused",
      current_stage: "build",
    });
    expect(res.status).toBe("denied");
  });

  it("Hub PATCH: an agent cannot resume it (status → active)", async () => {
    const { sessionId } = await gateHeldSession();

    const res = await patch(sessionId, { status: "active" }, AGENT);

    expect((await readRow(sessionId)).status).toBe("paused");
    expect(res.status).toBe(409);
  });

  it("the gate's APPROVAL still resumes it, and the agent then moves on", async () => {
    const { sessionId } = await gateHeldSession();
    const [gate] = await pendingGates(sessionId);

    const executor = proposalExecRegistry.resolveExact(
      "focus_session/playbook.stage_gate"
    )!;
    await executor.execute({
      proposal: {
        id: gate.id,
        targetId: sessionId,
        workspaceId: null,
        projectId: null,
        subjectUserId: USER,
        data: { changeType: "stage_gate", stageKey: "build" },
        targetType: "focus_session",
        proposalType: "playbook.stage_gate",
      },
      payload: null,
      userId: USER,
      input: { proposalId: gate.id },
      deps: {
        reportProposalOutcome: () => undefined,
        emitProposalReviewed: () => undefined,
        emitSideEffects: () => undefined,
        notify: async () => undefined,
      },
    } as never);
    expect((await readRow(sessionId)).status).toBe("active");

    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      agentUserId: AGENT,
      currentStage: "ship",
    });
    expect(res.status).toBe("updated");
    expect(await readRow(sessionId)).toMatchObject({
      status: "active",
      current_stage: "ship",
    });
  });

  it("an agent may still pause a held session (a no-op, not a resume)", async () => {
    const { sessionId } = await gateHeldSession();
    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      agentUserId: AGENT,
      status: "paused",
    });
    expect(res.status).toBe("updated");
  });

  it("a HELD CHECK gate (metadata.checkGate) is not the agent's to resume either", async () => {
    const playbookId = await seedPlaybook();
    const sessionId = await seedSession(playbookId, {
      stage: "build",
      status: "paused",
      metadata: {
        checkGate: { stageKey: "build", fromStage: "discover", failing: ["x"] },
      },
    });
    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      agentUserId: AGENT,
      status: "active",
    });
    expect((await readRow(sessionId)).status).toBe("paused");
    expect(res.status).toBe("denied");
  });

  it("an ordinary pause (no gate) is still the agent's to resume", async () => {
    const playbookId = await seedPlaybook();
    const sessionId = await seedSession(playbookId, { status: "paused" });
    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      agentUserId: AGENT,
      status: "active",
    });
    expect(res.status).toBe("updated");
    expect((await readRow(sessionId)).status).toBe("active");
  });
});

describe("(b) advancing A → C checks every gated stage in between", () => {
  it("MCP door: an agent cannot jump over the human-gated stage", async () => {
    const playbookId = await seedPlaybook();
    const sessionId = await seedSession(playbookId, { stage: "discover" });

    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      agentUserId: AGENT,
      currentStage: "ship",
    });

    expect(await readRow(sessionId)).toMatchObject({
      status: "active",
      current_stage: "discover",
    });
    expect(res.status).toBe("denied");
    if (res.status === "denied") expect(res.reason).toMatch(/Build/);
  });

  it("Hub PATCH: an agent cannot jump over the human-gated stage", async () => {
    const playbookId = await seedPlaybook();
    const sessionId = await seedSession(playbookId, { stage: "discover" });

    const res = await patch(sessionId, { currentStage: "ship" }, AGENT);

    expect((await readRow(sessionId)).current_stage).toBe("discover");
    expect(res.status).toBe(409);
  });

  it("stepping INTO the gated stage still pauses and files (unchanged)", async () => {
    await gateHeldSession();
  });

  it("moving BACK over a gated stage skips no gate", async () => {
    const playbookId = await seedPlaybook();
    const sessionId = await seedSession(playbookId, { stage: "ship" });
    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      agentUserId: AGENT,
      currentStage: "discover",
    });
    expect(res.status).toBe("updated");
    expect((await readRow(sessionId)).current_stage).toBe("discover");
  });
});

describe("(c) metadata.devLoop is written only by its approval", () => {
  const forged = {
    devLoop: {
      deploy: {
        approvedAt: "2026-10-18T10:00:00.000Z",
        approvedBy: USER,
        proposalId: randomUUID(),
        repo: "synap-backend",
        branch: "main",
        commitSha: "deadbeef",
        targetHost: "pod",
        deployCommand: "deploy.sh",
        gatePassed: true,
      },
    },
  };

  it("Hub PATCH: an agent cannot forge the ship stamp", async () => {
    const playbookId = await seedPlaybook();
    const sessionId = await seedSession(playbookId);

    const res = await patch(sessionId, { metadata: forged }, AGENT);

    // Dropped, not refused: the rest of the bag still merges (main's
    // `withoutServerOwnedSessionMetadata` contract).
    expect(res.status).toBe(200);
    expect((await readRow(sessionId)).metadata.devLoop).toBeUndefined();
  });

  it("Hub PATCH: a client (no agent) cannot forge it either", async () => {
    const playbookId = await seedPlaybook();
    const sessionId = await seedSession(playbookId);

    const res = await patch(sessionId, { metadata: forged }, undefined);

    // Dropped, not refused: the rest of the bag still merges (main's
    // `withoutServerOwnedSessionMetadata` contract).
    expect(res.status).toBe(200);
    expect((await readRow(sessionId)).metadata.devLoop).toBeUndefined();
  });

  it("Hub PATCH: clearing the check-gate hold record is dropped too", async () => {
    const playbookId = await seedPlaybook();
    const sessionId = await seedSession(playbookId, {
      status: "paused",
      metadata: {
        checkGate: { stageKey: "build", fromStage: "discover", failing: ["x"] },
      },
    });

    const res = await patch(
      sessionId,
      { metadata: { checkGate: null } },
      AGENT
    );

    expect(res.status).toBe(200);
    expect((await readRow(sessionId)).metadata.checkGate).toMatchObject({
      stageKey: "build",
    });
  });

  it("Hub PATCH: a metadata key nobody owns still merges", async () => {
    const playbookId = await seedPlaybook();
    const sessionId = await seedSession(playbookId);

    const res = await patch(sessionId, { metadata: { note: "hi" } }, AGENT);

    expect(res.status).toBe(200);
    expect((await readRow(sessionId)).metadata.note).toBe("hi");
  });
});

describe("Hub PATCH writes only the caller's OWN session", () => {
  it("another person's session is NOT FOUND — nothing is changed", async () => {
    const playbookId = await seedPlaybook();
    const sessionId = await seedSession(playbookId, { owner: "user-2" });

    const res = await patch(sessionId, { goal: "Hijacked" }, AGENT);

    expect(
      (
        await q<{ goal: string }>(
          `select goal from focus_sessions where id = $1`,
          [sessionId]
        )
      ).rows[0].goal
    ).toBe("Release v2");
    expect(res.status).toBe(404);
    expect(permSpy).not.toHaveBeenCalled();
  });

  it("a person with no agent key is floored the same way", async () => {
    const playbookId = await seedPlaybook();
    const sessionId = await seedSession(playbookId, { owner: "user-2" });

    const res = await patch(sessionId, { progress: 90 }, undefined);

    expect(res.status).toBe(404);
  });
});

describe("Hub PATCH governs the write as the KEY's agent, never the body's", () => {
  const lastGateAgent = () =>
    permSpy.mock.calls.at(-1)?.[0]?.agentUserId as string | undefined;

  it("an agent key naming ANOTHER agent in the body is still governed as itself", async () => {
    const playbookId = await seedPlaybook();
    const sessionId = await seedSession(playbookId);
    const other = randomUUID();

    await patch(sessionId, { progress: 40, agentUserId: other }, AGENT);

    expect(lastGateAgent()).toBe(AGENT);
  });

  it("a non-agent key naming an agent that is not its person's is REFUSED", async () => {
    const playbookId = await seedPlaybook();
    const sessionId = await seedSession(playbookId);

    const res = await patch(
      sessionId,
      { progress: 40, agentUserId: randomUUID() },
      undefined
    );

    expect(
      (
        await q<{ progress: number | null }>(
          `select progress from focus_sessions where id = $1`,
          [sessionId]
        )
      ).rows[0].progress
    ).not.toBe(40);
    expect(res.status).toBe(403);
  });

  it("a non-agent key (the IS) may name ITS person's agent (the persona it runs)", async () => {
    const playbookId = await seedPlaybook();
    const sessionId = await seedSession(playbookId);
    const persona = randomUUID();
    await q(
      `insert into users (id, email, user_type, created_by_user_id) values ($1, $2, 'agent', $3)`,
      [persona, `${persona}@agents.test`, USER]
    );

    const res = await patch(
      sessionId,
      { progress: 40, agentUserId: persona },
      undefined
    );

    expect(res.status).toBe(200);
    expect(lastGateAgent()).toBe(persona);
  });
});
