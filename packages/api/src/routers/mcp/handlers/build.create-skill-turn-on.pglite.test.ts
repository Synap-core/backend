/**
 * An agent's skill that no person reviewed: one "turn this on?" request, or
 * born on when its code reaches nothing (founder decision, 2026-10-28).
 *
 * The defect: under a rule `skill.create → auto`, an agent's skill was born
 * switched off (`skillBornApproved`) and nothing told the person: no review
 * item, no notification, and the agent read a bare `created`. On the founder
 * pod 18 code skills and 15 instruction skills sat off, unseen.
 *
 * Now:
 *   - the create files ONE `capability.enable` for the skill, through the one
 *     proposer (`proposeCapabilityEnable`), and the agent's reply says it is
 *     switched off and waiting for the person, with the review link;
 *   - an agent's CODE skill that reaches nothing outside the pod (no
 *     `allowedHosts`, no declared tools, no `callProvider(` call) is born on,
 *     with no request — read by the same `skillReach` the review's
 *     "Can reach" uses; a box script never is;
 *   - a person's own create is unchanged (no request, same born state);
 *   - the request's review shows each skill whole (its code) and its reach,
 *     and only its page may approve it.
 *
 * Driven end to end: the REAL MCP handler (`synap_create_skill`) → the REAL
 * `skills.create` → the REAL gate, granted by the person's own rule → the
 * REAL proposer → the proposal ROW read back from PGlite → the REAL
 * `enrichProposalsForDisplay` and page-only rule on that stored row.
 *
 * Stubbed, and why (as `skills.proposal-names-skill.pglite.test.ts`): the
 * receipt-session mint and the agent's declared focus (they would wait on
 * PGlite's one connection), audit log, side effects, realtime, the session
 * channel and the tRPC read-only/audit middlewares: not this seam.
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
import * as schema from "@synap/database/schema";
import {
  proposalPageOnlyReason,
  type ProposalReviewModel,
} from "@synap-core/types/proposals";
import { resolveServiceName } from "@synap-core/types/service-marks";
import { buildHandlers } from "./build.js";
import type { McpToolContext } from "./shared.js";
import { skillsRouter } from "../../skills.js";
import { enrichProposalsForDisplay } from "../../proposals/display.js";
import { requestAgentSkillTurnOn } from "../../../services/capabilities/request-skill-turn-on.js";

const USER = randomUUID();
const AGENT = randomUUID();
const GMAIL_TOOL = randomUUID();

/** Reaches the person's Gmail connection through the pod. */
const CALLS_GMAIL = `const r = await callProvider("gmail", "GET", "/users/me/messages");
return r;`;
/** Pure computation: reaches nothing outside the pod. */
const PURE = `const n = Number(input.n ?? 0);
return { doubled: n * 2 };`;

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
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

type Reply = {
  id: string;
  status: string;
  approved?: boolean;
  waitingFor?: string;
  turnOnRequest?: { proposalId: string; reviewUrl: string };
  message?: string;
};

/** `synap_create_skill` as an agent key calls it. */
async function agentCreates(args: Record<string, unknown>): Promise<Reply> {
  const res = await buildHandlers.synap_create_skill!({
    toolName: "synap_create_skill",
    args,
    userId: USER,
    apiKeyScopes: ["mcp.write"],
    agentUserId: AGENT,
    caller: {} as McpToolContext["caller"],
    lensCaller: {} as McpToolContext["lensCaller"],
    workspaceAccessible: true,
  } as McpToolContext);
  const text = (res.content?.[0] as { text: string }).text;
  const reply = JSON.parse(text) as Reply;
  // Every case below is about the GRANTED path; a proposal or an error here
  // would make the assertions after it prove nothing.
  if (reply.status !== "created") {
    throw new Error(`expected the rule to grant the create, got ${text}`);
  }
  return reply;
}

/** The person's own create, through the same router (the operator door). */
const personCreates = (input: Record<string, unknown>) =>
  skillsRouter
    .createCaller({
      db: h.db,
      authenticated: true,
      userId: USER,
      user: null,
      session: null,
      req: undefined,
      workspaceId: null,
      agentUserId: null,
    } as never)
    .create(input as never);

async function approvedOf(skillId: string): Promise<boolean | null> {
  const { rows } = await q<{ approved: boolean | null }>(
    `select approved from skills where id = $1`,
    [skillId]
  );
  return rows[0]?.approved ?? null;
}

/** Every `capability.enable` row that names this skill. */
async function enableRequestsFor(skillId: string) {
  const { rows } = await q<{
    id: string;
    status: string;
    proposal_type: string;
    target_type: string;
    target_id: string;
    agent_user_id: string | null;
    data: { skillIds?: string[] };
  }>(
    `select id, status, proposal_type, target_type, target_id, agent_user_id, data
       from proposals
      where proposal_type = 'capability.enable'
        and data->'skillIds' ? $1`,
    [skillId]
  );
  return rows;
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
  // A connection tool the person can see: the name `requiredTools` resolves.
  await q(
    `insert into tools (id, created_by, name, kind, approved) values ($1, $2, 'gmail_api', 'provider', true)`,
    [GMAIL_TOOL, USER]
  );
  // The person's own rule, as on the founder pod: this agent's skill creates
  // are granted, so no person reviews them.
  await q(
    `insert into governance_rules (id, principal_kind, agent_user_id, scope_kind, target_kind, target_pattern, verdict, created_by, created_at)
     values (gen_random_uuid(), 'agent', $1, 'pod', 'action', 'skill.create', 'auto', $2, now())`,
    [AGENT, USER]
  );
});

