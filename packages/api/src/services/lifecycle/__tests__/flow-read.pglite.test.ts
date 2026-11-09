/**
 * The flow read (`readFlowOf`, `flow.of`) against real SQL (PGlite, every
 * table), through the real board, playbook, run and grant reads. Only
 * `getEffectiveLifecycle` is stubbed (its own suites prove it), plus the
 * worker backlog counts.
 *
 * Rows rule out:
 *  - a state no stage owns read as owned, or a stage's status read off
 *    anything but `stageForSubjectStatus` (a finding-like kind);
 *  - two flows owning ONE state reduced to the first match (C4), and two
 *    flows owning different states not each named on their own state;
 *  - a card's next step naming no owner, or a stage that names a status the
 *    lifecycle does not declare going unreported;
 *  - open runs on an older frozen copy of the flow not marked;
 *  - a flow of another space, or an archived one, listed in this space;
 *  - a role read losing the kind of each thing (people and companies);
 *  - the space's primary output not read from its settings;
 *  - a card's `blocker` not the one `statusOf` returns for the thing (a
 *    person's owed slot, an agent's slot that declares `blocks`), one read per
 *    card instead of one for the board, a card with nothing blocking it not
 *    `blocked: false`, or a grant-bounded key told of a session it cannot read;
 *  - a key bounded by a grant answered pod-wide, answered a kind it may not
 *    read, or shown flows / workers its grant does not reach as "none".
 *
 * Cannot see: the Hub and MCP doors (their own suites), a real pod's data.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 120_000 });

const FINDING = "11111111-1111-4111-8111-111111111111";
const LEAD = "22222222-2222-4222-8222-222222222222";
const PERSON = "33333333-3333-4333-8333-333333333333";
const COMPANY = "44444444-4444-4444-8444-444444444444";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  tables: [] as unknown[],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { is } = await import("drizzle-orm");
  const { PgTable } = await import("drizzle-orm/pg-core");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const tables = Object.entries(actual).filter(([, v]) => is(v, PgTable));
  h.tables = tables.map(([, v]) => v);
  const pg = drizzle(client, { schema: Object.fromEntries(tables) as never });
  const lifecycles: Record<string, unknown> = {
    "11111111-1111-4111-8111-111111111111": {
      propertySlug: "findingStatus",
      options: [
        { key: "open", category: "open" },
        { key: "fixing", category: "active" },
        { key: "fixed", category: "active" },
        { key: "verified", category: "done" },
        { key: "wont_fix", category: "lost", humanOnly: true },
      ],
      unclassified: [],
      initialStatus: "open",
    },
    "22222222-2222-4222-8222-222222222222": {
      propertySlug: "leadStatus",
      options: [
        { key: "new", category: "open" },
        { key: "contacted", category: "active" },
        { key: "qualified", category: "active" },
        { key: "converted", category: "done" },
      ],
      unclassified: [],
      initialStatus: "new",
    },
  };
  return {
    ...actual,
    db: pg,
    getDb: async () => pg,
    countWorkerPendingApprovals: async () => 0,
    countWorkerPendingApprovalsBulk: async (ids: readonly string[]) =>
      new Map(ids.map((id) => [id, 0])),
    ProfileResolutionService: class extends (actual.ProfileResolutionService as new (
      db: unknown
    ) => object) {
      async getEffectiveLifecycle(profileId: string) {
        return lifecycles[profileId] ?? null;
      }
      async getEffectiveLifecycles(ids: readonly string[]) {
        return new Map(ids.map((id) => [id, lifecycles[id] ?? null]));
      }
    },
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { runWithGrant, type KeyGrant } from "@synap/database";
import { flowOfInput, readFlowOf, type FlowOf } from "../flow-read.js";
import { flowOfSchema } from "../flow-schema.js";
import { readStatusOf } from "../../status/status-read.js";
import { listSessionOutputsWithOutcomes } from "../../focus-sessions/session-outputs.js";

const USER = "user-1";
const WS = "55555555-5555-4555-8555-555555555555";
const WS2 = "66666666-6666-4666-8666-666666666666";
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const def =
      c.primary && type === "uuid" ? " default gen_random_uuid()" : "";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  const schema = cfg.schema ? `"${cfg.schema}".` : "";
  return `create table if not exists ${schema}"${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const ctx = { userId: USER, workspaceId: null };
const read = (input: Record<string, unknown>) =>
  readFlowOf(flowOfInput.parse(input), ctx);

async function thing(o: {
  profileId: string;
  type: string;
  title: string;
  status: string | null;
  workspaceId?: string | null;
}): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into entities (id, user_id, type, profile_id, title, status, workspace_id, properties, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,'{}'::jsonb,now())`,
    [id, USER, o.type, o.profileId, o.title, o.status, o.workspaceId ?? null]
  );
  return id;
}

async function lead(entityId: string, status: string) {
  await q(
    `insert into entity_facets (id, entity_id, profile_id, user_id, status, created_at)
     values (gen_random_uuid(),$1,$2,$3,$4,now())`,
    [entityId, LEAD, USER, status]
  );
}

async function playbook(o: {
  name: string;
  profileSlug: string;
  workspaceId: string | null;
  stages: unknown[];
  version?: number;
  status?: string;
}): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into playbooks (id, workspace_id, created_by, name, goal_template, params, input_strategy, channel_spec, expected_outputs, stages, criteria, required_intents, version, executor, status, subject_profile, metadata, created_at, updated_at)
     values ($1,$2,$3,$4,'g','[]','{"kind":"none"}','{}','[]',$5::jsonb,'[]','[]',$6,'is-agent',$7,$8::jsonb,'{}',now(),now())`,
    [
      id,
      o.workspaceId,
      USER,
      o.name,
      JSON.stringify(o.stages),
      o.version ?? 1,
      o.status ?? "active",
      JSON.stringify({ profileSlug: o.profileSlug }),
    ]
  );
  return id;
}

async function run(playbookId: string, status: string, version: number) {
  await q(
    `insert into playbook_runs (id, workspace_id, playbook_id, executor, status, input, definition_snapshot, started_at, created_by)
     values (gen_random_uuid(),$1,$2,'is-agent',$3,'{}',$4::jsonb,now(),$5)`,
    [WS, playbookId, status, JSON.stringify({ version, stages: [] }), USER]
  );
}

const state = (f: FlowOf, key: string) => f.states.find((s) => s.key === key)!;
const owners = (f: FlowOf, key: string) =>
  state(f, key).owners.map((o) => `${o.playbookName}/${o.stageKey}`);

const ids: Record<string, string> = {};

beforeAll(async () => {
  for (const t of h.tables) {
    const cfg = getTableConfig(t as PgTable);
    if (cfg.schema)
      await h.client!.exec(`create schema if not exists "${cfg.schema}";`);
    await h.client!.exec(ddlFor(t as PgTable));
  }
  await q(
    `insert into users (id, name, email, user_type) values ($1,'Me','me@x.io','human')`,
    [USER]
  );
  for (const [id, slug, kind] of [
    [FINDING, "finding", "kind"],
    [LEAD, "lead", "role"],
    [PERSON, "person", "kind"],
    [COMPANY, "company", "kind"],
  ] as const) {
    await q(
      `insert into profiles (id, slug, display_name, profile_kind, entity_scope) values ($1,$2,$2,$3,'workspace')`,
      [id, slug, kind]
    );
  }
  for (const [ws, name, settings] of [
    [
      WS,
      "Builder",
      {
        intent: { label: "Product", produces: ["finding"], primary: "finding" },
      },
    ],
    [WS2, "Other", {}],
  ] as const) {
    await q(
      `insert into workspaces (id, name, owner_id, settings, created_at, updated_at) values ($1,$2,$3,$4::jsonb,now(),now())`,
      [ws, name, USER, JSON.stringify(settings)]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role, joined_at) values (gen_random_uuid(),$1,$2,'owner',now())`,
      [ws, USER]
    );
  }

  // A finding-like kind in WS: one open, one fixing, one in no state.
  ids.open = await thing({
    profileId: FINDING,
    type: "finding",
    title: "Open one",
    status: "open",
    workspaceId: WS,
  });
  ids.fixing = await thing({
    profileId: FINDING,
    type: "finding",
    title: "Fixing one",
    status: "fixing",
    workspaceId: WS,
  });
  ids.stray = await thing({
    profileId: FINDING,
    type: "finding",
    title: "Renamed state",
    status: "provisional",
    workspaceId: WS,
  });
  // "Fix a finding" owns fixing + fixed (a human gate on fixed) and names a
  // status the lifecycle does not declare; a pod-wide flow ALSO owns fixed.
  ids.fix = await playbook({
    name: "Fix a finding",
    profileSlug: "finding",
    workspaceId: WS,
    version: 2,
    stages: [
      { key: "triage", name: "Triage", category: "planned" },
      {
        key: "fix",
        name: "Fix",
        category: "started",
        subjectStatus: "fixing",
      },
      {
        key: "verify",
        name: "Verify",
        category: "started",
        subjectStatus: "fixed",
        gate: { kind: "human" },
      },
      {
        key: "retract",
        name: "Retract",
        category: "canceled",
        subjectStatus: "retracted",
      },
    ],
  });
  ids.close = await playbook({
    name: "Close a finding",
    profileSlug: "finding",
    workspaceId: null,
    stages: [{ key: "close", name: "Close", subjectStatus: "fixed" }],
  });
  // Not this space's, and not active: never listed.
  await playbook({
    name: "Elsewhere",
    profileSlug: "finding",
    workspaceId: WS2,
    stages: [{ key: "x", name: "X", subjectStatus: "open" }],
  });
  await playbook({
    name: "Retired",
    profileSlug: "finding",
    workspaceId: WS,
    status: "archived",
    stages: [{ key: "y", name: "Y", subjectStatus: "open" }],
  });
  // Two open runs (one on the older v1 copy), one finished v1 run.
  await run(ids.fix, "running", 1);
  await run(ids.fix, "running", 2);
  await run(ids.fix, "completed", 1);

  // The lead ROLE on a person and a company; two flows own different states.
  ids.ada = await thing({
    profileId: PERSON,
    type: "person",
    title: "Ada",
    status: null,
  });
  ids.acme = await thing({
    profileId: COMPANY,
    type: "company",
    title: "Acme",
    status: null,
  });
  ids.bob = await thing({
    profileId: PERSON,
    type: "person",
    title: "Bob",
    status: null,
  });
  await lead(ids.ada, "new");
  await lead(ids.acme, "new");
  await lead(ids.bob, "contacted");
  await playbook({
    name: "Lead outreach",
    profileSlug: "lead",
    workspaceId: null,
    stages: [{ key: "reach", name: "Reach out", subjectStatus: "contacted" }],
  });
  await playbook({
    name: "Qualify a lead",
    profileSlug: "lead",
    workspaceId: null,
    stages: [{ key: "qualify", name: "Qualify", subjectStatus: "qualified" }],
  });
});

describe("flow.of — a kind (finding-like)", () => {
  it("names the stage owning each state, none where no stage owns it, both where two do", async () => {
    const f = await read({ profileSlug: "finding", workspaceId: WS });
    expect(f.profileKind).toBe("kind");
    expect(f.property).toBe("findingStatus");
    expect(f.states.map((s) => [s.key, s.order])).toEqual([
      ["open", 0],
      ["fixing", 1],
      ["fixed", 2],
      ["verified", 3],
      ["wont_fix", 4],
    ]);
    expect(owners(f, "open")).toEqual([]);
    expect(owners(f, "fixing")).toEqual(["Fix a finding/fix"]);
    // Two flows own `fixed`: both named, never the first match alone (C4).
    expect(owners(f, "fixed").sort()).toEqual([
      "Close a finding/close",
      "Fix a finding/verify",
    ]);
    const verify = state(f, "fixed").owners.find(
      (o) => o.stageKey === "verify"
    )!;
    expect(verify).toMatchObject({ gate: "human", executor: "is-agent" });
    expect(state(f, "wont_fix").humanOnly).toBe(true);
  });

  it("a card's next step names the stage that owns it; things in no state stay visible", async () => {
    const f = await read({ profileSlug: "finding", workspaceId: WS });
    const open = state(f, "open").cards.find((c) => c.id === ids.open)!;
    expect(open.next).toMatchObject({ to: "fixing", humanOnly: false });
    expect(open.next!.owners.map((o) => o.stageKey)).toEqual(["fix"]);
    expect(open.blocker).toBeNull();
    expect(open.profileSlug).toBe("finding");
    const fixing = state(f, "fixing").cards.find((c) => c.id === ids.fixing)!;
    expect(fixing.next!.to).toBe("fixed");
    expect(f.unclassified).toMatchObject({ count: 1 });
    expect(f.unclassified!.cards[0]).toMatchObject({
      id: ids.stray,
      status: "provisional",
      next: null,
    });
  });

  it("lists this space's and the pod-wide active flows, marking runs on an older copy and undeclared statuses", async () => {
    const f = await read({ profileSlug: "finding", workspaceId: WS });
    expect(f.flows.map((p) => p.name).sort()).toEqual([
      "Close a finding",
      "Fix a finding",
    ]);
    const fix = f.flows.find((p) => p.id === ids.fix)!;
    expect(fix.version).toBe(2);
    expect(fix.owns).toEqual(["fixing", "fixed"]);
    expect(fix.undeclaredStatuses).toEqual(["retracted"]);
    expect(fix.runs).toEqual({ open: 2, onOlderVersion: 1 });
    expect(fix.stages.map((s) => [s.key, s.subjectStatus, s.gate])).toEqual([
      ["triage", null, null],
      ["fix", "fixing", null],
      ["verify", "fixed", "human"],
      ["retract", "retracted", null],
    ]);
    expect(f.withheld).toEqual([]);
  });

  it("reads the space's primary output from its settings", async () => {
    const f = await read({ profileSlug: "finding", workspaceId: WS });
    expect(f.space).toEqual({
      primaryOutput: "finding",
      produces: ["finding"],
    });
    const other = await read({ profileSlug: "finding", workspaceId: WS2 });
    expect(other.space).toEqual({ primaryOutput: null, produces: [] });
    expect(other.flows.map((p) => p.name).sort()).toEqual([
      "Close a finding",
      "Elsewhere",
    ]);
  });
});

describe("flow.of — a role across kinds (lead on people and companies)", () => {
  it("reads people and companies in one read, each card naming its kind and facet", async () => {
    const f = await read({ profileSlug: "lead" });
    expect(f.profileKind).toBe("role");
    const fresh = state(f, "new");
    expect(fresh.count).toBe(2);
    expect(fresh.cards.map((c) => [c.name, c.profileSlug]).sort()).toEqual([
      ["Acme", "company"],
      ["Ada", "person"],
    ]);
    for (const c of fresh.cards) expect(c.facetId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("two flows owning different states: each state names its own owner", async () => {
    const f = await read({ profileSlug: "lead" });
    expect(owners(f, "new")).toEqual([]);
    expect(owners(f, "contacted")).toEqual(["Lead outreach/reach"]);
    expect(owners(f, "qualified")).toEqual(["Qualify a lead/qualify"]);
    const ada = state(f, "new").cards.find((c) => c.id === ids.ada)!;
    expect(ada.next!.owners.map((o) => o.playbookName)).toEqual([
      "Lead outreach",
    ]);
    const bob = state(f, "contacted").cards.find((c) => c.id === ids.bob)!;
    expect(bob.next!.to).toBe("qualified");
  });
});

describe("flow.of — a key bounded by a grant", () => {
  const grantOf = (permissions: string[], workspaceIds: string[] | null) =>
    ({
      scopes: [
        { permissions, workspaceIds, projectIds: null, entityIds: null },
      ],
      clientId: null,
    }) as KeyGrant;

  it("must name its space, and reads only a kind its grant reads", async () => {
    const app = grantOf(["entity.finding.read"], [WS]);
    await expect(
      runWithGrant(app, () => read({ profileSlug: "finding" }))
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      runWithGrant(grantOf(["entity.deal.read"], [WS]), () =>
        read({ profileSlug: "finding", workspaceId: WS })
      )
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("without playbook.read the flows are withheld, never 'none'; workers always are", async () => {
    const app = grantOf(["entity.finding.read"], [WS]);
    const f = await runWithGrant(app, () =>
      read({ profileSlug: "finding", workspaceId: WS })
    );
    expect(f.withheld).toEqual(["flows", "workers"]);
    expect(f.flows).toEqual([]);
    expect(f.hasWorker).toBeNull();
    expect(state(f, "open").cards.map((c) => c.id)).toEqual([ids.open]);
    const withFlows = await runWithGrant(
      grantOf(["entity.finding.read", "playbook.read"], [WS]),
      () => read({ profileSlug: "finding", workspaceId: WS })
    );
    expect(withFlows.withheld).toEqual(["workers"]);
    expect(withFlows.flows.map((p) => p.name)).toContain("Fix a finding");
  });
});

describe("flow.of — a card's blocker is statusOf's blocker", () => {
  const NOW = new Date().toISOString();
  async function session(subject: string, outputs: unknown[]) {
    const id = randomUUID();
    await q(
      `insert into focus_sessions (id, user_id, workspace_id, subject_entity_id, title, goal, status, origin, expected_outputs, metadata, started_at, created_at, updated_at)
       values ($1,$2,$3,$4,'Work','Do it','active','user',$5::jsonb,'{}'::jsonb,now(),now(),now())`,
      [id, USER, WS, subject, JSON.stringify(outputs)]
    );
    return id;
  }
  const blockerOf = (f: FlowOf, key: string, id: string) =>
    state(f, key).cards.find((c) => c.id === id)!.blocker;

  beforeAll(async () => {
    // "Open one": a person's owed ask. "Fixing one": an agent's slot that
    // declares what it blocks. "Renamed state" (unclassified): nothing.
    ids.askSession = await session(ids.open, [
      {
        kind: "decision",
        label: "Fix it now?",
        owner: "human",
        status: "pending",
        blockedReason: "decision",
        owedSince: NOW,
        ask: { mode: "confirm" },
      },
    ]);
    await session(ids.fixing, [
      {
        kind: "output",
        label: "Patch",
        status: "pending",
        blocks: {},
        blockerKey: "needs_patch",
      },
    ]);
  });

  it("carries the blocker statusOf returns, for blocked and free things", async () => {
    const f = await read({ profileSlug: "finding", workspaceId: WS });
    const answers = await readStatusOf(USER, [ids.open, ids.fixing, ids.stray]);
    const statusBlocker = (id: string) =>
      (answers.find((a) => a.id === id) as { blocker?: unknown }).blocker;
    const open = blockerOf(f, "open", ids.open);
    expect(open).toMatchObject({
      blocked: true,
      ball: "me",
      why: { reason: "input" },
      ref: { kind: "slot", id: ids.askSession },
    });
    expect(open).toEqual(statusBlocker(ids.open));
    const fixing = blockerOf(f, "fixing", ids.fixing);
    expect(fixing).toMatchObject({
      blocked: true,
      ball: "agent",
      why: { blockerKey: "needs_patch" },
    });
    expect(fixing).toEqual(statusBlocker(ids.fixing));
    const stray = f.unclassified!.cards.find((c) => c.id === ids.stray)!;
    expect(stray.blocker).toMatchObject({ blocked: false, count: 0 });
    expect(stray.blocker).toEqual(statusBlocker(ids.stray));
  });

  it("an undelivered slot of the session names the thing it holds up", async () => {
    const { db: pg } = await import("@synap/database");
    const view = await listSessionOutputsWithOutcomes({
      db: pg,
      userId: USER,
      sessionId: ids.askSession,
    });
    const slot = view!.pendingExpected.find((e) => e.label === "Fix it now?");
    expect(slot?.blockedThing).toMatchObject({
      thing: { id: ids.open, name: "Open one" },
      statusNow: { key: "open" },
      statusNext: { key: "fixing" },
    });
    expect(slot).not.toHaveProperty("subjectEntityId");
  });

  it("the response parses against the Hub schema, blockers included", async () => {
    const f = await read({ profileSlug: "finding", workspaceId: WS });
    expect(() =>
      flowOfSchema.parse(JSON.parse(JSON.stringify(f)))
    ).not.toThrow();
    const lead = await read({ profileSlug: "lead", workspaceId: WS });
    expect(() =>
      flowOfSchema.parse(JSON.parse(JSON.stringify(lead)))
    ).not.toThrow();
  });

  it("a key bounded by a grant is not told of a session it cannot read", async () => {
    const grantOf = (permissions: string[]) =>
      ({
        scopes: [
          {
            permissions,
            workspaceIds: [WS],
            projectIds: null,
            entityIds: null,
          },
        ],
        clientId: null,
      }) as KeyGrant;
    const blind = await runWithGrant(grantOf(["entity.finding.read"]), () =>
      read({ profileSlug: "finding", workspaceId: WS })
    );
    expect(blockerOf(blind, "open", ids.open)).toMatchObject({
      blocked: false,
    });
    const sighted = await runWithGrant(
      grantOf(["entity.finding.read", "session.read"]),
      () => read({ profileSlug: "finding", workspaceId: WS })
    );
    expect(blockerOf(sighted, "open", ids.open)).toMatchObject({
      blocked: true,
    });
  });
});
