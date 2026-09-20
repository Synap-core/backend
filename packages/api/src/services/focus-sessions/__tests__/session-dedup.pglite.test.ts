/**
 * ONE session per goal + scope — the dedup door, on BOTH create doors.
 *
 * Live (2026-09-13): each duplicate pair was the `focus_session/create`
 * executor's insert followed ms later by a direct `createFocusSession` of the
 * same goal. Both doors now ask `findOpenSessionTwin` before inserting.
 * Reachability, not shape: rows are counted back from PGlite.
 *
 * Real: `createFocusSession`, `findOpenSessionTwin`, the registered executor,
 * `buildPlanCallers`' session caller, `buildMaterializedRecord`. Tables are
 * generated from the Drizzle definitions.
 *
 * Stubbed, and why (same as `create-session-lineage.pglite.test.ts`):
 * `checkPermissionOrPropose` (grants on demand), `resolveSessionProjectPlacement`
 * (echoes the caller's project), `recordSessionSpawn` / `ensureSessionChannel`
 * / realtime emit (own connections).
 *
 * NOT covered: the tRPC / Hub REST / MCP doors' `forceCreate` plumbing and the
 * REST approve response (typecheck only).
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    close: () => Promise<void>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return {
    ...actual,
    db: drizzle(client, {
      schema: {
        focusSessions: actual.focusSessions as never,
        playbooks: actual.playbooks as never,
      },
    }),
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

vi.mock("../../../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    checkPermissionOrPropose: async () => ({ granted: true }),
  };
});

vi.mock("../ensure-session-channel.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, ensureSessionChannel: async () => null };
});

vi.mock("../../../utils/domain-event-bridge.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, emitHubRealtimeEvent: () => undefined };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  focusSessions,
  proposals,
  links,
  playbooks,
  type db as DatabaseHandle,
} from "@synap/database";
import { createFocusSession } from "../create-session.js";
import { registerFocusSessionExecutors } from "../../../routers/proposals/executors/focus-session.js";
import { proposalExecRegistry } from "../../../routers/proposals/execution-registry.js";
import { buildPlanCallers } from "../../../utils/plan-callers.js";
import { buildMaterializedRecord } from "../../proposals/stamp-materialized.js";

const USER = "user-1";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "22222222-2222-4222-8222-222222222222";
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t : "text";
    const def =
      c.name === "status"
        ? " default 'active'"
        : c.name === "started_at"
          ? " default now()"
          : "";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const countByGoal = (goal: string) =>
  q<{ n: number }>(
    `select count(*)::int as n from focus_sessions where goal = $1`,
    [goal]
  ).then((r) => r.rows[0].n);

async function seed(opts: {
  goal: string;
  status?: string;
  projectId?: string | null;
  workspaceId?: string | null;
  correlationId?: string | null;
}): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, project_id, workspace_id, correlation_id, expected_outputs, agent_ids, metadata, created_at, updated_at, started_at)
     values ($1, $2, $3, $4, $5, $6, $7, '[]'::jsonb, '{}', '{}'::jsonb, now(), now(), now())`,
    [
      id,
      USER,
      opts.goal,
      opts.status ?? "active",
      opts.projectId ?? null,
      opts.workspaceId ?? null,
      opts.correlationId ?? null,
    ]
  );
  return id;
}

async function approve(opts: {
  goal: string;
  correlationId?: string | null;
  projectId?: string | null;
}) {
  const proposalId = randomUUID();
  const targetId = randomUUID();
  const data = { goal: opts.goal };
  await q(
    `insert into proposals (id, status, proposal_type, target_type, target_id, data, created_at, updated_at)
     values ($1, 'pending', 'create', 'focus_session', $2, $3::jsonb, now(), now())`,
    [proposalId, targetId, JSON.stringify({ data })]
  );
  const executor = proposalExecRegistry.resolveExact("focus_session/create")!;
  const result = await executor.execute({
    proposal: {
      id: proposalId,
      targetId,
      workspaceId: null,
      projectId: opts.projectId ?? null,
      subjectUserId: USER,
      correlationId: opts.correlationId ?? null,
      data: { data },
      targetType: "focus_session",
      proposalType: "create",
    },
    payload: null,
    userId: USER,
    input: { proposalId },
    ctx: {},
    deps: {
      emitProposalReviewed: () => undefined,
      reportProposalOutcome: () => undefined,
    },
  } as never);
  return { result, targetId };
}

describe("session dedup — one open session per goal + scope", () => {
  beforeAll(async () => {
    for (const t of [focusSessions, proposals, links, playbooks]) {
      await h.client!.exec(ddlFor(t as unknown as PgTable));
    }
    await h.client!.exec(
      `create unique index idx_focus_sessions_correlation_id on focus_sessions (correlation_id);`
    );
    registerFocusSessionExecutors();
  }, 120_000);

  afterAll(async () => {
    await h.client?.close();
  });

  beforeEach(async () => {
    await h.client!.exec(
      "delete from focus_sessions; delete from proposals; delete from links;"
    );
  });

  describe("createFocusSession", () => {
    it("same goal + same scope + open ⇒ the EXISTING session, `deduped`, no second row", async () => {
      const existing = await seed({ goal: "Ship billing", projectId: PROJECT });
      const res = await createFocusSession({
        userId: USER,
        projectId: PROJECT,
        // Whitespace differences are the same goal (normalizeGoal).
        goal: "  Ship   billing ",
      });
      expect(res.status).toBe("deduped");
      if (res.status !== "deduped") return;
      expect(res.session.id).toBe(existing);
      expect(await countByGoal("Ship billing")).toBe(1);
      expect((await q(`select id from focus_sessions`)).rows).toHaveLength(1);
    });

    it("a different scope ⇒ created", async () => {
      await seed({ goal: "Ship billing", projectId: OTHER_PROJECT });
      const res = await createFocusSession({
        userId: USER,
        projectId: PROJECT,
        goal: "Ship billing",
      });
      expect(res.status).toBe("created");
      expect(await countByGoal("Ship billing")).toBe(2);
    });

    it("a CLOSED twin ⇒ created", async () => {
      await seed({
        goal: "Ship billing",
        projectId: PROJECT,
        status: "closed",
      });
      const res = await createFocusSession({
        userId: USER,
        projectId: PROJECT,
        goal: "Ship billing",
      });
      expect(res.status).toBe("created");
      expect(await countByGoal("Ship billing")).toBe(2);
    });

    it("forceCreate ⇒ created even with an open twin", async () => {
      await seed({ goal: "Ship billing", projectId: PROJECT });
      const res = await createFocusSession({
        userId: USER,
        projectId: PROJECT,
        goal: "Ship billing",
        forceCreate: true,
      });
      expect(res.status).toBe("created");
      expect(await countByGoal("Ship billing")).toBe(2);
    });

    it("a NEAR goal is only a candidate — the session is still created", async () => {
      // Token sets {ship, billing, paying, customers, today} vs the same minus
      // `today` ("to" is a stopword): overlap 4/5 = 0.8, exactly at the
      // `NEAR_MATCH_THRESHOLD`, and not the same normalized goal.
      const near = await seed({
        goal: "Ship billing to paying customers today",
        projectId: PROJECT,
      });
      const res = await createFocusSession({
        userId: USER,
        projectId: PROJECT,
        goal: "Ship billing to paying customers",
      });
      expect(res.status).toBe("created");
      if (res.status !== "created") return;
      expect(res.candidates?.map((c) => c.id)).toEqual([near]);
    });
  });

  describe("focus_session/create executor", () => {
    it("stamps the proposal's correlationId on the inserted session", async () => {
      const correlationId = randomUUID();
      const { targetId, result } = await approve({
        goal: "Write the spec",
        correlationId,
      });
      const { rows } = await q<{ correlation_id: string | null }>(
        `select correlation_id from focus_sessions where id = $1`,
        [targetId]
      );
      expect(rows).toEqual([{ correlation_id: correlationId }]);
      expect(result.primaryId).toBe(targetId);
    });

    it("LINKS to an existing open twin instead of inserting a second", async () => {
      const existing = await seed({ goal: "Write the spec" });
      const { targetId, result } = await approve({ goal: "Write the spec" });
      expect(result).toMatchObject({
        success: true,
        primaryId: existing,
        linked: 1,
        effect: { applied: "none" },
      });
      expect(await countByGoal("Write the spec")).toBe(1);
      expect(
        (await q(`select id from focus_sessions where id = $1`, [targetId]))
          .rows
      ).toEqual([]);
      const { rows } = await q<{ status: string }>(
        `select status from proposals`
      );
      expect(rows).toEqual([{ status: "approved" }]);
    });

    it("a chain SIBLING (same correlationId, different goal) is created, not linked", async () => {
      const correlationId = randomUUID();
      await seed({ goal: "Root", correlationId });
      const { targetId, result } = await approve({
        goal: "Child",
        correlationId,
      });
      expect(result.primaryId).toBe(targetId);
      expect(await countByGoal("Child")).toBe(1);
    });

    it("then a direct create of the same goal returns the approved session (the live pair)", async () => {
      const { targetId } = await approve({ goal: "Write the spec" });
      const res = await createFocusSession({
        userId: USER,
        goal: "Write the spec",
      });
      expect(res.status).toBe("deduped");
      if (res.status === "deduped") expect(res.session.id).toBe(targetId);
      expect(await countByGoal("Write the spec")).toBe(1);
    });
  });

  describe("connected plan — session step with a pre-existing twin", () => {
    it("links the existing session (no throw) and never lists it for compensation", async () => {
      const existing = await seed({ goal: "Draft offer", projectId: PROJECT });
      const callers = buildPlanCallers({
        database: {} as typeof DatabaseHandle,
        userId: USER,
        sessionOwnerUserId: USER,
        workspaceId: null,
        entityCaller: { update: vi.fn() },
        proposal: { id: null, sessionId: null },
      });
      const out = await callers.sessionCaller.create({
        title: null,
        goal: "Draft offer",
        subjectEntityId: null,
        projectId: PROJECT,
        expectedOutputs: [],
        criteria: [],
      });
      expect(out).toEqual({ id: existing, linked: true });
      expect(await countByGoal("Draft offer")).toBe(1);

      const record = buildMaterializedRecord({
        entities: [],
        relations: [],
        sessions: [
          { ref: "s0", opIndex: 0, sessionId: existing, linked: true },
        ],
      } as never);
      expect(record.sessionIds ?? []).toEqual([]);
      expect(record.byOp?.s0).toMatchObject({ linked: true });
    });
  });
});
