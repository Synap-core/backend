/**
 * The first session with a goal (onboarding A8, plan v1 §2.6), through the
 * REAL `createFocusSession` and the REAL governance gate on PGlite with every
 * @synap/database table and the seeded governance defaults (0282, 0346b).
 *
 * Rows, each ruling out a wrong outcome:
 *  - `startFirstSession` creates exactly ONE session in the setup's space,
 *    named from the start's `meta.start.firstSession`, with the person's
 *    agent on it, the space brief's deliverables, and the governance stamp;
 *    a second call hands back the same session — rules out a second session
 *    and an unstamped one;
 *  - the agent's `entity.create` carrying that session PROPOSES, and the same
 *    write without it EXECUTES — rules out "the stamp does nothing" and "the
 *    agent proposes everywhere";
 *  - the E3 `default` arm omits the stamp, so the same in-session write
 *    executes — the control that the proposal above comes from the stamp;
 *  - the public `focusSessions.create` cannot set governance;
 *  - an unapproved setup or an agent the person does not operate refuses,
 *    and creates nothing.
 *
 * The in-session write is driven at the gate (`checkPermissionOrPropose`,
 * with the arguments the entity create door passes): the gate is where the
 * session's stamp is read, and the entity door's own suites pin the rest.
 *
 * Stubbed, and why: the bundled template (the published package does not
 * carry `meta.start` yet; `h.templates`), the per-person lock (a reserved
 * postgres.js connection; PGlite is one connection), the agent's declared
 * focus project (read inside the proposal transaction, which deadlocks on
 * PGlite's single connection, as in governance-seams.pglite.test.ts), project
 * placement and spawn lineage (not under test), and post-commit delivery
 * (realtime, side effects, the AI-decision feed, the session room).
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
    templates: new Map<string, { meta: Record<string, unknown> }>(),
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

vi.mock("../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const eventRepository = new Proxy(
    {},
    { get: () => async () => ({ id: globalThis.crypto.randomUUID() }) }
  );
  await h.init();
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
    withAdvisoryLock: async (_k1: string, _k2: string, fn: () => unknown) =>
      fn(),
    recordSessionSpawn: async () => ({
      linked: false,
      suspendedIntentRecorded: false,
    }),
    resolveSessionProjectPlacement: async () => ({ projectId: null }),
  };
});
vi.mock("@synap-core/workspace-templates", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getWorkspaceTemplate: (slug: string) => h.templates.get(slug),
}));
vi.mock("../agent-identity-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAgentFocusProjectId: async () => null,
}));
vi.mock("@synap/jobs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  broadcastNotification: vi.fn(async () => undefined),
}));
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
}));
vi.mock("../../utils/ai-feedback-events.js", () => ({
  emitAiDecision: vi.fn(async () => undefined),
}));
vi.mock("./ensure-session-channel.js", () => ({
  ensureSessionChannel: vi.fn(async () => null),
}));
vi.mock("../../utils/domain-event-bridge.js", () => ({
  emitHubRealtimeEvent: vi.fn(),
}));
vi.mock("./block-guidelines.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  guidanceForBlockedSlots: vi.fn(async () => undefined),
}));

import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { startFirstSession } from "./first-session.js";
import { checkPermissionOrPropose } from "../../utils/permission-check.js";
import { focusSessionsRouter } from "../../routers/focus-sessions.js";

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
      new URL(`../../../../database/migrations/${f}`, import.meta.url)
    ),
    "utf-8"
  );

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const USER = randomUUID();
const AGENT = randomUUID();
const STRANGER_AGENT = randomUUID();
const SPACE = randomUUID();

const FIRST = {
  title: "Your live deals",
  goal: "Add the 3 to 5 deals you are moving now, each with its company, a real person and a dated next step.",
};

async function seedSetupProposal(status: "approved" | "pending") {
  const id = randomUUID();
  await q(
    `insert into proposals (id, workspace_id, target_type, target_id, status, data, subject_user_id, agent_user_id, created_at, updated_at)
     values ($1, null, 'workspace', 'crm', $2, $3::jsonb, $4, $5, now(), now())`,
    [
      id,
      status,
      JSON.stringify(
        status === "approved" ? { materializedWorkspaceId: SPACE } : {}
      ),
      USER,
      randomUUID(),
    ]
  );
  return id;
}

async function seedJourney(start: Record<string, unknown>) {
  await q(
    `insert into onboarding_journeys (id, user_id, lens_kind, lens_key, template_version, status, progress)
     values ($1, $2, 'pod', 'pod', '1', 'active', $3::jsonb)`,
    [
      randomUUID(),
      USER,
      JSON.stringify({ completedActionIds: [], values: { start } }),
    ]
  );
}

async function readyStart(
  overrides: Record<string, unknown> = {}
): Promise<void> {
  const at = new Date().toISOString();
  await seedJourney({
    v: 1,
    intent: { slug: "crm", source: "here", at },
    setup: { proposalId: await seedSetupProposal("approved"), at },
    agent: { agentUserId: AGENT, at },
    ...overrides,
  });
}

const sessions = async () =>
  (
    await q<{
      id: string;
      title: string | null;
      goal: string;
      workspace_id: string | null;
      agent_ids: string[] | null;
      metadata: Record<string, unknown> | null;
      expected_outputs: Array<{ kind: string; label: string }>;
    }>(
      `select id, title, goal, workspace_id, agent_ids, metadata, expected_outputs from focus_sessions where user_id = $1`,
      [USER]
    )
  ).rows;

const journeyStart = async () =>
  (
    await q<{ progress: { values: { start: Record<string, unknown> } } }>(
      `select progress from onboarding_journeys where user_id = $1`,
      [USER]
    )
  ).rows[0]!.progress.values.start;

/** The agent's `entity.create` as the entity door gates it. */
const agentCreatesDeal = (sessionId?: string) =>
  checkPermissionOrPropose({
    userId: USER,
    agentUserId: AGENT,
    workspaceId: SPACE,
    subjectType: "entity",
    action: "create",
    source: "intelligence",
    ...(sessionId ? { sessionId } : {}),
    data: { id: randomUUID(), profileSlug: "deal", title: "Acme renewal" },
  });

