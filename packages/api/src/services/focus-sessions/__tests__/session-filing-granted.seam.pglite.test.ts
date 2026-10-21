/**
 * Two governance seams of the session update door, through the REAL gate.
 *
 * M1 — a GRANTED filing is WRITTEN, whatever the rest of the patch decides
 * (FB1020 w2 review M1) — driven through the REAL `updateFocusSession`, the
 * REAL `checkPermissionOrPropose` and the REAL governance resolver + engine on
 * PGlite, with the REAL seeded `@reversible` (0282) and `@own-organise`
 * (0346b) rows and the REAL calling-key context. The gate is NOT mocked: the
 * earlier B3 suites mocked it, which is exactly how this defect passed.
 *
 * The scenario: an agent files its OWN FRESH session into its declared focus
 * project AND changes the session's criteria in the same call. The filing is
 * an organise write the class row applies (an applied receipt, R1); the
 * criteria change is a contract change floored to a proposal (rung 2.1). The
 * defect: the door returned at the criteria proposal, so R1 said "applied"
 * while the session stayed unfiled, with no Undo.
 *
 * M6 — an agent's `retireOutput` on a slot it handed to the PERSON (`owner:
 * "human"`) is that person's gate: it is proposed, never applied. The
 * discriminating input is the real engine: `focus_session.update` is on the
 * default auto list, so without the door's floor it executes.
 *
 * M5 — an agent's `expectedOutputs` proposal stores the list AS SENT, so
 * approving it applies the add-or-update against the row as it is THEN
 * (through the REAL `focus_session/update` executor): a slot that moved on
 * meanwhile does not refuse the approval over a stale stamp, and a slot the
 * person deleted meanwhile does not come back. The review still sees the
 * list as it would land (`withAgentOutputsLanding`).
 *
 * M8 — "untouched by a person since" (`isOwnFreshWork`) sees a person's
 * real edits through the doors a person uses: the app's session edit (tRPC
 * `focusSessions.update`) and a record's un-filing (`fileEntitiesGoverned`).
 * Their events are written by the REAL `auditLog` → `EventRepository` into
 * PGlite (the repository's `sql.unsafe` is routed onto PGlite).
 *
 * Stubbed, and why:
 *  - `getAgentFocusProjectId` reads the agent's declared focus from a value
 *    the test sets. PGlite runs ONE connection, and the real read runs on the
 *    module `db` INSIDE the proposal transaction (`createPendingProposalRow`),
 *    which deadlocks there (never on Postgres). Same value the real reader
 *    would return from `users.agent_metadata.focusProjectId`.
 *  - post-commit delivery only: realtime broadcast, side-effect fan-out, the
 *    AI-decision feed, the session room mint, block guidance.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const h = vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
    focus: null as string | null,
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
  // The event log appends over its own connection (no PGlite): a no-op here.
  const eventRepository = new Proxy(
    {},
    { get: () => async () => ({ id: globalThis.crypto.randomUUID() }) }
  );
  await h.init();
  // `auditLog` appends through a fresh `EventRepository(sql)`, which speaks
  // `sql.unsafe(text, params)` (postgres.js). Routed onto PGlite so the REAL
  // log writer lands its rows in `events`, where `isOwnFreshWork` reads them.
  const sql = Object.assign(
    () => {
      throw new Error("tagged sql is not available in this suite");
    },
    {
      unsafe: async (text: string, params: unknown[] = []) =>
        (await h.client!.query(text, params)).rows,
    }
  );
  return {
    ...actual,
    db: await h.init(),
    getDb: async () => h.init(),
    eventRepository,
    sql,
  };
});
vi.mock("../../agent-identity-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAgentFocusProjectId: async () => h.focus,
}));
vi.mock("@synap/jobs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  broadcastNotification: vi.fn(async () => undefined),
}));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
}));
vi.mock("../../../utils/ai-feedback-events.js", () => ({
  emitAiDecision: vi.fn(async () => undefined),
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
import { runWithCallingKey } from "@synap/database";
import { updateFocusSession } from "../update-session.js";
import { registerFocusSessionExecutors } from "../../../routers/proposals/executors/focus-session.js";
import { proposalExecRegistry } from "../../../routers/proposals/execution-registry.js";
import { withAgentOutputsLanding } from "../../../routers/proposals/session-before.js";
import { focusSessionsRouter } from "../../../routers/focus-sessions.js";
import { fileEntitiesGoverned } from "../../projects/file-entities.js";
import { ownWorkOrganiseForFiling } from "../../governance/own-organise.js";

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

const migration = (f: string) =>
  readFileSync(
    fileURLToPath(
      new URL(`../../../../../database/migrations/${f}`, import.meta.url)
    ),
    "utf-8"
  );

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const USER = randomUUID();
const AGENT = randomUUID();
const KEY = randomUUID();

const C1 = {
  key: "report",
  statement: "A report exists",
  check: { kind: "human" },
};

async function seedOwnFreshSession(): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions
       (id, user_id, title, goal, status, origin, project_id, expected_outputs, criteria, metadata, agent_ids, started_at, created_at, updated_at)
     values ($1, $2, 'Shell work', 'Ship the work shell', 'active', 'agent', null,
             '[]'::jsonb, '[]'::jsonb, $3::jsonb, '{}', now(), now(), now())`,
    [id, USER, JSON.stringify({ clientKey: `key:${KEY}|conv:c1` })]
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

const sessionRow = async (id: string) =>
  (
    await q<{ project_id: string | null; criteria: unknown }>(
      `select project_id, criteria from focus_sessions where id = $1`,
      [id]
    )
  ).rows[0]!;

const proposalsFor = async (sessionId: string) =>
  (
    await q<{
      id: string;
      status: string;
      data: Record<string, unknown> & {
        materialized?: { rowPatches?: unknown[] };
        data?: Record<string, unknown>;
      };
    }>(
      `select id, status, data from proposals where target_id = $1 order by created_at`,
      [sessionId]
    )
  ).rows;

/** The payload a proposal row carries (the gate nests it under `data`). */
const payloadOf = (row: { data: Record<string, unknown> }) =>
  ((row.data.data as Record<string, unknown> | undefined) ??
    row.data) as Record<string, unknown>;

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
    `insert into users (id, name, email, user_type) values ($1, 'Founder', 'f@x', 'human')`,
    [USER]
  );
  await q(
    `insert into users (id, name, email, user_type, agent_metadata) values ($1, 'Claude Code', 'a@x', 'agent', $2::jsonb)`,
    [AGENT, JSON.stringify({ agentType: "claude-code" })]
  );
  registerFocusSessionExecutors();
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(
    "delete from focus_sessions; delete from projects; delete from proposals; delete from governance_rules; delete from events; delete from entities; delete from relations;"
  );
  await h.client!.exec(migration("0282_governance_reversible_default.sql"));
  await h.client!.exec(migration("0346b_governance_own_organise_default.sql"));
  h.focus = null;
});