describe("an agent's code skill that calls a connection (granted by a rule)", () => {
  it("is born OFF with exactly one turn-on request, and the agent is told so", async () => {
    const reply = await agentCreates({
      name: "inbox_count",
      description: "Count my unread mail",
      code: CALLS_GMAIL,
    });
    expect(await approvedOf(reply.id)).toBe(false);

    const requests = await enableRequestsFor(reply.id);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      status: "pending",
      proposal_type: "capability.enable",
      target_type: "capability",
      target_id: reply.id,
      agent_user_id: AGENT,
    });
    expect(requests[0]!.data.skillIds).toEqual([reply.id]);

    // The reply: still `created` (it is), switched off, waiting for the
    // person, with the request and its review link.
    expect(reply).toMatchObject({
      status: "created",
      approved: false,
      waitingFor: "person",
      turnOnRequest: { proposalId: requests[0]!.id },
    });
    expect(reply.turnOnRequest!.reviewUrl).toContain(requests[0]!.id);
    expect(reply.message).toMatch(/switched off/);
    expect(reply.message).toContain(reply.turnOnRequest!.reviewUrl);
  });

  it("filing again for the same skill does not file a second request", async () => {
    const reply = await agentCreates({ name: "inbox_peek", code: CALLS_GMAIL });
    const [first] = await enableRequestsFor(reply.id);
    const again = await requestAgentSkillTurnOn({
      skill: { id: reply.id, name: "inbox_peek", approved: false },
      authorAgentUserId: AGENT,
      personReviewed: false,
      userId: USER,
      workspaceId: null,
    });
    expect(again).toMatchObject({ status: "proposed", proposalId: first!.id });
    expect(await enableRequestsFor(reply.id)).toHaveLength(1);
  });

  it("the review shows the code whole and what it can reach", async () => {
    const reply = await agentCreates({ name: "inbox_read", code: CALLS_GMAIL });
    const [request] = await enableRequestsFor(reply.id);
    const row = (
      await q(`select * from proposals where id = $1`, [request!.id])
    ).rows[0]!;
    const [enriched] = await enrichProposalsForDisplay(
      [toProposalRow(row) as never],
      USER
    );
    const review = (enriched as unknown as { review: ProposalReviewModel })
      .review;
    expect(review.turnsOn).toEqual({
      skills: [
        {
          id: reply.id,
          name: "inbox_read",
          kind: "code",
          executionMode: "sync",
          code: CALLS_GMAIL,
          reach: {
            hosts: [],
            connections: [resolveServiceName("gmail")],
            unreadSteps: 0,
          },
        },
      ],
      unreadSkills: 0,
    });
  });

  it("only its page may approve it: the stored request is page-only", async () => {
    const reply = await agentCreates({ name: "inbox_page", code: CALLS_GMAIL });
    const [request] = await enableRequestsFor(reply.id);
    const row = (
      await q(`select * from proposals where id = $1`, [request!.id])
    ).rows[0]!;
    expect(proposalPageOnlyReason(toProposalRow(row) as never)).toBe(
      "acts_on_its_own"
    );
  });
});

describe("an agent's code skill is born ON only when it reaches nothing", () => {
  it("pure code (no hosts, no tools, no calls): approved, no request, a plain reply", async () => {
    const reply = await agentCreates({ name: "double_it", code: PURE });
    expect(await approvedOf(reply.id)).toBe(true);
    expect(await enableRequestsFor(reply.id)).toHaveLength(0);
    expect(reply).not.toHaveProperty("turnOnRequest");
    expect(reply).not.toHaveProperty("message");
  });

  it("declared tools are reach, though their edges are written after the insert", async () => {
    const reply = await agentCreates({
      name: "double_with_mail",
      code: PURE,
      requiredTools: ["gmail_api"],
    });
    expect(await approvedOf(reply.id)).toBe(false);
    expect(await enableRequestsFor(reply.id)).toHaveLength(1);
  });

  it("a provider call it does not write out is reach too (never read as nothing)", async () => {
    const reply = await agentCreates({
      name: "any_provider",
      code: `const p = input.provider;\nreturn await callProvider(p, "GET", "/x");`,
    });
    expect(await approvedOf(reply.id)).toBe(false);
    expect(await enableRequestsFor(reply.id)).toHaveLength(1);
  });

  it("a box script is never covered: off, with a request", async () => {
    const reply = await agentCreates({
      name: "local_script",
      code: "print(1 + 1)",
      executionMode: "box",
      box: { language: "python" },
    });
    expect(await approvedOf(reply.id)).toBe(false);
    expect(await enableRequestsFor(reply.id)).toHaveLength(1);
  });

  it("an instruction skill an agent wrote: off, with a request (its prose lands in a prompt)", async () => {
    const reply = await agentCreates({
      name: "house_rules",
      slug: "team/house-rules",
      body: "Always answer in French.",
    });
    expect(await approvedOf(reply.id)).toBe(false);
    expect(await enableRequestsFor(reply.id)).toHaveLength(1);
  });
});

describe("a person's own create is unchanged", () => {
  it("their code skill, even pure: off as before, and no request", async () => {
    const res = (await personCreates({ name: "my_double", code: PURE })) as {
      id: string;
      status: string;
    };
    expect(res.status).toBe("created");
    expect(await approvedOf(res.id)).toBe(false);
    expect(await enableRequestsFor(res.id)).toHaveLength(0);
    expect((res as { turnOnRequest?: unknown }).turnOnRequest).toBeUndefined();
  });

  it("their instruction skill: on as before, and no request", async () => {
    const res = (await personCreates({
      name: "my_rules",
      body: "Be brief.",
    })) as { id: string };
    expect(await approvedOf(res.id)).toBe(true);
    expect(await enableRequestsFor(res.id)).toHaveLength(0);
  });
});

/** A raw `proposals` row (snake_case) as the drizzle row the doors read. */
function toProposalRow(raw: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [
      k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
      v,
    ])
  );
}
