/**
 * B6 (founder default, FB1020 wave-2 fix round): a run an agent starts
 * DIRECTLY waits as the person's draft and does NOT execute until they accept
 * it — through the existing triage-accept door (`acceptFromTriage`).
 *
 * Before: the draft was only a triage DISPLAY. `runPlaybook` dispatched the
 * run at once, so the agent's run was already working while it "waited".
 *
 * Real, on PGlite: `runPlaybook` → `executeSingleRun` (channel, run ledger,
 * the hold), `acceptFromTriage` (the stamp, the claim) → `startHeldRun` →
 * the shared dispatch → `recordExecutorResult`. Rows are read back.
 *
 * Stubbed, and why: the playbook resolver + `instantiateSession` (their own
 * suites; the stub inserts the session row the real one would, with the
 * `origin` it is asked for), the executor (CAPTURED — the dispatch is what is
 * under test), grants (no links), needs-you notify and the event/side-effect
 * appends (no transport).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 120_000 });

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  dispatched: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, {
    schema: {
      focusSessions: actual.focusSessions as never,
      channels: actual.channels as never,
      playbookRuns: actual.playbookRuns as never,
      entities: actual.entities as never,
    },
  });
  const mocked = { ...actual, getDb: async () => db };
  Object.defineProperty(mocked, "db", { get: () => db, enumerable: true });
  return mocked;
});

vi.mock("../playbook-lifecycle.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../playbook-lifecycle.js")>();
  return {
    ...actual,
    resolveRunnablePlaybook: vi.fn(async () => ({
      id: PLAYBOOK,
      name: "Research a Question",
      executor: "is-agent",
      metadata: {},
      inputStrategy: null,
      goalTemplate: "Research it",
      stages: [],
      params: [],
    })),
    instantiateSession: vi.fn(
      async (i: {
        userId: string;
        workspaceId: string;
        origin?: string;
        agentIds?: string[];
        metadata?: unknown;
      }) => {
        const id = randomUUID();
        await h.client!.query(
          `insert into focus_sessions (id, user_id, workspace_id, goal, status, playbook_id, origin, agent_ids, metadata, expected_outputs, started_at, updated_at, created_at)
           values ($1, $2, $3, 'Research it', 'active', $4, $5, $6, $7::jsonb, '[]'::jsonb, now(), now(), now())`,
          [
            id,
            i.userId,
            i.workspaceId,
            PLAYBOOK,
            i.origin ?? "human",
            i.agentIds ?? [],
            JSON.stringify(i.metadata ?? {}),
          ]
        );
        return { id, workspaceId: i.workspaceId, expectedOutputs: [] };
      }
    ),
  };
});
vi.mock("../executors/registry.js", () => ({
  resolveExecutor: () => ({
    run: async (ctx: Record<string, unknown>) => {
      h.dispatched.push(ctx);
      return { status: "running" };
    },
  }),
}));
vi.mock("../../links/links-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getLinksFor: async () => [],
  resolveGrantedCapabilities: async () => [],
}));
vi.mock("../../focus-sessions/notify-needs-you.js", () => ({
  notifySessionNeedsYou: async () => undefined,
}));
vi.mock("../../../lib/event-helpers.js", () => ({
  logEvent: async () => "evt",
}));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: async () => undefined,
}));

import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  focusSessions,
  channels,
  playbookRuns,
  playbookEnrollments,
  entities,
} from "@synap/database";
import { runPlaybook, startHeldRun } from "../run-playbook.js";
import { acceptFromTriage } from "../../focus-sessions/triage.js";

const PERSON = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const WS = "44444444-4444-4444-8444-444444444444";
const PLAYBOOK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const columns = cfg.columns.map((c) => {
    let type = c.getSQLType();
    if (/vector/.test(type) || c.columnType === "PgEnumColumn") type = "text";
    let def = "";
    const d = c.default as unknown;
    if (d !== undefined && !(d instanceof SQL)) {
      if (typeof d === "string") def = ` default '${d.replace(/'/g, "''")}'`;
      else if (typeof d === "number" || typeof d === "boolean")
        def = ` default ${d}`;
      else if (type.endsWith("[]")) def = ` default '{}'`;
      else def = ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
    } else if (type.startsWith("timestamp") && c.hasDefault) {
      def = " default now()";
    } else if (c.primary && type === "uuid") {
      def = " default gen_random_uuid()";
    }
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${columns.join(", ")});`;
}
const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const runsOf = async (sessionId: string) =>
  (
    await q<{ id: string; status: string; created_by: string }>(
      `select id, status, created_by from playbook_runs where session_id = $1`,
      [sessionId]
    )
  ).rows;
const metadataOf = async (sessionId: string) =>
  (
    await q<{ metadata: Record<string, unknown> }>(
      `select metadata from focus_sessions where id = $1`,
      [sessionId]
    )
  ).rows[0]!.metadata;

beforeAll(async () => {
  for (const t of [
    focusSessions,
    channels,
    playbookRuns,
    playbookEnrollments,
    entities,
  ]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
});

beforeEach(async () => {
  h.dispatched.length = 0;
  await h.client!.exec(
    "delete from focus_sessions; delete from channels; delete from playbook_runs;"
  );
});

describe("B6 — an agent's direct run waits for the person's acceptance", () => {
  it("is HELD: a draft session and its room exist, but no run row and nothing dispatched", async () => {
    const r = await runPlaybook({
      playbookId: PLAYBOOK,
      workspaceId: WS,
      userId: PERSON,
      agentUserId: AGENT,
      params: { question: "Who sells to bakeries?" },
      agentType: "researcher",
    });
    expect(r.held).toBe(true);
    expect(r.run).toBeNull();
    expect(r.session?.origin).toBe("agent");
    expect(r.session?.channelId).toBeTruthy();
    expect(h.dispatched).toHaveLength(0);
    expect(await runsOf(r.session!.id)).toHaveLength(0);
    expect((await metadataOf(r.session!.id)).heldRun).toMatchObject({
      params: { question: "Who sells to bakeries?" },
      agentType: "researcher",
    });
  });

  it("starts ONCE when the person accepts the draft, with the params and agent it was asked with", async () => {
    const r = await runPlaybook({
      playbookId: PLAYBOOK,
      workspaceId: WS,
      userId: PERSON,
      agentUserId: AGENT,
      params: { question: "Who sells to bakeries?" },
      agentType: "researcher",
    });
    const sessionId = r.session!.id;

    const accepted = await acceptFromTriage({ sessionId, userId: PERSON });
    expect(accepted.ok).toBe(true);
    const runs = await runsOf(sessionId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "running", created_by: PERSON });
    expect(accepted).toMatchObject({
      heldRun: { status: "started", runId: runs[0]!.id },
    });
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]).toMatchObject({
      sessionId,
      channelId: r.session!.channelId,
      userId: PERSON,
      agentType: "researcher",
      input: { question: "Who sells to bakeries?", runId: runs[0]!.id },
    });
    expect((await metadataOf(sessionId)).heldRun).toBeUndefined();

    // A second acceptance (or a direct retry) starts nothing.
    expect(await acceptFromTriage({ sessionId, userId: PERSON })).toEqual({
      ok: false,
      reason: "not_pending",
    });
    expect(await startHeldRun(sessionId)).toEqual({ status: "nothing_held" });
    expect(h.dispatched).toHaveLength(1);
    expect(await runsOf(sessionId)).toHaveLength(1);
  });

  it("CONTROL — a run nobody's agent started dispatches at once, as before", async () => {
    const r = await runPlaybook({
      playbookId: PLAYBOOK,
      workspaceId: WS,
      userId: PERSON,
      agentIds: [AGENT],
    });
    expect(r.held).toBeUndefined();
    expect(r.run?.status).toBe("running");
    expect(h.dispatched).toHaveLength(1);
    expect((await metadataOf(r.session!.id)).heldRun).toBeUndefined();
  });
});
