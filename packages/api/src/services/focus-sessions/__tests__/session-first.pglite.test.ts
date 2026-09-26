/**
 * Session-first attribution, driven through the REAL doors on PGlite.
 *
 * Real: `resolveWorkSession` (the one attach resolver), the receipt packager
 * `resolveOrCreateAgentProposalSession` + `findClientSession` (their own
 * `client-pg` is pinned to the same PGlite), `createFocusSession` (twin lock,
 * adoption, template matching), `matchSessionTemplate` over the access layer.
 * Every table is generated from the Drizzle definitions.
 *
 * Stubbed, and why:
 *  - `checkPermissionOrPropose` — the governance ladder has its own suites;
 *    here it answers "allowed" so the create path runs to the insert.
 *  - channel mint / realtime emit / block guidance — side effects with their
 *    own suites.
 *
 * NOT covered: true cross-connection lock contention. PGlite is ONE
 * connection and serializes transactions, so the concurrency rows prove the
 * re-check UNDER the lock (both callers pass the unlocked pre-check; only the
 * locked re-check keeps the second from inserting) — not Postgres' lock wait.
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
/** Set to make the CLIENT-binding read fail, so its catch path is testable. */
const { clientReadFails } = vi.hoisted(() => ({
  clientReadFails: { on: false },
}));
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const realFind = actual.findClientSession as (...a: unknown[]) => unknown;
  return {
    ...actual,
    db: await h.init(),
    getDb: async () => h.init(),
    findClientSession: (...args: unknown[]) => {
      if (clientReadFails.on) throw new Error("client session read failed");
      return realFind(...args);
    },
  };
});
const { permSpy } = vi.hoisted(() => ({
  permSpy: vi.fn(
    async (_args: { data: Record<string, unknown> }) =>
      ({}) as Record<string, unknown>
  ),
}));
vi.mock("../../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: permSpy,
  proposedMessageFor: (_t: unknown, fallback: string) => fallback,
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
const { matchSpy } = vi.hoisted(() => ({ matchSpy: vi.fn() }));
vi.mock("../match-session-template.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../match-session-template.js")>();
  return {
    ...actual,
    matchSessionTemplate: (
      ...args: Parameters<typeof actual.matchSessionTemplate>
    ) => {
      matchSpy(...args);
      return actual.matchSessionTemplate(args[0]);
    },
  };
});

import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import {
  resolveOrCreateAgentProposalSession,
  runWithClientKey,
} from "@synap/database";
import { resolveWorkSession } from "../resolve-work-session.js";
import { createFocusSession } from "../create-session.js";
import { matchSessionTemplate } from "../match-session-template.js";

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
const AGENT = "agent-1";

