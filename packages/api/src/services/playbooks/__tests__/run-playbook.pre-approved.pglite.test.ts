/**
 * A person lets agents run ONE playbook without asking (founder decision,
 * 10 Nov 2026, proposal a01b9d46): when the run door's grant names that rule
 * (`preApprovedByRuleId`), an agent's run starts at once instead of waiting
 * as the person's draft (B6), as long as it stays what the person allowed:
 * pod data only, the pod's own AI, no other playbook. Otherwise it is held as
 * before, and the reply says why.
 *
 * Same harness as `run-playbook.agent-draft.pglite.test.ts` (real
 * `runPlaybook` on PGlite, the executor captured), plus `governance_rules`
 * for the "an earlier version was allowed" read.
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
  playbook: {} as Record<string, unknown>,
  granted: [] as unknown[],
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
      version: 3,
      runner: null,
      requiredIntents: [],
      ...h.playbook,
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
  resolveGrantedCapabilities: async () => h.granted,
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
  links,
  users,
  governanceRules,
} from "@synap/database";
import { runPlaybook } from "../run-playbook.js";

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
    // A run that names nobody asks THE route for the playbook's assigned
    // agent (`resolveRunHandOff`): no assignment here, so nothing changes.
    links,
    users,
    governanceRules,
  ]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
});

beforeEach(async () => {
  h.dispatched.length = 0;
  h.playbook = {};
  h.granted = [];
  await h.client!.exec(
    "delete from focus_sessions; delete from channels; delete from playbook_runs; delete from governance_rules;"
  );
});

const RULE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const agentRun = (preApprovedByRuleId?: string) =>
  runPlaybook({
    playbookId: PLAYBOOK,
    workspaceId: WS,
    userId: PERSON,
    agentUserId: AGENT,
    params: { question: "Who sells to bakeries?" },
    ...(preApprovedByRuleId ? { preApprovedByRuleId } : {}),
  });

describe("an agent's run of a playbook the person allowed beforehand", () => {
  it("starts at once: run row running, dispatched once, born accepted under the rule", async () => {
    const r = await agentRun(RULE);
    expect(r.held).toBeUndefined();
    expect(r.run?.status).toBe("running");
    expect(h.dispatched).toHaveLength(1);
    expect(await runsOf(r.session!.id)).toHaveLength(1);
    // Still the agent's start (origin), but accepted in advance by the rule.
    expect(r.session?.origin).toBe("agent");
    const metadata = await metadataOf(r.session!.id);
    expect(metadata.heldRun).toBeUndefined();
    expect(metadata.triage).toMatchObject({
      acceptedBy: PERSON,
      preApprovedByRuleId: RULE,
    });
  });

  it("CONTROL — without the rule the same run is held as the person's draft", async () => {
    const r = await agentRun();
    expect(r.held).toBe(true);
    expect(r.heldBecause).toBeUndefined();
    expect(h.dispatched).toHaveLength(0);
    expect(await runsOf(r.session!.id)).toHaveLength(0);
  });

  it("is held, and says so, when a rule allows an EARLIER version of this playbook", async () => {
    await q(
      `insert into governance_rules (principal_kind, scope_kind, target_kind, target_pattern, verdict, created_by, target_subject_id, target_subject_version)
       values ('any', 'pod', 'action', 'playbook.run', 'auto', 'user:x', $1, 2)`,
      [PLAYBOOK]
    );
    const r = await agentRun();
    expect(r).toMatchObject({ held: true, heldBecause: "version_changed" });
    expect(h.dispatched).toHaveLength(0);
  });

  it("is held when the playbook uses tools beyond pod data (a step grant, a grants link, an intent)", async () => {
    for (const [playbook, granted] of [
      [
        {
          stages: [
            { key: "s", title: "S", grants: [{ kind: "tool", id: "gmail" }] },
          ],
        },
        [],
      ],
      [{}, [{ kind: "tool", id: "gmail", name: "Gmail" }]],
      [{ requiredIntents: ["send-email"] }, []],
    ] as const) {
      h.playbook = playbook as Record<string, unknown>;
      h.granted = [...granted];
      const r = await agentRun(RULE);
      expect(r).toMatchObject({ held: true, heldBecause: "declares_tools" });
    }
    expect(h.dispatched).toHaveLength(0);
  });

  it("is held when the run goes to another agent or computer", async () => {
    for (const playbook of [
      { executor: "external-agent" },
      { runner: { role: "coder", computer: "devbox" } },
      { stages: [{ key: "s", title: "S", runner: { engine: "claude-code" } }] },
    ]) {
      h.playbook = playbook;
      const r = await agentRun(RULE);
      expect(r).toMatchObject({ held: true, heldBecause: "runs_elsewhere" });
    }
    expect(h.dispatched).toHaveLength(0);
  });

  it("is held when a step runs another playbook", async () => {
    h.playbook = {
      stages: [
        { key: "s", title: "S", uses: { playbookId: RULE, version: 1 } },
      ],
    };
    const r = await agentRun(RULE);
    expect(r).toMatchObject({ held: true, heldBecause: "runs_other_playbook" });
  });

  it("Synap AI as the named runner still starts at once", async () => {
    h.playbook = {
      runner: ["synap_ai", { synapAi: { persona: "researcher" } }],
    };
    const r = await agentRun(RULE);
    expect(r.held).toBeUndefined();
    expect(h.dispatched).toHaveLength(1);
  });
});
