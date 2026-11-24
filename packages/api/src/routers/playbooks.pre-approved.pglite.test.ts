/**
 * A person lets THEIR agents run one playbook without asking, end to end
 * (founder decision, 10 Nov 2026; plan fbfadf54 §6), through the REAL doors on
 * PGlite: `governanceRules.create` (the person's rule, from
 * `playbookPreApprovalRule`), `governanceRules.forSubject` (what the page
 * reads), and `playbooksRouter.run` as an agent, with the REAL governance gate
 * (`checkPermissionOrPropose` → `resolveGovernanceRule`) and `runPlaybook`.
 *
 * Asserted (each row rules out a rule that would pass the others):
 *   - with the person's rule, their agent's run starts at once, born accepted
 *     under that rule (rules out "the rule never reaches the hold");
 *   - without it, the same run waits as the person's draft (control);
 *   - another member's agent in the same space is not covered: its run waits
 *     as that member's draft (rules out "any agent in the scope", S5/D2);
 *   - `forSubject` says a playbook declaring a capability is not eligible,
 *     and its run is held with that reason on the draft (C4, C8).
 *
 * Stubbed: the executor (records the dispatch), notifications, realtime, the
 * capability registry read, the read-only and audit middleware.
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
  /** What the REAL governance gate answered the run door, last call. */
  perm: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  const mocked = {
    ...actual,
    getDb: async () => db,
    // The gate's receipt writer and its dedup peek, on this database (their
    // default handle is their own connection, which PGlite does not serve).
    insertPendingProposal: (input: unknown) =>
      (actual.insertPendingProposal as (i: unknown, e: unknown) => unknown)(
        input,
        db
      ),
    findExistingPendingDuplicate: (input: unknown) =>
      (
        actual.findExistingPendingDuplicate as (
          i: unknown,
          e: unknown
        ) => unknown
      )(input, db),
  };
  Object.defineProperty(mocked, "db", { get: () => db, enumerable: true });
  return mocked;
});
vi.mock("../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const real = actual.checkPermissionOrPropose as (o: unknown) => unknown;
  return {
    ...actual,
    checkPermissionOrPropose: async (opts: unknown) => {
      h.perm = await real(opts);
      return h.perm;
    },
  };
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
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    listCapabilities: async () => [],
  })
);

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { is } from "drizzle-orm";
import { PgTable as PgTableClass } from "drizzle-orm/pg-core";
import * as database from "@synap/database";
import { playbookPreApprovalRule } from "@synap-core/types/governance-rules";
import { playbooksRouter } from "./playbooks.js";
import { governanceRulesRouter } from "./governance-rules.js";
import type { Context } from "../types/context.js";

const PERSON = randomUUID();
const AGENT = randomUUID();
const OTHER = randomUUID();
const OTHER_AGENT = randomUUID();
const WS = randomUUID();
/** Works on pod data only. */
const PB = randomUUID();
/** Declares a capability (`gmail`): never pre-approvable. */
const PB_TOOLS = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = t.endsWith("[]") ? t : BASIC.test(t) ? t : "text";
    const dflt =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : "";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}${dflt}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const asPerson = (userId = PERSON) =>
  governanceRulesRouter.createCaller({
    authenticated: true,
    userId,
    workspaceId: WS,
  } as unknown as Context);
/** An agent's launch as its doors make it: the person's call naming the agent. */
const agentRun = (userId: string, agentUserId: string, playbookId: string) =>
  playbooksRouter
    .createCaller({
      authenticated: true,
      userId,
      agentUserId,
      workspaceId: WS,
    } as unknown as Context)
    .run({ playbookId, agentUserId });

const triageOf = async (sessionId: string) =>
  (
    await q<{ metadata: { triage?: Record<string, unknown> } }>(
      `select metadata from focus_sessions where id = $1`,
      [sessionId]
    )
  ).rows[0]!.metadata.triage;