const isProposal = (r: unknown) =>
  typeof (r as { proposalId?: unknown }).proposalId === "string" &&
  (r as { granted?: unknown }).granted !== true;

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
    `insert into users (id, name, email, user_type) values ($1, 'Ada', 'ada@x.test', 'human')`,
    [USER]
  );
  await q(
    `insert into users (id, name, email, user_type, agent_metadata) values
       ($1, 'Claude Code', 'cc@x.test', 'agent', $3::jsonb),
       ($2, 'Someone else''s agent', 'se@x.test', 'agent', $3::jsonb)`,
    [AGENT, STRANGER_AGENT, JSON.stringify({ agentType: "claude-code" })]
  );
  // The person OPERATES their agent: its hub key acts on their behalf.
  await q(
    `insert into api_keys (id, user_id, key_type, linked_user_id, is_active) values ($1, $2, 'hub_inbound', $3, true)`,
    [randomUUID(), AGENT, USER]
  );
  // The space the setup created, with the CRM brief's collect targets. The
  // agent is a member, so its writes reach the governance ladder (a
  // non-member files a join request first, which is not under test).
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1, 'CRM', $2, $3::jsonb)`,
    [
      SPACE,
      USER,
      JSON.stringify({
        onboarding: {
          goal: "Turn the real commercial motion into a pipeline.",
          collect: [
            { profileSlug: "company", what: "Prospects", min: 1 },
            { profileSlug: "deal", what: "Live opportunities", min: 2 },
            { profileSlug: "note", what: "Context, no floor" },
          ],
        },
      }),
    ]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner'), ($4, $2, $5, 'editor')`,
    [randomUUID(), SPACE, USER, randomUUID(), AGENT]
  );
  // The kind the agent creates: the gate refuses a create of an unknown kind
  // before any verdict.
  await q(
    `insert into profiles (id, slug, display_name, scope, workspace_id, is_active, origin, lifecycle, profile_kind)
     values ($1, 'deal', 'Deal', 'workspace', $2, true, 'template', 'active', 'kind')`,
    [randomUUID(), SPACE]
  );
  h.templates.set("crm", {
    meta: { slug: "crm", name: "CRM", start: { firstSession: FIRST } },
  });
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(
    "delete from focus_sessions; delete from proposals; delete from onboarding_journeys; delete from governance_rules; delete from events;"
  );
  await h.client!.exec(migration("0282_governance_reversible_default.sql"));
  await h.client!.exec(migration("0346b_governance_own_organise_default.sql"));
});

