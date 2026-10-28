/**
 * A code skill is fixed IN PLACE, under the id its author was given.
 *
 *   - ticket 9d740153: `synap_create_skill` returned a proposal's pre-minted
 *     id, and approving the proposal minted ANOTHER one, so `run_capability`
 *     with the returned id answered "not found". The approved skill now lands
 *     under the returned id (`insertSkillGoverned` `adoptId`).
 *   - ticket 01fc187c: `synap_update_skill` took only name/description/body,
 *     so fixing a code skill meant a second create under the same name (two
 *     `instagram.score_handle`, an ambiguous run by name). The update door now
 *     carries `code`, `parameters`, `timeoutSeconds` and `requiredTools`
 *     through the governed `skills.update` (a change to what the skill runs
 *     is held for review and leaves it off until approved again), and a
 *     second create under a name already in scope is refused with the id to
 *     update.
 *
 * Driven end to end on PGlite: the REAL MCP handlers → the REAL
 * `skills.create` / `skills.update` → the REAL gate (an agent with no rule:
 * every write proposes) → the proposal ROW → the REAL `applyProposalApproval`
 * and `skill/create` / `skill/update` executors. Stubs as
 * `build.create-skill-turn-on.pglite.test.ts`.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
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

// The database package's own modules read `db` from client-pg, not the barrel.
vi.mock("../../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const d = await h.init();
  return {
    ...actual,
    db: d,
    getDb: async () => d,
    EventRepository: class {
      async append() {
        return { id: randomUUID() };
      }
      async emitCompleted() {}
      async getCorrelatedEvents() {
        return [];
      }
    },
    eventRepository: {
      append: async () => ({ id: randomUUID() }),
      emitCompleted: async () => undefined,
      getCorrelatedEvents: async () => [],
    },
    resolveOrCreateAgentProposalSession: async () => null,
  };
});
vi.mock("../../../services/agent-identity-service.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getAgentFocusProjectId: async () => null,
}));
vi.mock("@synap/events", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
  getBoss: () => ({ send: async () => null }),
}));
vi.mock("../../../utils/audit-log.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  auditLog: vi.fn(async () => ({ id: randomUUID() })),
}));
vi.mock("../../../utils/split-brain-service.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  isPodReadOnly: vi.fn(async () => false),
}));
vi.mock("../../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: () => undefined,
}));
vi.mock(
  "../../../services/focus-sessions/ensure-session-channel.js",
  async (orig) => ({
    ...(await orig<Record<string, unknown>>()),
    ensureSessionChannel: async () => null,
  })
);
vi.mock("../../../utils/domain-event-bridge.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  emitHubRealtimeEvent: () => undefined,
}));
vi.mock("../../../middleware/read-only-guard.js", () => ({
  readOnlyGuardMiddleware: async (opts: { next: () => unknown }) => opts.next(),
}));
vi.mock("../../../middleware/audit-log.js", () => ({
  auditLogMiddleware: async (opts: { next: () => unknown }) => opts.next(),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { eq } from "drizzle-orm";
import * as schema from "@synap/database/schema";
import { buildHandlers } from "./build.js";
import type { McpToolContext } from "./shared.js";
import { applyProposalApproval } from "../../proposals/apply-approval.js";
import { buildProposalSummary } from "../../../utils/permission-check.js";

const USER = randomUUID();
const AGENT = randomUUID();
const GMAIL_TOOL = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const isArray = t.endsWith("[]");
    const base = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const type = isArray && !base.endsWith("[]") ? `${base}[]` : base;
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    let def = "";
    if (c.name === "created_at" || c.name === "updated_at")
      def = " default now()";
    else if (
      c.hasDefault &&
      c.default !== undefined &&
      typeof c.default !== "object"
    ) {
      const d = c.default as unknown;
      def =
        typeof d === "string"
          ? ` default '${d.replace(/'/g, "''")}'`
          : ` default ${String(d)}`;
    } else if (c.hasDefault && type === "jsonb") def = ` default '{}'::jsonb`;
    else if (c.hasDefault && type.endsWith("[]")) def = ` default '{}'`;
    return `"${c.name}" ${type}${pk}${def}`;
  });
  // The schema's plain unique indexes too: an `on conflict (…)` insert (links'
  // `idx_links_unique_edge`) needs its target. Partial or expression indexes
  // are left out; no write here depends on one.
  const uniques = cfg.indexes.flatMap((idx) => {
    const { unique, where, columns, name } = idx.config;
    const names = columns.map((c) => (c as { name?: unknown }).name);
    if (!unique || where || !names.every((n) => typeof n === "string"))
      return [];
    return [
      `create unique index "${name ?? `${cfg.name}_${names.join("_")}_uidx`}" on "${cfg.name}" (${names.map((n) => `"${n}"`).join(", ")});`,
    ];
  });
  return [`create table "${cfg.name}" (${cols.join(", ")});`, ...uniques].join(
    "\n"
  );
}

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);
const USER = randomUUID();
const AGENT = randomUUID();
const GMAIL_TOOL = randomUUID();

/** Pure computation: reaches nothing outside the pod. */
const PURE = `const n = Number(args.n ?? 0);
return { doubled: n * 2 };`;
/** The fix: reads the person's Gmail through the pod. */
const CALLS_GMAIL = `const r = await callProvider("gmail_api", "GET", "/users/me/messages");
return r;`;

type Reply = Record<string, unknown> & {
  id?: string;
  status?: string;
  proposalId?: string;
  error?: string;
};

