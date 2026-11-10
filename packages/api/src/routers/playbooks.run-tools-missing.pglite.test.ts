/**
 * A RUN WHOSE TOOLS LACK WHAT A STEP DECLARES NEVER STARTS (founder, 10 Nov
 * 2026; plan fbfadf54 fix 1a; run 2a231408 ended 12 s in, finding a9cc4848).
 *
 * Driven through the REAL doors (`playbooksRouter.run` → `runPlaybook`,
 * `resolveRunChoice`, `refuseRunMissingTools`; `playbooksRouter.create` /
 * `.update` for the save warning) on PGlite, with the harness of
 * `playbooks.run-choice.pglite.test.ts`; the capability registry read is
 * stubbed so a test says what the pod serves.
 *
 * Asserted (each row rules out a rule that would pass the others):
 *   - a person's run of a playbook whose step names a tool nothing serves is
 *     refused RUN_TOOLS_MISSING naming the step and the tool, and leaves no
 *     session, run, room or proposal (rules out "check after the session");
 *   - an agent's run of it is refused BEFORE the governance gate files a
 *     proposal (rules out "check only in runPlaybook", which runs after
 *     approval);
 *   - the same playbook handed to an awake agent starts (rules out "check
 *     every run whoever does it");
 *   - a playbook whose step tools are a run tool, a served intent and a
 *     visible capability starts and dispatches (rules out "refuse anything
 *     declared");
 *   - a failed registry read starts the run (an unread registry is not a
 *     missing tool);
 *   - the write door saves the lacking playbook and returns a warning; the
 *     ready one gets none.
 *
 * NOT COVERED: the automation `playbook_run` node and Hub/MCP doors reach
 * `runPlaybook` / `playbooks.run` and so this check; they are not driven here.
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

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    close: () => Promise<void>;
  },
  dispatched: [] as Array<{ ref: string }>,
  /** What the governance gate was asked, and what it answers this test. */
  gateCalls: [] as Array<Record<string, unknown>>,
  gateAnswer: null as null | Record<string, unknown>,
  /** What the capability registry lists this test; a string = the read throws. */
  capabilities: [] as unknown[] | string,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  const mocked = { ...actual, getDb: async () => db };
  Object.defineProperty(mocked, "db", { get: () => db, enumerable: true });
  return mocked;
});
vi.mock("../services/playbooks/executors/registry.js", () => ({
  resolveExecutor: (ref: string) => ({
    ref,
    run: async () => {
      h.dispatched.push({ ref });
      return { status: "running" };
    },
  }),
}));
vi.mock("../services/focus-sessions/notify-needs-you.js", () => ({
  notifySessionNeedsYou: async () => undefined,
}));
vi.mock("../services/focus-sessions/session-recall.js", () => ({
  enqueueSessionRecall: async () => undefined,
}));
vi.mock("../utils/domain-event-bridge.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, emitHubRealtimeEvent: () => undefined };
});
vi.mock("../middleware/read-only-guard.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { readOnlyGuardMiddleware: t.middleware(({ next }) => next()) };
});
vi.mock("../middleware/audit-log.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { auditLogMiddleware: t.middleware(({ next }) => next()) };
});
vi.mock("../utils/workspace-write-access.js", () => ({
  assertWorkspaceWrite: async () => undefined,
}));
vi.mock("../services/playbooks/playbook-skill-preflight.js", () => ({
  findUnenabledPlaybookSkills: async () => [],
}));
vi.mock(
  "../services/capabilities/capability-registry.js",
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
      ...actual,
      listCapabilities: async () => {
        if (typeof h.capabilities === "string") throw new Error(h.capabilities);
        return h.capabilities;
      },
    };
  }
);
vi.mock("../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    checkPermissionOrPropose: async (opts: Record<string, unknown>) => {
      h.gateCalls.push(opts);
      return h.gateAnswer ?? { allowed: true };
    },
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { is } from "drizzle-orm";
import { PgTable as PgTableClass } from "drizzle-orm/pg-core";
import * as database from "@synap/database";
import { playbooksRouter } from "./playbooks.js";
import type { Context } from "../types/context.js";