async function session(opts: {
  goal?: string;
  status?: string;
  metadata?: Record<string, unknown>;
  origin?: string;
  updatedMinutesAgo?: number;
}): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, origin, metadata, started_at, updated_at)
     values ($1, $2, $3, $4, $5, $6::jsonb, now(), now() - ($7::int * interval '1 minute'))`,
    [
      id,
      USER,
      opts.goal ?? "Some work",
      opts.status ?? "active",
      opts.origin ?? "human",
      JSON.stringify(opts.metadata ?? {}),
      opts.updatedMinutesAgo ?? 0,
    ]
  );
  return id;
}

async function rows() {
  return (
    await q<{
      id: string;
      goal: string;
      title: string | null;
      metadata: Record<string, unknown>;
      playbook_id: string | null;
      criteria: unknown;
    }>(
      `select id, goal, title, metadata, playbook_id, criteria from focus_sessions where user_id = $1 order by started_at`,
      [USER]
    )
  ).rows;
}

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
  // A KNOWN principal (Sites W2 S2): an id with no `users` row is an unknown
  // principal and reads no pod-level row (pod-wide globals, pod-visible
  // workspaces) — `podReaderWhere`. This fixture models provisioned users.
  await h.client!.exec(
    `insert into users (id, email) values ('${USER}', '${USER}@example.test')`
  );
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(
    "delete from focus_sessions; delete from proposals; delete from playbooks; delete from playbook_runs;"
  );
  matchSpy.mockClear();
  permSpy.mockClear();
  permSpy.mockImplementation(async () => ({}));
});

const receipt = (clientKey: string, goal: string) =>
  resolveOrCreateAgentProposalSession({
    userId: USER,
    agentUserId: AGENT,
    goal,
    title: "Agent changes",
    clientKey,
    stableCorrelation: false,
  });

describe("receipts group by CLIENT, not by the per-write goal", () => {
  it("one client, two different writes → ONE receipt, marked and named", async () => {
    const a = await receipt("key:A", "Create task Buy milk");
    const b = await receipt("key:A", "Update person Ada");
    expect(a).toBeTruthy();
    expect(b).toBe(a);
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0].metadata).toMatchObject({
      kind: "agent-proposal-package",
      autoOpened: true,
      clientKey: "key:A",
    });
    expect(all[0].title).toBe("Agent changes");
  });

  it("two clients → two receipts, never each other's", async () => {
    const a = await receipt("key:A", "Create task Buy milk");
    const b = await receipt("key:B", "Create task Buy milk");
    expect(a).not.toBe(b);
    expect(await rows()).toHaveLength(2);
  });

  it("an auto-opened receipt idle past the window is not reused", async () => {
    const old = await session({
      goal: "old",
      origin: "agent",
      metadata: {
        kind: "agent-proposal-package",
        autoOpened: true,
        clientKey: "key:A",
      },
      updatedMinutesAgo: 3 * 60,
    });
    const fresh = await receipt("key:A", "new write");
    expect(fresh).not.toBe(old);
  });

  it("concurrent first writes from one client open ONE receipt", async () => {
    const [a, b] = await Promise.all([
      receipt("key:A", "write one"),
      receipt("key:A", "write two"),
    ]);
    expect(a).toBe(b);
    expect(await rows()).toHaveLength(1);
  });

  it("the client key comes from the request context when not passed", async () => {
    const a = await runWithClientKey("key:CTX", () =>
      resolveOrCreateAgentProposalSession({
        userId: USER,
        agentUserId: AGENT,
        goal: "x",
      })
    );
    const [row] = await rows();
    expect(row.id).toBe(a);
    expect(row.metadata.clientKey).toBe("key:CTX");
  });
});

describe("resolveWorkSession precedence", () => {
  it("two clients, each with its own open session → each resolves to its own", async () => {
    const mine = await session({
      origin: "agent",
      metadata: { clientKey: "key:A" },
    });
    const theirs = await session({
      origin: "agent",
      metadata: { clientKey: "key:B" },
    });
    expect(
      (await resolveWorkSession({ userId: USER, clientKey: "key:A" })).sessionId
    ).toBe(mine);
    expect(
      (await resolveWorkSession({ userId: USER, clientKey: "key:B" })).sessionId
    ).toBe(theirs);
  });

  it("unbound client + ONE unclaimed open work session → that one", async () => {
    const human = await session({ origin: "human" });
    await session({ origin: "agent", metadata: { clientKey: "key:B" } });
    const r = await resolveWorkSession({ userId: USER, clientKey: "key:A" });
    expect(r).toMatchObject({
      sessionId: human,
      source: "unclaimed",
      unclaimedOpenCount: 1,
    });
  });

  it("unbound client + TWO unclaimed open work sessions → no guess", async () => {
    await session({ origin: "human", goal: "one" });
    await session({ origin: "human", goal: "two" });
    const r = await resolveWorkSession({ userId: USER, clientKey: "key:A" });
    expect(r.sessionId).toBeUndefined();
    expect(r).toMatchObject({ source: "none", unclaimedOpenCount: 2 });
  });

  it("a FAILED client-binding read resolves to none — never another client's session", async () => {
    // A failed read is not "this client has no session". Falling through to
    // the unclaimed rung would file the write into a session that is not the
    // caller's — the cross-client mis-attribution this door exists to end.
    await session({
      origin: "human",
      goal: "someone else's only open session",
    });
    clientReadFails.on = true;
    try {
      const r = await resolveWorkSession({ userId: USER, clientKey: "key:A" });
      expect(r.sessionId).toBeUndefined();
      expect(r).toMatchObject({ source: "none", unclaimedOpenCount: null });
    } finally {
      clientReadFails.on = false;
    }
  });

  it("an explicit, owned handle wins over the client's own session", async () => {
    await session({ origin: "agent", metadata: { clientKey: "key:A" } });
    const named = await session({ origin: "human", goal: "named" });
    const r = await resolveWorkSession({
      userId: USER,
      clientKey: "key:A",
      explicitSessionId: named,
    });
    expect(r).toMatchObject({ sessionId: named, source: "explicit" });
  });
});

describe("start_session adopts the auto-opened session (never a duplicate)", () => {
  it("auto-open then start → adopted, ONE row, no longer a receipt", async () => {
    const auto = await receipt("key:A", "Create task Buy milk");
    const result = await createFocusSession({
      userId: USER,
      agentUserId: AGENT,
      title: "Grocery run",
      goal: "Plan the week's groceries",
      clientKey: "key:A",
    });
    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    expect(result.adopted).toBe(true);
    expect(result.session.id).toBe(auto);
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0].goal).toBe("Plan the week's groceries");
    expect(all[0].metadata.kind).toBeUndefined();
    expect(all[0].metadata.autoOpened).toBeUndefined();
    expect(all[0].metadata).toMatchObject({
      clientKey: "key:A",
      titleSource: "agent",
    });
  });

  it("adoption DROPS the receipt's derived name — it described other writes", async () => {
    // Live 2026-09-20: a research session was adopted onto a receipt and kept
    // "[dogfood] the Research pack is enabled…", the name of the write that
    // opened it. With no explicit title the derived name goes, so lists fall
    // back to the new goal until the titler names it.
    const auto = await receipt(
      "key:A",
      "Create knowledge The Research pack is enabled"
    );
    const before = (await rows())[0];
    expect(before.title).toBeTruthy();
    const result = await createFocusSession({
      userId: USER,
      agentUserId: AGENT,
      goal: "Research competitor Notion and compare them to us",
      clientKey: "key:A",
    });
    if (result.status !== "created") throw new Error(result.status);
    expect(result.session.id).toBe(auto);
    expect(result.session.title).toBeNull();
    expect(result.session.metadata).toMatchObject({ titleSource: "derived" });
  });

  it("adoption KEEPS a name a person or agent chose", async () => {
    const auto = await receipt("key:A", "Create task Buy milk");
    await q(
      `update focus_sessions set title = $2, metadata = metadata || '{"titleSource":"human"}'::jsonb where id = $1`,
      [auto, "Groceries, named by me"]
    );
    const result = await createFocusSession({
      userId: USER,
      agentUserId: AGENT,
      goal: "Plan the week's groceries",
      clientKey: "key:A",
    });
    if (result.status !== "created") throw new Error(result.status);
    expect(result.session.title).toBe("Groceries, named by me");
    expect(result.session.metadata).toMatchObject({ titleSource: "human" });
  });

  it("another client's auto-opened session is never adopted", async () => {
    const other = await receipt("key:B", "Create task");
    const result = await createFocusSession({
      userId: USER,
      agentUserId: AGENT,
      goal: "My own work",
      clientKey: "key:A",
    });
    if (result.status !== "created") throw new Error(result.status);
    expect(result.adopted).toBeUndefined();
    expect(result.session.id).not.toBe(other);
    expect(result.session.metadata).toMatchObject({ clientKey: "key:A" });
  });
});

describe("twin dedup under the lock", () => {
  it("two concurrent starts of the same goal (different case) → ONE row", async () => {
    const [a, b] = await Promise.all([
      createFocusSession({ userId: USER, goal: "Ship the report" }),
      createFocusSession({ userId: USER, goal: "ship the REPORT" }),
    ]);
    expect((await rows()).length).toBe(1);
    expect([a.status, b.status].sort()).toEqual(["created", "deduped"]);
  });
});

describe("playbook candidates are SUGGESTED, never applied", () => {
  async function playbook(name: string, goalTemplate: string): Promise<string> {
    const id = randomUUID();
    await q(
      `insert into playbooks (id, workspace_id, name, goal_template, status, executor, stages, params, expected_outputs, criteria, created_by)
       values ($1, null, $2, $3, 'active', 'is-agent', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, $4)`,
      [id, name, goalTemplate, USER]
    );
    return id;
  }

  it("a LONE strong match is a candidate, not an application", async () => {
    // Under the retired policy this was the auto-apply case: one candidate
    // over the lexical floor (two matched words at 3 points each). It now
    // rides back as a candidate like any other.
    const weekly = await playbook("Weekly review", "Review the week");
    const report = await matchSessionTemplate({
      userId: USER,
      goal: "Weekly review of the pipeline",
    });
    expect(report.candidates.map((c) => c.id)).toEqual([weekly]);
    expect(report.candidates[0].score).toBeGreaterThanOrEqual(6);
    expect(report.optOut).toBe("pass templateId: null");
  });

  it("SEVERAL matches all ride back, ranked, each with its reason", async () => {
    const weekly = await playbook("Weekly review", "Review the week");
    const quarterly = await playbook("Quarterly review", "Review the quarter");
    const report = await matchSessionTemplate({
      userId: USER,
      goal: "Weekly review of the pipeline",
    });
    const ids = report.candidates.map((c) => c.id);
    expect(ids).toContain(weekly);
    expect(ids).toContain(quarterly);
    // Ranked best-first, and every candidate SAYS why it matched — the reason
    // is what the caller shows before choosing.
    expect(ids[0]).toBe(weekly);
    for (const c of report.candidates)
      expect(c.reason.length).toBeGreaterThan(0);
  });

  it("no word in common → an EMPTY candidate list, not a guess", async () => {
    await playbook("Weekly review", "Review the week");
    const report = await matchSessionTemplate({
      userId: USER,
      goal: "Migrate the billing database",
    });
    expect(report.candidates).toEqual([]);
  });

  it("the start door applies NOTHING and hands back the candidates", async () => {
    const weekly = await playbook("Weekly review", "Review the week");
    await playbook("Quarterly review", "Review the quarter");
    const result = await createFocusSession({
      userId: USER,
      agentUserId: AGENT,
      goal: "Weekly review of the pipeline",
      matchTemplate: true,
    });
    if (result.status !== "created") throw new Error(result.status);
    // The whole point: a strong match binds nothing.
    expect(result.session.playbookId).toBeNull();
    expect(result.session.templateId).toBeNull();
    expect(result.playbooks?.candidates.map((c) => c.id)).toContain(weekly);
  });

  it("an explicit templateId still BINDS — the one naming path", async () => {
    const weekly = await playbook("Weekly review", "Review the week");
    const result = await createFocusSession({
      userId: USER,
      agentUserId: AGENT,
      goal: "Weekly review of the pipeline",
      templateId: weekly,
      matchTemplate: true,
    });
    if (result.status !== "created") throw new Error(result.status);
    expect(result.session.playbookId).toBe(weekly);
    // Naming one skips matching entirely — no candidate list to choose from.
    expect(matchSpy).not.toHaveBeenCalled();
    expect(result.playbooks).toBeUndefined();
  });

  it("explicit templateId: null → no matching at all", async () => {
    await playbook("Weekly review", "Review the week");
    const result = await createFocusSession({
      userId: USER,
      agentUserId: AGENT,
      goal: "Weekly review of the pipeline",
      templateId: null,
      matchTemplate: true,
    });
    if (result.status !== "created") throw new Error(result.status);
    expect(matchSpy).not.toHaveBeenCalled();
    expect(result.playbooks).toBeUndefined();
    expect(result.session.playbookId).toBeNull();
  });
});

describe("titleSource and the proposed template path", () => {
  it("an explicit title is the author's: agent start → agent, human start → human", async () => {
    const byAgent = await createFocusSession({
      userId: USER,
      agentUserId: AGENT,
      title: "Named by agent",
      goal: "agent work",
    });
    const byHuman = await createFocusSession({
      userId: USER,
      title: "Named by person",
      goal: "human work",
    });
    if (byAgent.status !== "created" || byHuman.status !== "created")
      throw new Error("not created");
    expect(byAgent.session.metadata).toMatchObject({ titleSource: "agent" });
    expect(byHuman.session.metadata).toMatchObject({ titleSource: "human" });
  });

  it("a PROPOSED start with a real playbook carries playbookId for the executor", async () => {
    const id = randomUUID();
    const ws = randomUUID();
    await q(
      `insert into playbooks (id, workspace_id, name, goal_template, status, executor, stages, params, expected_outputs, criteria, created_by)
       values ($1, $3, 'Weekly review', 'Review', 'active', 'is-agent', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, $2)`,
      [id, USER, ws]
    );
    permSpy.mockImplementation(async () => ({ proposalId: "p-1" }));
    const inWorkspace = await createFocusSession({
      userId: USER,
      agentUserId: AGENT,
      workspaceId: ws,
      goal: "weekly",
      templateId: id,
    });
    expect(inWorkspace.status).toBe("proposed");
    expect(permSpy.mock.calls[0][0].data).toMatchObject({
      playbookId: id,
      templateId: id,
    });
    // No workspace for the executor's instantiate branch ⇒ legacy row.
    await createFocusSession({
      userId: USER,
      agentUserId: AGENT,
      goal: "weekly again",
      templateId: id,
    });
    expect(permSpy.mock.calls[1][0].data.playbookId).toBeUndefined();
  });
});