describe("M1: a granted filing is written whatever the rest of the patch decides", () => {
  it("filing + a criteria change: the filing lands on its applied receipt with Undo; only the criteria wait", async () => {
    const projectId = await seedProject();
    h.focus = projectId;
    const sessionId = await seedOwnFreshSession();

    const res = await runWithCallingKey(KEY, () =>
      updateFocusSession({
        sessionId,
        userId: USER,
        agentUserId: AGENT,
        projectId,
        criteria: [C1] as never,
      })
    );

    // The rest proposes (criteria = a contract change, rung 2.1)…
    expect(res.status).toBe("proposed");
    // …and the reply says the filing was granted, on its receipt.
    const filing = (res as { filing?: { status: string; receiptId?: string } })
      .filing;
    expect(filing?.status).toBe("granted");
    expect(filing?.receiptId).toBeTruthy();

    // The filing the receipt claims IS written; the criteria are not.
    const row = await sessionRow(sessionId);
    expect(row.project_id).toBe(projectId);
    expect(row.criteria).toEqual([]);

    const rows = await proposalsFor(sessionId);
    const receipt = rows.find((r) => r.id === filing!.receiptId)!;
    expect(receipt.status).toBe("auto_approved");
    // Its Undo restores the project only.
    expect(receipt.data.materialized?.rowPatches).toEqual([
      {
        kind: "focus_session",
        id: sessionId,
        before: { projectId: null },
        after: { projectId },
      },
    ]);

    // The criteria proposal carries the criteria and NOT the filing: approving
    // or rejecting it can neither re-file nor un-file the session.
    const pending = rows.filter((r) => r.status === "pending");
    expect(pending).toHaveLength(1);
    const payload = payloadOf(pending[0]!);
    expect(payload.criteria).toEqual([C1]);
    expect(payload.projectId).toBeUndefined();
  });

  it("CONTROL: a session bound to another key — the filing is NOT granted and nothing is written", async () => {
    const projectId = await seedProject();
    h.focus = projectId;
    const sessionId = await seedOwnFreshSession();

    const res = await runWithCallingKey(randomUUID(), () =>
      updateFocusSession({
        sessionId,
        userId: USER,
        agentUserId: AGENT,
        projectId,
        criteria: [C1] as never,
      })
    );

    expect(res.status).toBe("proposed");
    expect((res as { filing?: { status: string } }).filing?.status).toBe(
      "proposed"
    );
    expect((await sessionRow(sessionId)).project_id).toBeNull();
    const rows = await proposalsFor(sessionId);
    expect(rows.some((r) => r.status === "auto_approved")).toBe(false);
  });
});