beforeAll(async () => {
  const seen = new Set<string>();
  for (const t of Object.values(database)) {
    if (!is(t, PgTableClass)) continue;
    const name = getTableConfig(t as PgTable).name;
    if (seen.has(name)) continue;
    seen.add(name);
    await h.client!.exec(ddlFor(t as PgTable));
  }
  await h.client!.exec(
    `create unique index on links (from_type, from_id, to_type, to_id, link_type)`
  );
  await q(
    `insert into users (id, email, name, user_type, agent_type, created_by_user_id) values
      ($1, 'p@x.test', 'Person', 'human', null, null),
      ($2, 'a@x.test', 'Agent', 'agent', 'claude-code', $1),
      ($3, 'o@x.test', 'Other', 'human', null, null),
      ($4, 'oa@x.test', 'Other agent', 'agent', 'claude-code', $3)`,
    [PERSON, AGENT, OTHER, OTHER_AGENT]
  );
  await q(`insert into workspaces (id, name) values ($1, 'Shared')`, [WS]);
  await q(
    // Each agent is a member of the space too: an agent outside it is asked
    // to join first (a `join` proposal), whatever the rule says.
    `insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'owner'), ($1, $4, 'editor'), ($1, $5, 'editor')`,
    [WS, PERSON, OTHER, AGENT, OTHER_AGENT]
  );
  for (const [id, name, tools] of [
    [PB, "Summarize the week", []],
    [PB_TOOLS, "Mail the week", ["gmail"]],
  ] as const) {
    await q(
      `insert into playbooks (id, workspace_id, created_by, name, goal_template, executor, status, metadata, params, input_strategy, channel_spec, expected_outputs, stages, criteria, tools, version)
       values ($1, $2, $3, $4, 'Summarize', 'is-agent', 'active', '{}'::jsonb, '[]'::jsonb, '{"kind":"none"}'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, $5::jsonb, 3)`,
      [id, WS, PERSON, name, JSON.stringify(tools)]
    );
  }
});

beforeEach(async () => {
  h.dispatched.length = 0;
  await h.client!.exec(
    "delete from focus_sessions; delete from playbook_runs; delete from channels; delete from proposals; delete from governance_rules;"
  );
});

afterAll(async () => {
  await h.client?.close();
});

const allow = (playbookId: string, userId = PERSON) =>
  asPerson(userId).create(
    playbookPreApprovalRule({ id: playbookId, version: 3, workspaceId: WS })
  );

describe("a person lets their agents run one playbook without asking", () => {
  it("their agent's run starts at once, born accepted under their rule", async () => {
    const { rule } = await allow(PB);
    const page = await asPerson().forSubject({ subjectId: PB });
    expect(page.preApproval).toEqual({ eligible: true, reason: null });
    expect(page.rules.map((r) => r.id)).toEqual([rule!.id]);

    const res = await agentRun(PERSON, AGENT, PB);
    // Stringified so a refusal shows the gate's whole answer (reason included).
    expect(JSON.stringify(h.perm)).toContain(
      `"preApprovedByRuleId":"${rule!.id}"`
    );
    expect(res.status).not.toBe("draft");
    expect(h.dispatched.map((d) => d.ref)).toEqual(["is-agent"]);
    expect(await triageOf(res.session!.id)).toMatchObject({
      acceptedBy: PERSON,
      preApprovedByRuleId: rule!.id,
    });
  });

  it("CONTROL: without the rule, the same run waits as the person's draft", async () => {
    const res = await agentRun(PERSON, AGENT, PB);
    expect(JSON.stringify(h.perm)).toContain('"granted":true');
    expect(h.perm).not.toHaveProperty("preApprovedByRuleId");
    expect(res.status).toBe("draft");
    expect(h.dispatched).toEqual([]);
  });

  it("another member's agent in the same space is not covered by the person's rule", async () => {
    await allow(PB);
    const res = await agentRun(OTHER, OTHER_AGENT, PB);
    expect(res.status).toBe("draft");
    expect(h.dispatched).toEqual([]);
    // Nor does the other member read it as their own approval.
    expect((await asPerson(OTHER).forSubject({ subjectId: PB })).rules).toEqual(
      []
    );
  });

  it("a playbook declaring a capability is not eligible, and its run is held with that reason", async () => {
    await allow(PB_TOOLS);
    expect(
      (await asPerson().forSubject({ subjectId: PB_TOOLS })).preApproval
    ).toEqual({ eligible: false, reason: "declares_tools" });
    const res = await agentRun(PERSON, AGENT, PB_TOOLS);
    expect(res.status).toBe("draft");
    expect(h.dispatched).toEqual([]);
    expect(await triageOf(res.session!.id)).toEqual({
      heldBecause: "declares_tools",
    });
  });
});
