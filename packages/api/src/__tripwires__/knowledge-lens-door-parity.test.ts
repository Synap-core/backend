/**
 * TRIPWIRE — every knowledge ANSWER door resolves lens + catalog identically.
 *
 * THE DEFECT: three doors run the same retrieve+synthesize answer, and at POD
 * scope (no workspace) each inferred the entity-type CATALOG differently:
 *   • Hub `POST /knowledge/answer` — the pod-wide profile UNION (correct);
 *   • MCP `synap_ask`              — NO catalog at all;
 *   • tRPC `knowledge.answer`      — the caller's FIRST workspace (an unordered
 *     SELECT). Relay's pod-wide ask rides this door, so a `client` kind living
 *     in any other workspace was unnameable and "who are my clients" missed.
 * The fix is ONE helper (`services/knowledge/resolve-lens.ts`) every door calls.
 *
 * WHAT THIS PROVES (behaviour, not shape): it DRIVES each real door — the tRPC
 * router via `createCaller`, the Hub routes via a real Hono app, the MCP
 * handler directly — with the same pod-scope question, and captures the
 * `catalog` + `workspaceId` each one hands to `ask()`. It asserts:
 *   1. SAMENESS — every door hands `ask()` the identical catalog and lens;
 *   2. CORRECTNESS — that catalog is the pod-wide UNION (profiles from BOTH
 *      workspaces), because a convergence guard alone proves sameness, never
 *      correctness (guards-and-tests.md): three doors agreeing on "first
 *      workspace" would pass (1) and fail (2);
 *   3. a workspace lens narrows the catalog on every door, and a NON-member
 *      workspace degrades to pod-wide on every door (never honoured);
 *   4. an AGENT caller's declared focus reaches `ask()` as a BOOST (`focus`),
 *      never as the lens, on every door, and the `lens` block `ask()` returns
 *      reaches every door's response (structural plan S1). A door that drops
 *      the agent id, or forwards the focus as `workspaceId`, fails here.
 *
 * The repository is stubbed so the catalog DIFFERS by lens: `""` (pod-wide)
 * returns ws-A ∪ ws-B profiles, `ws-A` returns only ws-A's. A door that
 * resolved "first workspace" gets ws-A only; a door with no catalog gets [].
 *
 * NEGATIVE CONTROL (run 2026-09-25): reverting tRPC `knowledge.ts` to its old
 * `getUserWorkspaceIds()[0]` catalog, and separately MCP `synap_ask` to its old
 * "no catalog when unscoped" branch, each turned the pod-scope parity test RED.
 *
 * DOES NOT COVER: a NEW knowledge door. Door membership here is hand-listed
 * (the three answer doors + Hub search/ask). `cross-door-field-parity.test.ts`
 * discovers doors by import; this one drives them, which a scan cannot do.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";

const USER = "user-1";
const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WS_FOREIGN = "ffffffff-ffff-4fff-8fff-ffffffffffff";

const PROFILES_A = [{ slug: "task", displayName: "Task" }];
const PROFILES_B = [
  { slug: "client", displayName: "Client", plural: "Clients" },
];

const AGENT = "agent-1";
const LENS = {
  filter: { workspaceId: null, projectId: null },
  boost: { workspaceId: WS_B, projectId: null },
  source: "agent_focus",
};

const { askMock, synthesizeMock, getAccessibleProfiles } = vi.hoisted(() => ({
  askMock: vi.fn(),
  synthesizeMock: vi.fn(),
  getAccessibleProfiles: vi.fn(),
}));

// The agent's declared focus: a workspace the caller can see.
vi.mock("../services/agent-identity-service.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../services/agent-identity-service.js")
  >()),
  getAgentFocusWorkspaceId: async (agentUserId: string) =>
    agentUserId === AGENT ? WS_B : null,
  getAgentFocusProjectId: async () => null,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    getDb: async () => ({}),
    ProfileRepository: class {
      getAccessibleProfiles = getAccessibleProfiles;
    },
  };
});

vi.mock("../utils/workspace-membership.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../utils/workspace-membership.js")>();
  const visible = [WS_A, WS_B];
  return {
    ...actual,
    // Order matters for the negative control: a "first workspace" door picks WS_A.
    getUserWorkspaceIds: async () => visible,
    validateWorkspaceAccess: async (_u: string, requested?: string[]) =>
      requested && requested.length > 0
        ? requested.filter((id) => visible.includes(id))
        : visible,
  };
});

vi.mock("../services/knowledge/ask.js", () => ({ ask: askMock }));
vi.mock("../services/knowledge/synthesize.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../services/knowledge/synthesize.js")
  >()),
  synthesizeAnswer: synthesizeMock,
}));

const { knowledgeRouter } = await import("../routers/knowledge.js");
const { registerKnowledgeRoutes } =
  await import("../routers/hub-protocol/rest/knowledge.js");
const { readHandlers } = await import("../routers/mcp/handlers/read.js");

const hubApp = (() => {
  const app = new OpenAPIHono();
  app.use("*", async (c, next) => {
    c.set("scopes" as never, ["hub-protocol.read"] as never);
    c.set("userId" as never, USER as never);
    const agent = c.req.header("x-test-agent");
    if (agent) c.set("agentUserId" as never, agent as never);
    await next();
  });
  registerKnowledgeRoutes(app as never);
  return app;
})();

type Captured = { catalog: unknown; workspaceId: unknown };
type Driven = Captured & { focus: unknown; response: unknown };

function lastAsk(response: unknown): Driven {
  const call = askMock.mock.calls.at(-1)?.[0] as
    (Captured & { focus?: unknown }) | undefined;
  if (!call) throw new Error("door never reached ask()");
  return {
    catalog: call.catalog,
    workspaceId: call.workspaceId,
    focus: call.focus ?? null,
    response,
  };
}

const trpc = (agent?: string) =>
  knowledgeRouter.createCaller({
    authenticated: true,
    userId: USER,
    ...(agent ? { agentUserId: agent } : {}),
  } as never);
const hub = async (path: string, body: object, agent?: string) => {
  const res = await hubApp.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(agent ? { "x-test-agent": agent } : {}),
    },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return res.json();
};

/** Each door, driven for real, returns what it handed `ask()` + its response. */
const DOORS: Record<string, (ws?: string, agent?: string) => Promise<Driven>> =
  {
    "tRPC knowledge.answer": async (ws, agent) =>
      lastAsk(
        await trpc(agent).answer({
          query: "who are my clients",
          workspaceId: ws,
        })
      ),
    "tRPC knowledge.search": async (ws, agent) =>
      lastAsk(
        await trpc(agent).search({
          query: "who are my clients",
          workspaceId: ws,
        })
      ),
    "Hub POST /knowledge/answer": async (ws, agent) =>
      lastAsk(
        await hub(
          "/knowledge/answer",
          { question: "who are my clients", workspaceId: ws },
          agent
        )
      ),
    "Hub POST /knowledge/search": async (ws, agent) =>
      lastAsk(
        await hub(
          "/knowledge/search",
          { query: "who are my clients", workspaceId: ws },
          agent
        )
      ),
    "MCP synap_ask": async (ws, agent) => {
      const result = await readHandlers.synap_ask!({
        toolName: "synap_ask",
        args: {
          query: "who are my clients",
          ...(ws ? { workspaceId: ws } : {}),
        },
        userId: USER,
        ...(agent ? { agentUserId: agent } : {}),
        apiKeyScopes: ["mcp.read"],
        caller: {} as never,
        lensCaller: {} as never,
        workspaceAccessible: false,
      });
      const text = (result.content?.[0] as { text?: string } | undefined)?.text;
      return lastAsk(text ? JSON.parse(text) : null);
    },
  };