describe("M6: an agent may only PROPOSE withdrawing a slot handed to the person", () => {
  const HUMAN_GATE = {
    key: "founder-approves",
    kind: "decision",
    label: "Founder approves both specs",
    status: "pending",
    owner: "human",
    blockedReason: "Only the founder can approve the specs",
  };
  const AGENT_SLOT = {
    key: "draft",
    kind: "document",
    label: "Draft",
    status: "pending",
  };

  async function seedWithSlots(): Promise<string> {
    const id = randomUUID();
    await q(
      `insert into focus_sessions
         (id, user_id, title, goal, status, origin, project_id, expected_outputs, criteria, metadata, agent_ids, started_at, created_at, updated_at)
       values ($1, $2, 'Specs', 'Ship both specs', 'active', 'agent', null,
               $3::jsonb, '[]'::jsonb, '{}'::jsonb, '{}', now(), now(), now())`,
      [id, USER, JSON.stringify([HUMAN_GATE, AGENT_SLOT])]
    );
    return id;
  }
  const slot = async (sessionId: string, key: string) =>
    (
      await q<{ expected_outputs: Array<Record<string, unknown>> }>(
        `select expected_outputs from focus_sessions where id = $1`,
        [sessionId]
      )
    ).rows[0]!.expected_outputs.find((o) => o.key === key)!;

  it("withdrawing the person's gate is proposed, and the gate stays owed", async () => {
    const sessionId = await seedWithSlots();
    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      agentUserId: AGENT,
      retireOutput: "founder-approves",
    });
    expect(res.status).toBe("proposed");
    expect(
      (await slot(sessionId, "founder-approves")).retiredAt
    ).toBeUndefined();
    const pending = (await proposalsFor(sessionId)).filter(
      (r) => r.status === "pending"
    );
    expect(pending).toHaveLength(1);
    expect(payloadOf(pending[0]!).retireOutput).toBe("founder-approves");
  });

  it("CONTROL: withdrawing its OWN slot applies directly", async () => {
    const sessionId = await seedWithSlots();
    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      agentUserId: AGENT,
      retireOutput: "draft",
    });
    expect(res.status).toBe("updated");
    expect((await slot(sessionId, "draft")).retiredReason).toBe("withdrawn");
    expect(
      (await slot(sessionId, "founder-approves")).retiredAt
    ).toBeUndefined();
  });
});