const USER = randomUUID();
/** Claude Code on the person's devbox: its runner served it 30 s ago — awake. */
const RUNNING = randomUUID();
const WS = randomUUID();
/** Its step names `list_playbooks`, which no run here can use. */
const LACKING = randomUUID();
/** Its step names a run tool, a served intent and a visible capability. */
const READY = randomUUID();

const READY_TOOLS = ["get_session", "search_web", "github"];
const SERVED = [
  {
    kind: "tool",
    id: "cap-web",
    name: "Web search",
    verbs: [{ id: "web.search", intent: "search_web", kind: "read" }],
  },
  {
    kind: "tool",
    id: "cap-gh",
    name: "github",
    verbs: [{ id: "github.pr_checks", kind: "read" }],
  },
];

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = t.endsWith("[]") ? t : BASIC.test(t) ? t : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const asPerson = () =>
  playbooksRouter.createCaller({
    authenticated: true,
    userId: USER,
    workspaceId: WS,
  } as unknown as Context);
const asAgent = () =>
  playbooksRouter.createCaller({
    authenticated: true,
    userId: USER,
    agentUserId: RUNNING,
    workspaceId: WS,
  } as unknown as Context);

const count = (table: string) =>
  q<{ n: number }>(`select count(*)::int as n from ${table}`).then(
    (r) => r.rows[0]!.n
  );

const stages = (tools: string[]) =>
  JSON.stringify([
    { key: "read", name: "Read the runs", category: "started", tools },
    { key: "done", name: "Done", category: "completed" },
  ]);

beforeAll(async () => {
  const seen = new Set<string>();
  for (const t of Object.values(database)) {
    if (!is(t, PgTableClass)) continue;
    const name = getTableConfig(t as PgTable).name;
    if (seen.has(name)) continue;
    seen.add(name);
    await h.client!.exec(ddlFor(t as PgTable));
  }
  expect(seen.size).toBeGreaterThan(50);
  await h.client!.exec(
    `create unique index on links (from_type, from_id, to_type, to_id, link_type)`
  );
  await q(
    `insert into users (id, email, name, user_type, agent_type, created_by_user_id) values
      ($1, 'a@x.test', 'Antoine', 'human', null, null),
      ($2, 'cc@x.test', 'Claude Code', 'agent', 'claude-code', $1)`,
    [USER, RUNNING]
  );
  await q(
    `insert into api_keys (id, user_id, key_type, is_active, linked_user_id, last_used_at, instance_label, worker_served_at, created_at) values
      ($1, $2, 'hub_inbound', true, $3, now(), 'devbox', now() - interval '30 seconds', now())`,
    [randomUUID(), RUNNING, USER]
  );
  await q(`insert into workspaces (id, name) values ($1, 'Builder')`, [WS]);
  await q(
    `insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')`,
    [WS, USER]
  );
  for (const [id, name, tools] of [
    [LACKING, "Read the runs", ["list_playbooks", "get_session"]],
    [READY, "Read sessions", READY_TOOLS],
  ] as const) {
    await q(
      `insert into playbooks (id, workspace_id, created_by, name, goal_template, executor, status, metadata, params, input_strategy, channel_spec, expected_outputs, stages, criteria, tools)
       values ($1, $2, $3, $4, 'Read the runs', 'is-agent', 'active', '{}'::jsonb, '[]'::jsonb, '{"kind":"none"}'::jsonb, '{}'::jsonb, '[]'::jsonb, $5::jsonb, '[]'::jsonb, $6::jsonb)`,
      [id, WS, USER, name, stages([...tools]), JSON.stringify(tools)]
    );
  }
});

beforeEach(async () => {
  h.dispatched.length = 0;
  h.gateCalls.length = 0;
  h.gateAnswer = null;
  h.capabilities = SERVED;
  await h.client!.exec(
    "delete from focus_sessions; delete from playbook_runs; delete from channels; delete from links; delete from proposals;"
  );
});

