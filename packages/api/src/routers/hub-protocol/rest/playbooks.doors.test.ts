/**
 * Hub REST playbook doors (`POST /playbooks`, `POST /playbooks/:id/run`) reach
 * the SAME shared door and the SAME governed procedures as MCP.
 *
 * Drives the REAL REST routes → real `playbook-doors.ts` → real
 * `playbooksRouter.create` / `.run` (workspace floor, D3 preflight, gate call).
 * Replaced: the DB, the governance gate (records what reached it), the access
 * layer's single-row load, the unenabled-skill lookup and the enable-proposal
 * filer — the assertions are on what reached them and what came back.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const WS = "33333333-3333-4333-8333-333333333333";
const PB = "44444444-4444-4444-8444-444444444444";

const h = vi.hoisted(() => ({
  gateCalls: [] as Array<Record<string, unknown>>,
  enableCalls: [] as Array<Record<string, unknown>>,
  unenabled: [] as Array<{ id: string; name: string }>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    limit: vi.fn(async () => []),
    // Drizzle's query builder is THENABLE — awaiting it WITHOUT `.limit()`
    // executes the query. `playbooks.create`'s near-duplicate overlap scan
    // does exactly that, so without this the builder object itself reached
    // `rankByTerms` ("candidates.map is not a function") and every agent
    // create came back 500. Resolves EMPTY: no playbook pre-exists in these
    // fixtures, so the scan must find no overlap and the create must proceed
    // to the gate — which is precisely what this file asserts.
    then: (resolve: (v: unknown) => unknown) => resolve([]),
  };
  const fakeDb = {
    select: vi.fn(() => chain),
    query: {
      workspaceMembers: { findFirst: vi.fn(async () => ({ role: "editor" })) },
      workspaces: { findFirst: vi.fn(async () => ({ archivedAt: null })) },
      entities: { findFirst: vi.fn(async () => null) },
      focusSessions: { findFirst: vi.fn(async () => null) },
    },
    insert: vi.fn(() => {
      throw new Error("an agent write must not insert a row");
    }),
  };
  return { ...actual, db: fakeDb, getDb: vi.fn(async () => fakeDb) };
});

vi.mock("../../../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));

vi.mock("../../../utils/workspace-write-access.js", () => ({
  assertWorkspaceWrite: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    previewPermissionDecision: vi.fn(async () => ({ decision: "propose" })),
    checkPermissionOrPropose: vi.fn(async (opts: Record<string, unknown>) => {
      h.gateCalls.push(opts);
      return { proposalId: "prop-pb", proposalType: "playbook.create" };
    }),
  };
});

vi.mock("../../../access/index.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    scopedDb: vi.fn(() => ({
      findFirst: vi.fn(async () => ({
        id: PB,
        name: "Research a Question",
        workspaceId: WS,
      })),
    })),
  };
});

vi.mock("../../../services/playbooks/playbook-skill-preflight.js", () => ({
  findUnenabledPlaybookSkills: vi.fn(async () => h.unenabled),
}));

vi.mock(
  "../../../services/capabilities/propose-capability-enable.js",
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
      ...actual,
      proposeCapabilityEnable: vi.fn(async (input: Record<string, unknown>) => {
        h.enableCalls.push(input);
        return [
          {
            status: "proposed",
            proposalId: "enable-1",
            reviewUrl: "/open/enable-1",
            title: "Enable Research methods",
            skills: h.unenabled,
            originalActionRan: false,
            message: "Nothing ran.",
          },
        ];
      }),
    };
  }
);

vi.mock(
  "../../../services/playbooks/resolve-playbook-name.js",
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
      ...actual,
      resolvePlaybookByIdVisible: vi.fn(async () => ({
        id: PB,
        workspaceId: WS,
      })),
    };
  }
);

vi.mock("./_shared.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // The act-as grant lookup is a DB read; identity is not what this tests.
    resolveActorId: vi.fn(
      async (agentUserId: string | undefined, userId: string) => ({
        actorId: agentUserId ?? userId,
      })
    ),
  };
});

const { registerPlaybooksRoutes } = await import("./playbooks.js");
const { buildHandlers } = await import("../../mcp/handlers/build.js");

const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";

function appAs(agentUserId?: string) {
  const app = new OpenAPIHono();
  app.use("*", async (c, next) => {
    c.set(
      "scopes" as never,
      ["hub-protocol.read", "hub-protocol.write"] as never
    );
    c.set("userId" as never, USER as never);
    if (agentUserId) c.set("agentUserId" as never, agentUserId as never);
    await next();
  });
  registerPlaybooksRoutes(app as never);
  return app;
}

async function post(app: OpenAPIHono, path: string, body: unknown) {
  const res = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

beforeEach(() => {
  h.gateCalls.length = 0;
  h.enableCalls.length = 0;
  h.unenabled = [];
});

describe("POST /playbooks — governed create through the shared door", () => {
  it("an agent key gets 202 `proposed` with a review link; the gate saw the agent", async () => {
    const { status, body } = await post(appAs(AGENT), "/playbooks", {
      workspaceId: WS,
      name: "Weekly review",
      goalTemplate: "Review {{topic}}",
    });
    expect(status).toBe(202);
    expect(body).toMatchObject({
      status: "proposed",
      proposalId: "prop-pb",
      playbook: null,
    });
    expect(String(body.reviewUrl)).toContain("prop-pb");
    expect(h.gateCalls).toHaveLength(1);
    expect(h.gateCalls[0]).toMatchObject({
      agentUserId: AGENT,
      workspaceId: WS,
      subjectType: "playbook",
      action: "create",
    });
  });

  it("a missing workspace is a 400, never a membership guess", async () => {
    const { status } = await post(appAs(AGENT), "/playbooks", {
      name: "Weekly review",
      goalTemplate: "Review",
    });
    expect(status).toBe(400);
    expect(h.gateCalls).toEqual([]);
  });
});

describe("POST /playbooks/:id/run — the D3 preflight reaches Hub REST", () => {
  it("an agent run of a playbook using unenabled skills returns `blocked` + enableProposals; nothing ran", async () => {
    h.unenabled = [{ id: "skill-1", name: "exa_search" }];
    const { status, body } = await post(
      appAs(AGENT),
      `/playbooks/${PB}/run`,
      {}
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({
      status: "blocked",
      run: null,
      unenabledSkills: [{ name: "exa_search" }],
      enableProposals: [{ status: "proposed", proposalId: "enable-1" }],
    });
    expect(h.enableCalls[0]).toMatchObject({
      agentUserId: AGENT,
      workspaceId: WS,
    });
    // Blocked BEFORE the run gate — no run proposal that could only fail.
    expect(h.gateCalls).toEqual([]);
  });

  it("a human run of the same playbook is a 412 naming the skills (no proposal filed)", async () => {
    h.unenabled = [{ id: "skill-1", name: "exa_search" }];
    const { status, body } = await post(appAs(), `/playbooks/${PB}/run`, {});
    expect(status).toBe(412);
    expect(String(body.error)).toContain("exa_search");
    expect(h.enableCalls).toEqual([]);
  });

  it("an agent run with everything enabled gets 202 `proposed` from the run gate", async () => {
    const { status, body } = await post(
      appAs(AGENT),
      `/playbooks/${PB}/run`,
      {}
    );
    expect(status).toBe(202);
    expect(body).toMatchObject({ status: "proposed", proposalId: "prop-pb" });
    expect(h.gateCalls[0]).toMatchObject({
      agentUserId: AGENT,
      subjectType: "playbook",
      action: "run",
    });
  });

  it("MCP synap_run_playbook returns the SAME blocked shape (one door)", async () => {
    h.unenabled = [{ id: "skill-1", name: "exa_search" }];
    const rest = await post(appAs(AGENT), `/playbooks/${PB}/run`, {});
    const mcp = await buildHandlers.synap_run_playbook!({
      toolName: "synap_run_playbook",
      args: { playbookId: PB },
      userId: USER,
      apiKeyScopes: ["mcp.write"],
      agentUserId: AGENT,
      caller: {} as never,
      lensCaller: {} as never,
      workspaceAccessible: true,
    });
    const mcpBody = JSON.parse(
      (mcp.content as Array<{ text: string }>)[0].text
    );
    expect(mcpBody.status).toBe("blocked");
    expect(mcpBody.enableProposals).toEqual(rest.body.enableProposals);
    expect(mcpBody.unenabledSkills).toEqual(rest.body.unenabledSkills);
  });
});