describe("M5: an agent's outputs proposal is applied against the row as it is at approval", () => {
  const A = { key: "a", kind: "document", label: "Alpha", status: "pending" };
  const C = { key: "c", kind: "document", label: "Gamma", status: "pending" };
  const B = { key: "b", kind: "document", label: "Beta" };
  const CHANGED = [
    {
      key: "report",
      statement: "A signed report exists",
      check: { kind: "human" },
    },
  ];

  async function seedWithSlots(): Promise<string> {
    const id = randomUUID();
    await q(
      `insert into focus_sessions
         (id, user_id, title, goal, status, origin, project_id, expected_outputs, criteria, metadata, agent_ids, started_at, created_at, updated_at)
       values ($1, $2, 'Specs', 'Ship both specs', 'active', 'agent', null,
               $3::jsonb, '[]'::jsonb, '{}'::jsonb, '{}', now(), now(), now())`,
      [id, USER, JSON.stringify([A, C])]
    );
    return id;
  }
  const outputsOf = async (sessionId: string) =>
    (
      await q<{ expected_outputs: Array<Record<string, unknown>> }>(
        `select expected_outputs from focus_sessions where id = $1`,
        [sessionId]
      )
    ).rows[0]!.expected_outputs;
  const setOutputs = (sessionId: string, outputs: unknown[]) =>
    q(`update focus_sessions set expected_outputs = $2::jsonb where id = $1`, [
      sessionId,
      JSON.stringify(outputs),
    ]);

  /** The agent adds B beside a criteria change, so the whole rest proposes. */
  async function fileAgentProposal(sessionId: string) {
    const res = await updateFocusSession({
      sessionId,
      userId: USER,
      agentUserId: AGENT,
      expectedOutputs: [B] as never,
      criteria: CHANGED as never,
    });
    expect(res.status).toBe("proposed");
    const pending = (await proposalsFor(sessionId)).filter(
      (r) => r.status === "pending"
    );
    expect(pending).toHaveLength(1);
    return pending[0]!;
  }

  async function approveRow(
    row: { id: string; data: unknown },
    sessionId: string
  ) {
    const executor = proposalExecRegistry.resolveExact("focus_session/update")!;
    return executor.execute({
      proposal: {
        id: row.id,
        targetId: sessionId,
        workspaceId: null,
        projectId: null,
        subjectUserId: USER,
        agentUserId: AGENT,
        data: row.data,
        targetType: "focus_session",
        proposalType: "update",
      },
      payload: null,
      userId: USER,
      input: { proposalId: row.id },
      deps: {
        reportProposalOutcome: () => undefined,
        emitProposalReviewed: () => undefined,
        emitSideEffects: () => undefined,
        notify: async () => undefined,
      },
    } as never);
  }

  it("the proposal stores the agent's list as sent; the review sees it as it would land", async () => {
    const sessionId = await seedWithSlots();
    const row = await fileAgentProposal(sessionId);
    const payload = payloadOf(row);
    expect(
      (payload.expectedOutputs as Array<{ key?: string }>).map((o) => o.key)
    ).toEqual(["b"]);
    const shown = withAgentOutputsLanding(
      payload,
      { criteria: [], expectedOutputs: await outputsOf(sessionId) },
      true
    )!;
    expect(
      (shown.expectedOutputs as Array<{ key?: string }>).map((o) => o.key)
    ).toEqual(["a", "c", "b"]);
    // A person's list replaces: shown as sent.
    expect(
      withAgentOutputsLanding(
        payload,
        { criteria: [], expectedOutputs: await outputsOf(sessionId) },
        false
      )
    ).toBe(payload);
  });

  it("a slot that moved on before approval does not refuse it, and keeps its state", async () => {
    const sessionId = await seedWithSlots();
    const row = await fileAgentProposal(sessionId);
    await setOutputs(sessionId, [{ ...A, status: "done" }, C]);

    await approveRow(row, sessionId);

    const after = await outputsOf(sessionId);
    expect(after.map((o) => o.key)).toEqual(["a", "c", "b"]);
    expect(after.find((o) => o.key === "a")!.status).toBe("done");
  });

  it("a slot the person deleted before approval does not come back", async () => {
    const sessionId = await seedWithSlots();
    const row = await fileAgentProposal(sessionId);
    await setOutputs(sessionId, [A]);

    await approveRow(row, sessionId);

    expect((await outputsOf(sessionId)).map((o) => o.key)).toEqual(["a", "b"]);
  });
});

