/**
 * S7 W2d — the founder's decisions D1, D3 and D5 (plan 13 §2(d), accepted as
 * recommended 2026-10-20), applied inside the doors so every door (tRPC, Hub
 * REST, MCP) inherits them:
 *
 *  - D1 automations.create/update/activate/trigger: a flow runs as its author
 *    with no grant, so arming one is OWNER authority. A person's scoped key is
 *    refused (it needs unbounded `*`); an agent key keeps its governed path —
 *    an agent's activation is filed for review.
 *  - D3 proposals.updateProposal: revising honours the key's space pin, on the
 *    proposal's own workspace (asserted at the revise core — see below).
 *  - D5 observations.append: an observation is `event.create` where it lands,
 *    and a scoped key's observation never widens to pod-wide.
 *
 * Driven through the REAL Bearer door (`hubProtocolRouter` → `apiKeyMiddleware`
 * → the procedure) on PGlite with every @synap/database table; only the key
 * lookup, identity resolution and delivery side effects are stubbed.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  grant: null as unknown,
  agentUserId: undefined as string | undefined,
  stubGate: null as null | ((...args: unknown[]) => unknown),
}));

// The proposal writer imports the pg client module directly (not the
// package barrel), so the in-memory database is installed THERE, first; the
// barrel below then re-exports the same handle.
vi.mock("../../../../database/dist/client-pg.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  return { ...actual, db: h.db };
});
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  // The event log appends over its own connection (no PGlite): a no-op here,
  // the timeline is not under test.
  const eventRepository = new Proxy(
    {},
    { get: () => async () => ({ id: "event" }) }
  );
  return {
    ...actual,
    db: h.db,
    getDb: async () => h.db,
    eventRepository,
    getEventRepository: () => eventRepository,
  };
});
// PGlite runs ONE connection: the proposal writer's transaction deadlocks on
// it. Where a case needs the gate's verdict it stubs the gate (h.stubGate);
// every other call reaches the real one.
vi.mock("../../utils/permission-check.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../utils/permission-check.js")>();
  return {
    ...actual,
    checkPermissionOrPropose: vi.fn((...args: unknown[]) =>
      h.stubGate
        ? h.stubGate(...args)
        : (actual.checkPermissionOrPropose as (...a: unknown[]) => unknown)(
            ...args
          )
    ),
  };
});
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
  getBoss: () => ({ send: async () => null }),
}));
vi.mock("../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: () => undefined,
}));
// The AI turn is enqueued for the IS: not under test.
vi.mock("../../utils/trigger-auto-respond.js", () => ({
  triggerAutoRespond: vi.fn(async () => true),
}));
vi.mock("../../services/api-keys.js", () => ({
  apiKeyService: {
    validateApiKey: vi.fn(async () => ({
      id: "11111111-1111-4111-8111-111111111111",
      userId: "user-w2d",
      linkedUserId: null,
      keyName: "w2a",
      keyType: "user_pat",
      workspaceId: null,
      scope: ["hub-protocol.read", "hub-protocol.write"],
    })),
    checkRateLimit: vi.fn(() => true),
  },
}));
vi.mock("../../access/key-identity.js", () => ({
  resolveKeyIdentity: vi.fn(async () => ({
    effectiveUserId: "user-w2d",
    agentUserId: h.agentUserId,
    grant: h.grant,
  })),
}));

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { hubProtocolRouter } from "./index.js";
import { assertMayReviseProposal } from "../proposals/review-authority.js";

const USER = "user-w2d";
const AGENT = "agent-w2d";
const WS = randomUUID();
const OTHER_WS = randomUUID();
const WS_FLOW = randomUUID();
const WS_FLOW_2 = randomUUID();
const AGENT_FLOW = randomUUID(); // the agent case's own flow

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const key = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    return `"${c.name}" ${type}${key}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const scope = (permissions: string[], workspaceIds: string[] | null) => ({
  permissions,
  workspaceIds,
  projectIds: null,
  entityIds: null,
});
const READS = scope(["automation.read", "proposal.read", "event.read"], null);
/** Reads anywhere; may do ANYTHING, but only in WS. */
const WRITE_IN_WS = { scopes: [READS, scope(["*"], [WS])], clientId: null };
/** Unrestricted full access — the owner's own tooling key. */
const FULL = { scopes: [scope(["*"], null)], clientId: null };

/** The Bearer door with `x-workspace-id: WS` (createContext → ctx.workspaceId). */
function hub(grant: unknown, agentUserId?: string) {
  h.grant = grant;
  h.agentUserId = agentUserId;
  const req = new Request("http://pod.test/api/hub/trpc/x", {
    headers: { authorization: "Bearer sk_test", "x-workspace-id": WS },
  });
  return hubProtocolRouter.createCaller({
    req,
    authenticated: false,
    workspaceId: WS,
  } as never);
}