describe("startFirstSession — one stamped session with the person's agent", () => {
  it("creates exactly one session, stamped, in the setup's space; a second call hands it back", async () => {
    await readyStart();

    const first = await startFirstSession({ userId: USER });
    expect(first).toMatchObject({ reused: false, governance: "propose" });

    const rows = await sessions();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row!.id).toBe(first.sessionId);
    expect(row!.title).toBe(FIRST.title);
    expect(row!.goal).toBe(FIRST.goal);
    expect(row!.workspace_id).toBe(SPACE);
    expect(row!.agent_ids).toEqual([AGENT]);
    expect(row!.metadata?.governance).toEqual({ forceProposeWrites: true });
    // One slot per required record; a target with no floor owes nothing.
    expect(
      row!.expected_outputs.map((o) => ({ kind: o.kind, label: o.label }))
    ).toEqual([
      { kind: "company", label: "Company" },
      { kind: "deal", label: "Deal 1" },
      { kind: "deal", label: "Deal 2" },
    ]);
    // The pointer lands beside the other start values, which stay.
    const start = await journeyStart();
    expect(start.firstSession).toMatchObject({ sessionId: first.sessionId });
    expect(start.agent).toMatchObject({ agentUserId: AGENT });

    const again = await startFirstSession({ userId: USER });
    expect(again).toEqual({
      sessionId: first.sessionId,
      reused: true,
      governance: "propose",
    });
    expect(await sessions()).toHaveLength(1);
  });

  it("proposes: the agent's create inside the session is a proposal, the same create outside executes", async () => {
    await readyStart();
    const { sessionId } = await startFirstSession({ userId: USER });

    const inside = await agentCreatesDeal(sessionId);
    expect(isProposal(inside)).toBe(true);

    const outside = await agentCreatesDeal();
    expect(outside).toMatchObject({ granted: true });
  });

  it("CONTROL — the E3 `default` arm omits the stamp, so the same in-session create executes", async () => {
    await readyStart({
      experiments: { firstSessionGovernance: "default" },
    });
    const res = await startFirstSession({ userId: USER });
    expect(res.governance).toBe("default");
    expect((await sessions())[0]!.metadata?.governance).toBeUndefined();

    const inside = await agentCreatesDeal(res.sessionId);
    expect(inside).toMatchObject({ granted: true });
  });

  it("the public focusSessions.create cannot set governance", async () => {
    const caller = focusSessionsRouter.createCaller({
      db: h.db,
      authenticated: true,
      userId: USER,
      workspaceId: null,
    } as never);
    const created = (await caller.create({
      goal: `My own work ${randomUUID()}`,
      workspaceId: SPACE,
      governance: { forceProposeWrites: true },
      metadata: { governance: { forceProposeWrites: true } },
    } as never)) as { id: string };

    const [row] = await sessions();
    expect(row!.id).toBe(created.id);
    expect(row!.metadata?.governance).toBeUndefined();
  });

  it("refuses before the setup is approved, and creates nothing", async () => {
    const at = new Date().toISOString();
    await seedJourney({
      v: 1,
      intent: { slug: "crm", source: "here", at },
      setup: { proposalId: await seedSetupProposal("pending"), at },
      agent: { agentUserId: AGENT, at },
    });

    await expect(startFirstSession({ userId: USER })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect(await sessions()).toHaveLength(0);
  });

  it("refuses an agent the person does not operate, and creates nothing", async () => {
    await readyStart({
      agent: { agentUserId: STRANGER_AGENT, at: new Date().toISOString() },
    });

    await expect(startFirstSession({ userId: USER })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect(await sessions()).toHaveLength(0);
  });
});
