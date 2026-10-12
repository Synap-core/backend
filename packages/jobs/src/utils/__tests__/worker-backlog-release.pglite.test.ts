/**
 * The worker backlog RELEASE on PGlite (arch F12): a held fire is re-run once
 * its backlog has room, and only once.
 *
 * Real: the automation read, the run insert, the release claim (the real
 * unique index), the proposal → enablement read. Mocked, each proven against
 * SQL in `@synap/database` `worker-enablement.pglite.test.ts`: the held list
 * and the pending count. `getBoss().send` records what was enqueued.
 *
 * Rows rule out: a release with no room; a second release of the same held
 * fire (the claim); a per_moment enablement releasing every held fire
 * instead of the newest; an automation that is not a worker; a paused one.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 120_000 });

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  pending: 0,
  held: [] as Array<Record<string, unknown>>,
  sent: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return {
    ...actual,
    db: drizzle(client),
    countWorkerPendingApprovals: vi.fn(async () => h.pending),
    listHeldWorkerRuns: vi.fn(async (_a: string, limit: number) =>
      h.held.slice(0, limit)
    ),
  };
});
vi.mock("@synap/events", () => ({
  getBoss: () => ({
    send: vi.fn(async (_q: string, payload: Record<string, unknown>) => {
      h.sent.push(payload);
    }),
  }),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  automations,
  automationRuns,
  automationClaims,
  proposals,
  focusSessions,
} from "@synap/database/schema";
import {
  releaseHeldWorkerRuns,
  workerAutomationOfProposal,
} from "../worker-backlog-release.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const def =
      c.primary && type === "uuid"
        ? " default gen_random_uuid()"
        : type.startsWith("timestamp") && c.hasDefault
          ? " default now()"
          : "";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const WS = randomUUID();
const T1 = "00000000-0000-4000-8000-000000000001";
const T2 = "00000000-0000-4000-8000-000000000002";
const T3 = "00000000-0000-4000-8000-000000000003";

beforeAll(async () => {
  for (const t of [
    automations,
    automationRuns,
    automationClaims,
    proposals,
    focusSessions,
  ])
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  // The real claim boundary (automation_claims unique index).
  await h.client!.exec(
    `create unique index on automation_claims (workspace_id, namespace, claim_key)`
  );
});

beforeEach(async () => {
  await h.client!.exec(
    "delete from automations; delete from automation_runs; delete from automation_claims; delete from proposals; delete from focus_sessions;"
  );
  h.pending = 0;
  h.held = [];
  h.sent = [];
});

async function automation(
  worker: Record<string, unknown> | null,
  status = "active"
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into automations (id, workspace_id, created_by, name, trigger_type, trigger_config, flow_definition, status)
     values ($1, $2, 'u1', $3, 'event', '{}'::jsonb, $4::jsonb, $5)`,
    [
      id,
      WS,
      `a-${id.slice(0, 6)}`,
      JSON.stringify({
        nodes: [
          { id: "t", type: "trigger", data: {} },
          {
            id: "run",
            type: "playbook_run",
            data: { playbookId: "pb", ...(worker ? { worker } : {}) },
          },
        ],
        edges: [],
      }),
      status,
    ]
  );
  return id;
}
const held = (subject: string) => ({
  runId: randomUUID(),
  workspaceId: WS,
  subjectEntityId: subject,
  triggerEventId: null,
  triggerPayload: {
    eventType: "entity.transition.completed",
    subjectId: subject,
  },
  producerAgentUserId: "agent-1",
});
const PER_THING = {
  key: "enters_status:new",
  size: "per_thing",
  profileSlug: "lead",
  status: "new",
  maxPendingApprovals: 3,
};

describe("releaseHeldWorkerRuns", () => {
  it("room under the backlog → each held fire re-runs once, with its trigger and producer", async () => {
    const a = await automation(PER_THING);
    h.pending = 1; // room = 3 - 1 = 2
    h.held = [held(T1), held(T2), held(T3)];
    const ids = await releaseHeldWorkerRuns(a);
    expect(ids).toHaveLength(2);
    const runs = await q<{
      subject_entity_id: string;
      replay_of: string;
      trigger_payload: Record<string, unknown>;
      triggered_by: string;
    }>(
      `select subject_entity_id, replay_of, trigger_payload, triggered_by from automation_runs order by subject_entity_id`
    );
    expect(runs.rows.map((r) => r.subject_entity_id)).toEqual([T1, T2]);
    expect(runs.rows[0]!.replay_of).toBe(h.held[0]!.runId);
    expect(runs.rows[0]!.trigger_payload).toEqual(h.held[0]!.triggerPayload);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[0]).toMatchObject({
      automationId: a,
      producerAgentUserId: "agent-1",
    });
  });

  it("no room → nothing", async () => {
    const a = await automation(PER_THING);
    h.pending = 3;
    h.held = [held(T1)];
    expect(await releaseHeldWorkerRuns(a)).toEqual([]);
    expect(h.sent).toHaveLength(0);
  });

  it("the same held fire is released once (the claim)", async () => {
    const a = await automation(PER_THING);
    h.held = [held(T1)];
    expect(await releaseHeldWorkerRuns(a)).toHaveLength(1);
    expect(await releaseHeldWorkerRuns(a)).toEqual([]);
    expect(h.sent).toHaveLength(1);
    const skipped = await q(
      `select 1 from automation_runs where status = 'skipped'`
    );
    expect(skipped.rows).toHaveLength(1);
  });

  it("per_moment: only the newest held fire (it works the whole set)", async () => {
    const a = await automation({ ...PER_THING, size: "per_moment" });
    h.held = [held(T1), held(T2), held(T3)];
    expect(await releaseHeldWorkerRuns(a)).toHaveLength(1);
    expect(h.sent).toHaveLength(1);
    const runs = await q<{ subject_entity_id: string }>(
      `select subject_entity_id from automation_runs`
    );
    expect(runs.rows.map((r) => r.subject_entity_id)).toEqual([T3]);
  });

  it("not a worker, or paused → nothing", async () => {
    h.held = [held(T1)];
    expect(await releaseHeldWorkerRuns(await automation(null))).toEqual([]);
    expect(
      await releaseHeldWorkerRuns(await automation(PER_THING, "paused"))
    ).toEqual([]);
    expect(h.sent).toHaveLength(0);
  });
});

describe("workerAutomationOfProposal", () => {
  it("names the enablement directly or through its session; else null", async () => {
    const direct = randomUUID();
    const viaSession = randomUUID();
    const plain = randomUUID();
    const session = randomUUID();
    await q(
      `insert into focus_sessions (id, metadata) values ($1, '{"automationId":"auto-s"}'::jsonb)`,
      [session]
    );
    await q(
      `insert into proposals (id, data, session_id) values ($1, '{"automationId":"auto-d"}'::jsonb, null), ($2, '{}'::jsonb, $3), ($4, '{}'::jsonb, null)`,
      [direct, viaSession, session, plain]
    );
    expect(await workerAutomationOfProposal(direct)).toBe("auto-d");
    expect(await workerAutomationOfProposal(viaSession)).toBe("auto-s");
    expect(await workerAutomationOfProposal(plain)).toBeNull();
  });
});