const OWNER_WIDE = {
  code: "FORBIDDEN",
  message: expect.stringMatching(/unrestricted full access/),
};

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  await q(
    `insert into users (id, email, user_type) values ($1, $2, 'human'), ($3, $4, 'agent')`,
    [USER, `${USER}@x`, AGENT, `${AGENT}@x`]
  );
  for (const ws of [WS, OTHER_WS]) {
    await q(
      `insert into workspaces (id, owner_id, name) values ($1, $2, 'w')`,
      [ws, USER]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role)
       values (gen_random_uuid(), $1, $2, 'owner'), (gen_random_uuid(), $1, $3, 'editor')`,
      [ws, USER, AGENT]
    );
  }
  await q(
    `insert into automations (id, created_by, workspace_id, name, status, trigger_type, trigger_config, flow_definition, version, metadata)
     values ($1, $3, $4, 'flow', 'draft', 'manual', '{}', '{"nodes":[],"edges":[]}', 1, '{}'),
            ($2, $3, $4, 'flow 2', 'draft', 'manual', '{}', '{"nodes":[],"edges":[]}', 1, '{}'),
            ($5, $3, $4, 'flow 3', 'draft', 'manual', '{}', '{"nodes":[],"edges":[]}', 1, '{}')`,
    [WS_FLOW, WS_FLOW_2, USER, WS, AGENT_FLOW]
  );
});

describe("D1 — arming a flow is owner authority (W2d)", () => {
  it("a person's key pinned to W cannot activate, create, update or run a flow", async () => {
    await expect(
      hub(WRITE_IN_WS).automations.activateAutomation({
        userId: USER,
        id: WS_FLOW,
      })
    ).rejects.toMatchObject(OWNER_WIDE);
    await expect(
      hub(WRITE_IN_WS).automations.createAutomation({
        userId: USER,
        workspaceId: WS,
        name: "armed by a scoped key",
        triggerType: "manual",
        flowDefinition: { nodes: [], edges: [] },
        status: "active",
      })
    ).rejects.toMatchObject(OWNER_WIDE);
    await expect(
      hub(WRITE_IN_WS).automations.updateAutomation({
        userId: USER,
        id: WS_FLOW,
        status: "active",
      })
    ).rejects.toMatchObject(OWNER_WIDE);
    await expect(
      hub(WRITE_IN_WS).automations.triggerAutomation({
        userId: USER,
        id: WS_FLOW,
      })
    ).rejects.toMatchObject(OWNER_WIDE);
    const { rows } = await q<{ status: string }>(
      `select status from automations where id = $1`,
      [WS_FLOW]
    );
    expect(rows[0]?.status).toBe("draft");
    const runs = await q(`select id from automation_runs`);
    expect(runs.rows).toHaveLength(0);
  });

  it("an agent key with the same grant files its activation for review", async () => {
    const gate = vi.fn(async () => ({ proposalId: "p-1", proposalType: "x" }));
    h.stubGate = gate;
    try {
      const res = await hub(WRITE_IN_WS, AGENT).automations.activateAutomation({
        userId: USER,
        id: AGENT_FLOW,
      });
      expect(res).toMatchObject({ status: "proposed", proposalId: "p-1" });
    } finally {
      h.stubGate = null;
    }
    // The agent's activation reached the governance gate AS the agent.
    expect(gate).toHaveBeenCalledWith(
      expect.objectContaining({
        agentUserId: AGENT,
        subjectType: "automation",
        action: "activate",
      })
    );
    const { rows } = await q<{ status: string }>(
      `select status from automations where id = $1`,
      [AGENT_FLOW]
    );
    expect(rows[0]?.status).toBe("draft");
  });

  it("CONTROL — the owner's unrestricted key activates directly", async () => {
    const res = await hub(FULL).automations.activateAutomation({
      userId: USER,
      id: WS_FLOW_2,
    });
    expect(res).not.toMatchObject({ status: "proposed" });
    const { rows } = await q<{ status: string }>(
      `select status from automations where id = $1`,
      [WS_FLOW_2]
    );
    expect(rows[0]?.status).toBe("active");
  });
});

// D3 at the one revise core every revise door reaches (`mergeProposalRevision`
// → `assertMayReviseProposal`). Asserted on the function itself: its door's
// row-locking transaction deadlocks PGlite's single connection.
describe("D3 — revising a proposal honours the key's space pin (W2d)", () => {
  const PROPOSAL = (workspaceId: string | null) => ({
    agentUserId: null,
    workspaceId,
    projectId: null,
    targetId: null,
  });

  it("a key pinned to W cannot revise a proposal in another space, or a pod-wide one", () => {
    for (const ws of [OTHER_WS, null]) {
      expect(() =>
        assertMayReviseProposal(PROPOSAL(ws), undefined, WRITE_IN_WS as never)
      ).toThrow(/space or project/);
    }
  });

  it("an agent revising ITS OWN proposal is unaffected", () => {
    expect(() =>
      assertMayReviseProposal(
        { ...PROPOSAL(OTHER_WS), agentUserId: AGENT },
        AGENT,
        WRITE_IN_WS as never
      )
    ).not.toThrow();
  });

  it("CONTROL — the same key revises a proposal in W", () => {
    expect(() =>
      assertMayReviseProposal(PROPOSAL(WS), undefined, WRITE_IN_WS as never)
    ).not.toThrow();
  });
});

describe("D5 — an observation is event.create where it lands (W2d)", () => {
  const append = (workspaceId?: string) =>
    hub(WRITE_IN_WS).observations.append({
      observations: [
        {
          type: "dev.commit",
          subjectType: "repo",
          subjectId: "repo-1",
          ...(workspaceId ? { workspaceId } : {}),
          data: {},
        },
      ],
    });

  it("a key pinned to W records nothing in another space, pod-wide, or in an unknown one", async () => {
    for (const ws of [OTHER_WS, undefined, randomUUID()]) {
      const res = await append(ws);
      expect(res.recorded, String(ws)).toBe(0);
    }
    expect((await append(OTHER_WS)).results[0]).toMatchObject({
      ok: false,
      error: expect.stringMatching(/grant does not allow/),
    });
  });

  it("CONTROL — the same key records an observation in W", async () => {
    const res = await append(WS);
    expect(res.recorded).toBe(1);
  });
});