afterAll(async () => {
  await h.client?.close();
});

describe("a step names a tool no run here can use", () => {
  it("a person's run is refused RUN_TOOLS_MISSING, naming the step and the tool, and nothing is left behind", async () => {
    const err = await asPerson()
      .run({ playbookId: LACKING })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: "PRECONDITION_FAILED",
      cause: {
        reasonCode: "RUN_TOOLS_MISSING",
        missing: [
          {
            stageKey: "read",
            stageName: "Read the runs",
            missing: ["list_playbooks"],
          },
        ],
      },
    });
    expect((err as Error).message).toMatch(
      /step "Read the runs" needs list_playbooks.*Nothing was started/
    );
    expect(h.dispatched).toEqual([]);
    for (const table of [
      "focus_sessions",
      "playbook_runs",
      "channels",
      "proposals",
    ]) {
      expect([table, await count(table)]).toEqual([table, 0]);
    }
  });

  it("an agent's run is refused before the governance gate files a proposal", async () => {
    h.gateAnswer = { proposalId: "11111111-1111-4111-8111-111111111111" };
    await expect(asAgent().run({ playbookId: LACKING })).rejects.toMatchObject({
      cause: { reasonCode: "RUN_TOOLS_MISSING" },
    });
    expect(h.gateCalls).toEqual([]);
    expect(await count("focus_sessions")).toBe(0);
  });

  it("handed to an awake agent, it starts (the agent brings its own tools)", async () => {
    await asPerson().run({ playbookId: LACKING, handToAgentId: RUNNING });
    expect(h.dispatched).toEqual([]);
    expect(await count("playbook_runs")).toBe(1);
  });

  it("starts when the registry cannot be read (unread is not missing)", async () => {
    h.capabilities = "registry down";
    await asPerson().run({ playbookId: LACKING });
    expect(h.dispatched.map((d) => d.ref)).toEqual(["is-agent"]);
  });
});

describe("every step tool resolves", () => {
  it("a run tool, a served intent and a visible capability: the run starts", async () => {
    await asPerson().run({ playbookId: READY });
    expect(h.dispatched.map((d) => d.ref)).toEqual(["is-agent"]);
    expect(await count("playbook_runs")).toBe(1);
  });

  it("the same playbook is refused once the pod no longer serves the capability", async () => {
    h.capabilities = SERVED.filter((c) => c.name !== "github");
    await expect(asPerson().run({ playbookId: READY })).rejects.toMatchObject({
      cause: {
        reasonCode: "RUN_TOOLS_MISSING",
        missing: [{ stageKey: "read", missing: ["github"] }],
      },
    });
  });
});

describe("the write door warns, never refuses", () => {
  it("create saves a playbook whose step names a tool no run here can use, with a warning", async () => {
    const res = await asPerson().create({
      name: "Read the runs again",
      goalTemplate: "Read the runs",
      tools: ["list_playbooks"],
      stages: JSON.parse(stages(["list_playbooks"])),
    });
    expect(res.status).toBe("created");
    expect(res.playbook).not.toBeNull();
    expect("warnings" in res && res.warnings).toEqual([
      expect.stringMatching(
        /will refuse to start: its step "Read the runs" needs list_playbooks/
      ),
    ]);
  });

  it("create gives no warning when every step tool resolves", async () => {
    const res = await asPerson().create({
      name: "Read sessions again",
      goalTemplate: "Read the runs",
      tools: READY_TOOLS,
      stages: JSON.parse(stages(READY_TOOLS)),
    });
    expect(res.status).toBe("created");
    expect("warnings" in res).toBe(false);
  });

  it("update warns over the merged row when the patch touches the steps", async () => {
    const res = await asPerson().update({
      id: READY,
      tools: [...READY_TOOLS, "list_playbooks"],
      stages: JSON.parse(stages([...READY_TOOLS, "list_playbooks"])),
    });
    expect(res.status).toBe("updated");
    expect("warnings" in res && res.warnings).toEqual([
      expect.stringMatching(/step "Read the runs" needs list_playbooks/),
    ]);
  });
});