beforeEach(() => {
  askMock.mockReset();
  askMock.mockResolvedValue({
    answers: [],
    routedTo: [],
    pending: null,
    degraded: [],
    verdict: "empty",
    lens: LENS,
  });
  synthesizeMock.mockReset();
  synthesizeMock.mockResolvedValue({
    answer: "ok",
    sources: [],
    routedTo: [],
  });
  getAccessibleProfiles.mockReset();
  getAccessibleProfiles.mockImplementation(async (_u: string, ws: string) => {
    if (ws === "") return [...PROFILES_A, ...PROFILES_B];
    if (ws === WS_A) return PROFILES_A;
    if (ws === WS_B) return PROFILES_B;
    return [];
  });
});

const UNION = [
  { slug: "task", displayName: "Task" },
  { slug: "client", displayName: "Client", plural: "Clients" },
];

describe("knowledge doors — ONE lens + catalog resolution", () => {
  it("non-vacuity: drives at least the three answer doors", () => {
    expect(Object.keys(DOORS).length).toBeGreaterThanOrEqual(3);
  });

  it("POD scope: every door hands ask() the pod-wide profile UNION and a null lens", async () => {
    const seen: Record<string, Captured> = {};
    for (const [name, drive] of Object.entries(DOORS)) {
      seen[name] = await drive(undefined);
    }
    for (const [name, got] of Object.entries(seen)) {
      expect({
        door: name,
        catalog: got.catalog,
        workspaceId: got.workspaceId,
      }).toEqual({
        door: name,
        catalog: UNION,
        workspaceId: null,
      });
    }
  });

  it("WORKSPACE lens narrows the catalog to that workspace on every door", async () => {
    for (const [name, drive] of Object.entries(DOORS)) {
      const got = await drive(WS_B);
      expect({
        door: name,
        catalog: got.catalog,
        workspaceId: got.workspaceId,
      }).toEqual({
        door: name,
        catalog: [{ slug: "client", displayName: "Client", plural: "Clients" }],
        workspaceId: WS_B,
      });
    }
  });

  it("a NON-member workspace degrades to pod-wide on every door (never honoured)", async () => {
    for (const [name, drive] of Object.entries(DOORS)) {
      const got = await drive(WS_FOREIGN);
      expect({
        door: name,
        catalog: got.catalog,
        workspaceId: got.workspaceId,
      }).toEqual({
        door: name,
        catalog: UNION,
        workspaceId: null,
      });
    }
    expect(getAccessibleProfiles).not.toHaveBeenCalledWith(USER, WS_FOREIGN);
  });

  it("an AGENT's declared focus reaches ask() as a boost, never the lens, and `lens` reaches the response", async () => {
    for (const [name, drive] of Object.entries(DOORS)) {
      const got = await drive(undefined, AGENT);
      expect({
        door: name,
        workspaceId: got.workspaceId,
        focus: got.focus,
        lens: (got.response as { lens?: unknown } | null)?.lens,
      }).toEqual({
        door: name,
        workspaceId: null, // still pod-wide: the focus is not a filter
        focus: { workspaceId: WS_B, projectId: null, source: "agent_focus" },
        lens: LENS,
      });
    }
  });

  it("a PERSON (no agent) gets no focus on any door", async () => {
    for (const [name, drive] of Object.entries(DOORS)) {
      const got = await drive(undefined);
      expect({ door: name, focus: got.focus }).toEqual({
        door: name,
        focus: null,
      });
    }
  });
});