async function agentCalls(
  tool: "synap_create_skill" | "synap_update_skill",
  args: Record<string, unknown>
): Promise<{ isError?: boolean; reply: Reply; text: string }> {
  const res = await buildHandlers[tool]!({
    toolName: tool,
    args,
    userId: USER,
    apiKeyScopes: ["mcp.write"],
    agentUserId: AGENT,
    caller: {} as McpToolContext["caller"],
    lensCaller: {} as McpToolContext["lensCaller"],
    workspaceAccessible: true,
  } as McpToolContext);
  const text = (res.content?.[0] as { text: string }).text;
  let reply: Reply = {};
  try {
    reply = JSON.parse(text) as Reply;
  } catch {
    // A tool error is prose.
  }
  return { isError: res.isError, reply, text };
}

/** The person approves the proposal, through the one approval door. */
async function personApproves(proposalId: string) {
  const proposal = await (
    h.db as {
      query: { proposals: { findFirst: (a: unknown) => Promise<unknown> } };
    }
  ).query.proposals.findFirst({
    where: eq(schema.proposals.id, proposalId),
  });
  if (!proposal) throw new Error(`no proposal ${proposalId}`);
  return applyProposalApproval({
    proposal: proposal as never,
    userId: USER,
    input: { proposalId },
    ctx: { authenticated: true, userId: USER } as never,
  });
}

async function skillRow(id: string) {
  const { rows } = await q<{
    id: string;
    name: string;
    code: string | null;
    timeout_seconds: number | null;
    approved: boolean | null;
  }>(
    `select id, name, code, timeout_seconds, approved from skills where id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  await q(
    `insert into users (id, email, name, user_type, created_by_user_id, agent_type) values
      ($1, 'u@x.test', 'Ada', 'human', null, null),
      ($2, 'a@x.test', 'Scout', 'agent', $1, 'claude-code')`,
    [USER, AGENT]
  );
  // The person owns the pod (a pod admin): a pod-wide skill needs that.
  const podAdminSpace = randomUUID();
  await q(
    `insert into workspaces (id, owner_id, name, system_slug) values ($1, $2, 'Pod admin', 'pod-admin')`,
    [podAdminSpace, USER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
    [randomUUID(), podAdminSpace, USER]
  );
  await q(
    `insert into tools (id, created_by, name, kind, approved) values ($1, $2, 'gmail_api', 'provider', true)`,
    [GMAIL_TOOL, USER]
  );
});

describe("a code skill keeps its id and is fixed in place", () => {
  let skillId = "";

  it("9d740153: the approved skill IS the id create_skill returned", async () => {
    const { reply } = await agentCalls("synap_create_skill", {
      name: "instagram.score_handle",
      description: "Score a handle",
      code: PURE,
    });
    expect(reply.status, JSON.stringify(reply)).toBe("proposed");
    skillId = String(reply.id);
    // Nothing exists until the person approves.
    expect(await skillRow(skillId)).toBeNull();

    const approval = await personApproves(String(reply.proposalId));
    expect(approval.success, JSON.stringify(approval)).toBe(true);

    const row = await skillRow(skillId);
    expect(row).toMatchObject({ id: skillId, name: "instagram.score_handle" });
    // …and it is the only one: no second row under a fresh id.
    const { rows } = await q(
      `select id from skills where name = 'instagram.score_handle'`
    );
    expect(rows).toHaveLength(1);
  });

  it("01fc187c: a second create under the same name is refused with the id to update", async () => {
    const before = await q(
      `select id from proposals where target_type = 'skill' and proposal_type = 'create'`
    );
    const { reply } = await agentCalls("synap_create_skill", {
      name: "instagram.score_handle",
      code: CALLS_GMAIL,
    });
    expect(reply.error).toContain("synap_update_skill");
    expect(reply.error).toContain(skillId);
    expect(reply.existingSkillId).toBe(skillId);
    const after = await q(
      `select id from proposals where target_type = 'skill' and proposal_type = 'create'`
    );
    expect(after.rows).toHaveLength(before.rows.length);
  });

  it("01fc187c: update_skill takes code, timeout and tools; held, then applied under the same id and off until turned on again", async () => {
    const live = await skillRow(skillId);
    expect(live!.code).toBe(PURE);

    const { reply } = await agentCalls("synap_update_skill", {
      id: skillId,
      code: CALLS_GMAIL,
      timeoutSeconds: 120,
      requiredTools: ["gmail_api"],
    });
    expect(reply.status, JSON.stringify(reply)).toBe("proposed");
    expect(reply.skillId).toBe(skillId);
    // Held: the running skill is untouched until the person approves.
    expect(await skillRow(skillId)).toMatchObject({
      code: PURE,
      approved: live!.approved,
    });
    // The sentence the person approves names the tool it may now reach.
    const { rows: held } = await q<{ data: { data: Record<string, unknown> } }>(
      `select data from proposals where id = $1`,
      [reply.proposalId]
    );
    expect(
      buildProposalSummary("skill", "update", held[0]!.data.data)
    ).toContain("gmail_api");

    const approval = await personApproves(String(reply.proposalId));
    expect(approval.success, JSON.stringify(approval)).toBe(true);

    expect(await skillRow(skillId)).toMatchObject({
      code: CALLS_GMAIL,
      timeout_seconds: 120,
      // What it runs changed: it needs turning on again.
      approved: false,
    });
    const { rows: edges } = await q<{ to_id: string }>(
      `select to_id from links where from_id = $1 and link_type = 'requires'`,
      [skillId]
    );
    expect(edges.map((e) => e.to_id)).toEqual([GMAIL_TOOL]);
  });

  it("refuses an unknown tool name and files nothing", async () => {
    const before = await q(`select id from proposals`);
    const { isError, text } = await agentCalls("synap_update_skill", {
      id: skillId,
      requiredTools: ["no_such_tool"],
    });
    expect(isError).toBe(true);
    expect(text).toContain("no_such_tool");
    expect((await q(`select id from proposals`)).rows).toHaveLength(
      before.rows.length
    );
  });
});