describe("M8: a person's edit through their own doors counts as 'touched by a person'", () => {
  const personCaller = () =>
    focusSessionsRouter.createCaller({
      db: h.db,
      authenticated: true,
      userId: USER,
      workspaceId: null,
    } as never);

  it("the person renames the agent's session in the app: the agent's own filing now proposes", async () => {
    const projectId = await seedProject();
    h.focus = projectId;
    const sessionId = await seedOwnFreshSession();

    await personCaller().update({ id: sessionId, title: "My session now" });

    const res = await runWithCallingKey(KEY, () =>
      updateFocusSession({
        sessionId,
        userId: USER,
        agentUserId: AGENT,
        projectId,
      })
    );
    expect(res.status).toBe("proposed");
    expect((await sessionRow(sessionId)).project_id).toBeNull();
  });

  it("CONTROL: untouched, the same filing applies on its receipt", async () => {
    const projectId = await seedProject();
    h.focus = projectId;
    const sessionId = await seedOwnFreshSession();

    const res = await runWithCallingKey(KEY, () =>
      updateFocusSession({
        sessionId,
        userId: USER,
        agentUserId: AGENT,
        projectId,
      })
    );
    expect(res.status).toBe("updated");
    expect((await sessionRow(sessionId)).project_id).toBe(projectId);
  });

  /** A record THIS agent made through THIS key, filed into `projectId`. */
  async function seedOwnFiledRecord(projectId: string): Promise<string> {
    const entityId = randomUUID();
    const receipt = randomUUID();
    await q(
      `insert into entities (id, user_id, workspace_id, type, title, created_at, updated_at)
       values ($1, $2, null, 'note', 'Agent note', now(), now())`,
      [entityId, USER]
    );
    await q(
      `insert into proposals (id, status, target_type, target_id, proposal_type, data, subject_user_id, agent_user_id, api_key_id)
       values ($1, 'auto_approved', 'entity', $2, 'create', '{}'::jsonb, $3, $4, $5)`,
      [receipt, entityId, USER, AGENT, KEY]
    );
    await q(
      `insert into events (id, type, subject_id, subject_type, user_id, agent_user_id, is_agent, proposal_id, source, data, timestamp)
       values ($1, 'entity.create.completed', $2, 'entity', $3, $4, true, $5, 'intelligence', '{}'::jsonb, now())`,
      [randomUUID(), entityId, USER, AGENT, receipt]
    );
    await q(
      `insert into relations (id, user_id, workspace_id, source_entity_id, target_entity_id, type, created_at, updated_at)
       values ($1, $2, null, $3, $4, 'belongs_to_project', now(), now())`,
      [randomUUID(), USER, entityId, projectId]
    );
    return entityId;
  }
  const proof = (projectId: string, entityId: string) =>
    runWithCallingKey(KEY, () =>
      ownWorkOrganiseForFiling({
        agentUserId: AGENT,
        projectId,
        entityIds: [entityId],
      })
    );

  it("the person un-files the agent's record: it is no longer the agent's to re-file on its own", async () => {
    const projectId = await seedProject();
    h.focus = projectId;
    const entityId = await seedOwnFiledRecord(projectId);
    // CONTROL inside the case: before the person acts, the proof holds.
    expect(await proof(projectId, entityId)).toBe(true);

    const res = await fileEntitiesGoverned({
      userId: USER,
      projectId,
      entityIds: [entityId],
      remove: true,
    });
    expect(res.status).toBe("unfiled");

    expect(await proof(projectId, entityId)).toBe(false);
  });
});
