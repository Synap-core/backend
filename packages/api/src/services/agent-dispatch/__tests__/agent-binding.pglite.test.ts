/**
 * THE BINDING DOOR + THE REACH RULE, read back out of PGlite.
 *
 *   - `resolveAgentBinding`: no edge ⇒ null; a valid tool ⇒ the binding; a
 *     malformed / missing / wrong-kind / doubly-bound tool ⇒ a TYPED error,
 *     never null (an empty read and a broken one are different facts);
 *   - `resolveAgentReach`: 'pod' (IS agent, no own key), 'dispatch' (bound),
 *     'pull' (own key, no binding) — and the invariant that a bound or keyed
 *     agent is never 'pod';
 *   - `resolveWakeTarget` / `podRunAgentType` (session-answer) are reach-aware:
 *     a dispatch asker is a dispatch target, never an IS agent type.
 *
 * Real: the tables, both modules. Nothing stubbed but the db handle.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    close: () => Promise<void>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return {
    ...actual,
    db: drizzle(client, {
      schema: {
        users: actual.users as never,
        apiKeys: actual.apiKeys as never,
        links: actual.links as never,
        tools: actual.tools as never,
      },
    }),
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { users, apiKeys, links, tools } from "@synap/database";
import {
  AgentBindingError,
  resolveAgentBinding,
  resolveAgentReach,
  resolveAgentReachMany,
  listDispatchableAgentIds,
  loadAgentDispatchSummaries,
} from "../agent-binding.js";
import {
  podRunAgentType,
  resolveWakeTarget,
  resolveWakeAgentType,
} from "../../focus-sessions/session-answer.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key default gen_random_uuid()" : ""}${c.name === "created_at" ? " default now()" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const VALID_BINDING = {
  protocol: "a2a",
  provider: "acme-cloud-agent",
  supports: { push: false, inputRequired: true, cancel: true },
  verbs: {
    start: "acme_start_task",
    send: "acme_send_message",
    cancel: "acme_cancel_task",
    status: "acme_task_status",
  },
};

const OWNER = randomUUID();
const IS_AGENT = randomUUID();
const PULL_AGENT = randomUUID();
const BOUND_AGENT = randomUUID();
const MALFORMED_AGENT = randomUUID();
const GONE_AGENT = randomUUID();
const WRONG_KIND_AGENT = randomUUID();
const DOUBLE_AGENT = randomUUID();
const TEAMMATE = randomUUID();
const FOREIGN_AGENT = randomUUID();
const GOOD_TOOL = randomUUID();
const BAD_TOOL = randomUUID();
const API_TOOL = randomUUID();

async function addTool(
  id: string,
  config: unknown,
  kind = "external",
  executor = "external-agent"
) {
  await q(
    `insert into tools (id, workspace_id, created_by, name, kind, executor, config, status, approved, metadata, input_schema, capabilities)
     values ($1, null, $2, 'tool', $3, $4, $5::jsonb, 'active', true, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb)`,
    [id, OWNER, kind, executor, JSON.stringify(config)]
  );
}
async function bind(agent: string, tool: string) {
  await q(
    `insert into links (id, from_type, from_id, to_type, to_id, link_type, metadata) values ($1, 'participant', $2, 'tool', $3, 'dispatched_via', '{}'::jsonb)`,
    [randomUUID(), agent, tool]
  );
}

describe("agent binding + reach", () => {
  beforeAll(async () => {
    for (const t of [users, apiKeys, links, tools]) {
      await h.client!.exec(ddlFor(t as unknown as PgTable));
    }
    await q(
      `insert into users (id, email, name, timezone, user_type, agent_type) values
        ($1, 'o@x.test', 'Owner', 'UTC', 'human', null),
        ($2, 'r@x.test', 'Researcher', 'UTC', 'agent', 'researcher'),
        ($3, 'c@x.test', 'Claude Code', 'UTC', 'agent', 'claude-code'),
        ($4, 'b@x.test', 'Cloud agent', 'UTC', 'agent', 'cloud-coder'),
        ($5, 'm@x.test', 'Malformed', 'UTC', 'agent', 'm'),
        ($6, 'g@x.test', 'Gone', 'UTC', 'agent', 'g'),
        ($7, 'w@x.test', 'Wrong kind', 'UTC', 'agent', 'w'),
        ($8, 'd@x.test', 'Double', 'UTC', 'agent', 'd')`,
      [
        OWNER,
        IS_AGENT,
        PULL_AGENT,
        BOUND_AGENT,
        MALFORMED_AGENT,
        GONE_AGENT,
        WRONG_KIND_AGENT,
        DOUBLE_AGENT,
      ]
    );
    // The pull agent works through its own door key.
    await q(
      `insert into api_keys (id, user_id, key_type, linked_user_id) values ($1, $2, 'hub_inbound', $3)`,
      [randomUUID(), PULL_AGENT, OWNER]
    );
    // The bound agent ALSO owns a key (for MCP write-back) — still 'dispatch'.
    await q(
      `insert into api_keys (id, user_id, key_type, linked_user_id) values ($1, $2, 'hub_inbound', $3)`,
      [randomUUID(), BOUND_AGENT, OWNER]
    );
    await addTool(GOOD_TOOL, { agentBinding: VALID_BINDING });
    await addTool(BAD_TOOL, {
      agentBinding: { ...VALID_BINDING, verbs: { start: "x" } },
    });
    await addTool(API_TOOL, { agentBinding: VALID_BINDING }, "api", "is-agent");
    await bind(BOUND_AGENT, GOOD_TOOL);
    await bind(MALFORMED_AGENT, BAD_TOOL);
    await bind(GONE_AGENT, randomUUID());
    await bind(WRONG_KIND_AGENT, API_TOOL);
    await bind(DOUBLE_AGENT, GOOD_TOOL);
    await bind(DOUBLE_AGENT, BAD_TOOL);
    // Every agent above is the OWNER's; a teammate's bound agent is not.
    await q(
      `update users set created_by_user_id = $1 where user_type = 'agent'`,
      [OWNER]
    );
    await q(
      `insert into users (id, email, name, timezone, user_type, agent_type, created_by_user_id) values
        ($1, 't@x.test', 'Teammate', 'UTC', 'human', null, null),
        ($2, 'f@x.test', 'Their agent', 'UTC', 'agent', 'theirs', $1)`,
      [TEAMMATE, FOREIGN_AGENT]
    );
    await bind(FOREIGN_AGENT, GOOD_TOOL);
  }, 120_000);

  afterAll(async () => {
    await h.client?.close();
  });

  // ── resolveAgentBinding ────────────────────────────────────────────────────

  it("no edge ⇒ null", async () => {
    expect(await resolveAgentBinding(IS_AGENT)).toBeNull();
    expect(await resolveAgentBinding(PULL_AGENT)).toBeNull();
  });

  it("a valid binding tool ⇒ the binding, resolved to its tool", async () => {
    expect(await resolveAgentBinding(BOUND_AGENT)).toEqual({
      toolId: GOOD_TOOL,
      workspaceId: null,
      provider: "acme-cloud-agent",
      protocol: "a2a",
      supports: VALID_BINDING.supports,
      verbs: VALID_BINDING.verbs,
    });
  });

  it.each([
    [MALFORMED_AGENT, "malformed"],
    [GONE_AGENT, "tool_missing"],
    [WRONG_KIND_AGENT, "not_an_agent_tool"],
    [DOUBLE_AGENT, "ambiguous"],
  ] as const)(
    "a broken binding is a TYPED error, never null (%s → %s)",
    async (agent, code) => {
      const err = await resolveAgentBinding(agent).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AgentBindingError);
      expect((err as AgentBindingError).code).toBe(code);
    }
  );

  // ── resolveAgentReach ──────────────────────────────────────────────────────

  it("reach: pod / dispatch / pull", async () => {
    expect(await resolveAgentReach(IS_AGENT)).toBe("pod");
    expect(await resolveAgentReach(BOUND_AGENT)).toBe("dispatch");
    expect(await resolveAgentReach(PULL_AGENT)).toBe("pull");
    // A broken binding is still external — never an IS turn.
    expect(await resolveAgentReach(MALFORMED_AGENT)).toBe("dispatch");
    // A human / unknown id has nothing to run.
    expect(await resolveAgentReach(OWNER)).toBe("pull");
    expect(await resolveAgentReach(randomUUID())).toBe("pull");
  });

  it("the batched read agrees with the single read", async () => {
    const many = await resolveAgentReachMany([
      IS_AGENT,
      BOUND_AGENT,
      PULL_AGENT,
    ]);
    expect(Object.fromEntries(many)).toEqual({
      [IS_AGENT]: "pod",
      [BOUND_AGENT]: "dispatch",
      [PULL_AGENT]: "pull",
    });
  });

  it("roster summaries carry the binding, and a broken one as an error", async () => {
    const s = await loadAgentDispatchSummaries([
      BOUND_AGENT,
      MALFORMED_AGENT,
      IS_AGENT,
    ]);
    expect(s.get(BOUND_AGENT)).toEqual({
      reach: "dispatch",
      binding: {
        toolId: GOOD_TOOL,
        provider: "acme-cloud-agent",
        supports: VALID_BINDING.supports,
      },
    });
    expect(s.get(MALFORMED_AGENT)?.binding?.error?.code).toBe("malformed");
    expect(s.get(IS_AGENT)).toEqual({ reach: "pod", binding: null });
  });

  it("dispatchable agents = the person's OWN agents with a binding edge", async () => {
    const ids = await listDispatchableAgentIds(OWNER);
    expect(ids).toContain(BOUND_AGENT);
    expect(ids).not.toContain(IS_AGENT);
    expect(ids).not.toContain(PULL_AGENT);
    // A teammate's bound agent is theirs to dispatch, never this person's.
    expect(ids).not.toContain(FOREIGN_AGENT);
    expect(await listDispatchableAgentIds(TEAMMATE)).toEqual([FOREIGN_AGENT]);
  });

  // ── session-answer is reach-aware ──────────────────────────────────────────

  it("podRunAgentType: only a 'pod' agent has a type to run", async () => {
    expect(await podRunAgentType(IS_AGENT)).toBe("researcher");
    expect(await podRunAgentType(PULL_AGENT)).toBeNull();
    expect(await podRunAgentType(BOUND_AGENT)).toBeNull();
  });

  it("resolveWakeTarget: a dispatch asker is a dispatch target, never an IS type", async () => {
    expect(await resolveWakeTarget({ askingAgentUserId: BOUND_AGENT })).toEqual(
      {
        reach: "dispatch",
        agentUserId: BOUND_AGENT,
        agentType: "cloud-coder",
      }
    );
    expect(
      await resolveWakeAgentType({ askingAgentUserId: BOUND_AGENT })
    ).toBeNull();
    expect(await resolveWakeTarget({ askingAgentUserId: IS_AGENT })).toEqual({
      reach: "pod",
      agentType: "researcher",
    });
    expect(
      await resolveWakeTarget({ askingAgentUserId: PULL_AGENT })
    ).toBeNull();
  });

  it("resolveWakeTarget without a question: skips pull agents, finds a dispatch one", async () => {
    expect(
      await resolveWakeTarget({ agentIds: [PULL_AGENT, BOUND_AGENT] })
    ).toMatchObject({ reach: "dispatch", agentUserId: BOUND_AGENT });
    expect(await resolveWakeTarget({ agentIds: [PULL_AGENT] })).toBeNull();
  });
});
