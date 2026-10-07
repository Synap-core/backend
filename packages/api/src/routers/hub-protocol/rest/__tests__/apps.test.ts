/**
 * APP CONNECT — the register → connect → approve → key flow, plus the negative
 * control that `/apps/:id/key` refuses a caller who is NOT the app's owner.
 *
 * WHY HANDLER-LEVEL WITH MOCKED SEAMS: these prove what the ROUTE decides (the
 * wire contract the shipped CLI depends on) and, critically, that a non-owner
 * is refused BEFORE any key is minted or grant attached. Postgres is down in
 * CI-less sessions, and a self-skipping live suite proves nothing when it
 * skips. The seams that are mocked are exactly the side-effect doors the route
 * calls (`ApiKeyRepository.create`, `attachGrantOrRevoke`, `revokeApiKeys`,
 * `createPendingProposal`) and `AppRepository` (the one write door) — so the
 * assertions read the arguments those doors actually receive.
 *
 * WIRE CONTRACT (CLI c5d6cfa): `:id` is the PUBLIC id; register returns
 * `{ app: { public_id } }`; `/key` returns `{ apiKey, keyId }`.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "0aaaaaaa-0000-4000-8000-000000000001";
const OTHER = "0bbbbbbb-0000-4000-8000-000000000002";
const AGENT = "0ccccccc-0000-4000-8000-000000000003";
const APP_UUID = "1e1e1e1e-0000-4000-8000-0000000000aa";
const PUBLIC_ID = "app_1e1e1e1e-0000-4000-8000-0000000000aa";
const WORKSPACE_ID = "2f2f2f2f-0000-4000-8000-0000000000bb";
const PROPOSAL_ID = "3a3a3a3a-0000-4000-8000-0000000000cc";

function makeApp(overrides: Record<string, unknown> = {}) {
  return {
    id: APP_UUID,
    ownerUserId: OWNER,
    publicId: PUBLIC_ID,
    name: "synap.live",
    description: null,
    logoUrl: null,
    mode: "specific",
    approvedRequests: null as Array<{
      permission: string;
      workspaceId: string;
    }> | null,
    metadata: {},
    lastUsedAt: null,
    createdAt: new Date("2026-10-06T00:00:00Z"),
    revokedAt: null,
    ...overrides,
  };
}

const state = {
  app: makeApp(),
  registered: null as Record<string, unknown> | null,
  proposalInput: null as Record<string, unknown> | null,
  grantArgs: null as Record<string, unknown> | null,
  keyInput: null as Record<string, unknown> | null,
  revokedKeyCalls: [] as Array<Record<string, unknown>>,
  revokedGrantKeyIdCalls: [] as string[][],
  approvedWrites: [] as Array<{ appId: string; requests: unknown }>,
  existingKeyIds: [] as string[],
  workspaceIds: [WORKSPACE_ID],
  selectResult: [] as Array<Record<string, unknown>>,
};

function chain(result: unknown): any {
  const c: any = {
    from: () => c,
    where: () => c,
    limit: () => Promise.resolve(result),
    orderBy: () => c,
    set: () => c,
    values: () => c,
    returning: () => Promise.resolve(result),
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(res, rej),
  };
  return c;
}

const fakeDb: any = {
  select: () => chain(state.selectResult),
  update: () => chain([]),
  insert: () => chain([]),
  transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(fakeDb),
  query: {},
};

class FakeAppRepository {
  constructor(_db: unknown) {}
  async register(input: Record<string, unknown>) {
    state.registered = input;
    return state.app;
  }
  async get(_id: string) {
    return state.app;
  }
  async getByPublicId(publicId: string) {
    if (publicId !== state.app.publicId) return null;
    return { app: state.app, lastUsedAt: null, grants: [] };
  }
  async listForOwner(_owner: string) {
    return [{ app: state.app, lastUsedAt: null, grants: [] }];
  }
  async getForOwner(_id: string, _owner: string) {
    return { app: state.app, lastUsedAt: null, grants: [] };
  }
  async keyIdsFor(_publicId: string) {
    return state.existingKeyIds;
  }
  async setApprovedRequests(appId: string, requests: unknown) {
    state.approvedWrites.push({ appId, requests });
    return state.app;
  }
  async revoke(_id: string) {
    return state.app;
  }
}

class FakeApiKeyRepository {
  constructor(_db: unknown, _events: unknown) {}
  async create(input: Record<string, unknown>, _userId: string) {
    state.keyInput = input;
    return { id: "key-0001" };
  }
}

/** The ONE grant write door — the cascade a rotate/revoke owes. */
class FakeGrantRepository {
  constructor(_db: unknown) {}
  async revokeForKeys(apiKeyIds: string[], _revokedBy: string | null) {
    state.revokedGrantKeyIdCalls.push(apiKeyIds);
    return apiKeyIds.length;
  }
}

class FakeEventRepository {
  constructor(_sql: unknown) {}
}

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: fakeDb,
    AppRepository: FakeAppRepository,
    ApiKeyRepository: FakeApiKeyRepository,
    GrantRepository: FakeGrantRepository,
    EventRepository: FakeEventRepository,
  };
});

vi.mock("@synap/database/api-key-revocation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@synap/database/api-key-revocation")>();
  return {
    ...actual,
    revokeApiKeys: async (_db: unknown, params: Record<string, unknown>) => {
      state.revokedKeyCalls.push(params);
      return [];
    },
  };
});

vi.mock("../../../../utils/permission-check.js", () => ({
  createPendingProposal: async (input: Record<string, unknown>) => {
    state.proposalInput = input;
    return { id: PROPOSAL_ID };
  },
}));

vi.mock("../../../../services/key-grant.js", () => ({
  attachGrantsOrRevoke: async (args: Record<string, unknown>) => {
    state.grantArgs = args;
  },
}));

vi.mock("../_shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../_shared.js")>();
  return {
    ...actual,
    getUserAccessibleWorkspaceIds: async (_userId: string) =>
      state.workspaceIds,
  };
});

const { registerAppsRoutes } = await import("../apps.js");
const { registerAppExecutors } =
  await import("../../../proposals/executors/app.js");
const { proposalExecRegistry } =
  await import("../../../proposals/execution-registry.js");

function makeApp_(vars: Record<string, unknown>) {
  const app = new OpenAPIHono();
  app.use("*", async (c, next) => {
    for (const [k, v] of Object.entries(vars)) {
      if (v !== undefined) c.set(k as never, v as never);
    }
    await next();
  });
  registerAppsRoutes(app as never);
  return app;
}

const WRITE = ["hub-protocol.write"];

const post = (app: OpenAPIHono, path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });

beforeEach(() => {
  state.app = makeApp();
  state.registered = null;
  state.proposalInput = null;
  state.grantArgs = null;
  state.keyInput = null;
  state.revokedKeyCalls = [];
  state.revokedGrantKeyIdCalls = [];
  state.approvedWrites = [];
  state.existingKeyIds = [];
  state.workspaceIds = [WORKSPACE_ID];
  state.selectResult = [{ id: WORKSPACE_ID, name: "Operations" }];
});

describe("POST /apps — register", () => {
  it("returns the app with a snake_case public_id (the CLI reads it)", async () => {
    const app = makeApp_({ scopes: WRITE, userId: OWNER });
    const res = await post(app, "/apps", {
      name: "synap.live",
      mode: "specific",
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { app: Record<string, unknown> };
    expect(json.app.public_id).toBe(PUBLIC_ID);
    expect(json.app.id).toBe(APP_UUID);
    expect(state.registered).toMatchObject({
      ownerUserId: OWNER,
      name: "synap.live",
      mode: "specific",
    });
  });
});

describe("POST /apps/:id/connect — always files one proposal", () => {
  it("resolves the workspace NAME and files app/connect", async () => {
    const app = makeApp_({ scopes: WRITE, userId: OWNER });
    const res = await post(app, `/apps/${PUBLIC_ID}/connect`, {
      requests: [
        { permission: "entity.person.create", workspace: "Operations" },
      ],
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      proposalId: string;
      reviewUrl: string;
    };
    expect(json.proposalId).toBe(PROPOSAL_ID);
    expect(typeof json.reviewUrl).toBe("string");
    expect(state.proposalInput).toMatchObject({
      targetType: "app",
      proposalType: "connect",
      workspaceId: null,
    });
    expect((state.proposalInput!.data as any).requests).toEqual([
      { permission: "entity.person.create", workspaceId: WORKSPACE_ID },
    ]);
  });

  it("fails loud on an unknown workspace name", async () => {
    const app = makeApp_({ scopes: WRITE, userId: OWNER });
    const res = await post(app, `/apps/${PUBLIC_ID}/connect`, {
      requests: [{ permission: "entity.person.create", workspace: "Nope" }],
    });
    expect(res.status).toBe(400);
    expect(state.proposalInput).toBeNull();
  });
});

describe("POST /apps/:id/key — mint after approval", () => {
  it("NEGATIVE CONTROL: refuses a caller who is NOT the app's owner", async () => {
    state.app = makeApp({
      approvedRequests: [
        { permission: "entity.person.create", workspaceId: WORKSPACE_ID },
      ],
    });
    const app = makeApp_({ scopes: WRITE, userId: OTHER });

    const res = await post(app, `/apps/${PUBLIC_ID}/key`, {});

    expect(res.status).toBe(404);
    // Nothing minted, nothing granted, nothing rotated.
    expect(state.keyInput).toBeNull();
    expect(state.grantArgs).toBeNull();
    expect(state.revokedKeyCalls).toHaveLength(0);
  });

  it("mints for the owner with the approved reach and client_id = public_id", async () => {
    state.app = makeApp({
      approvedRequests: [
        { permission: "entity.person.create", workspaceId: WORKSPACE_ID },
      ],
    });
    state.existingKeyIds = ["old-key-1"];
    const app = makeApp_({ scopes: WRITE, userId: OWNER });

    const res = await post(app, `/apps/${PUBLIC_ID}/key`, {});

    expect(res.status).toBe(200);
    const json = (await res.json()) as { apiKey: string; keyId: string };
    expect(typeof json.apiKey).toBe("string");
    expect(json.apiKey.length).toBeGreaterThan(10);
    expect(json.keyId).toBe("key-0001");
    // Rotated the app's existing key first.
    expect(state.revokedKeyCalls).toHaveLength(1);
    // …AND revoked that key's grant at the ONE grant write door, so the
    // superseded key can never leave an active grant behind.
    expect(state.revokedGrantKeyIdCalls).toEqual([["old-key-1"]]);
    // Granted exactly the approved reach, tagged with the app's public id.
    expect(state.grantArgs).toMatchObject({
      clientId: PUBLIC_ID,
      onBehalfOf: OWNER,
      principalUserId: OWNER,
      grants: [
        {
          permissions: ["entity.person.create"],
          workspaceIds: [WORKSPACE_ID],
        },
      ],
    });
  });

  it("refuses when nothing is approved yet — no key, no grant", async () => {
    state.app = makeApp({ approvedRequests: null });
    const app = makeApp_({ scopes: WRITE, userId: OWNER });

    const res = await post(app, `/apps/${PUBLIC_ID}/key`, {});

    expect(res.status).toBe(409);
    expect(state.keyInput).toBeNull();
    expect(state.grantArgs).toBeNull();
  });

  it("refuses an agent credential outright", async () => {
    state.app = makeApp({
      approvedRequests: [
        { permission: "entity.person.create", workspaceId: WORKSPACE_ID },
      ],
    });
    const app = makeApp_({ scopes: WRITE, userId: OWNER, agentUserId: AGENT });

    const res = await post(app, `/apps/${PUBLIC_ID}/key`, {});

    expect(res.status).toBe(403);
    expect(state.keyInput).toBeNull();
  });
});

describe("DELETE /apps/:id — revoke cascades the keys' grants", () => {
  it("revokes the app's grants, then its keys, then soft-deletes the app", async () => {
    state.app = makeApp();
    state.existingKeyIds = ["old-key-1", "old-key-2"];
    const app = makeApp_({ scopes: WRITE, userId: OWNER });

    const res = await app.request(`/apps/${PUBLIC_ID}`, { method: "DELETE" });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { revoked: boolean; public_id: string };
    expect(json).toMatchObject({ revoked: true, public_id: PUBLIC_ID });
    // The app's grants are revoked at the ONE grant write door…
    expect(state.revokedGrantKeyIdCalls).toEqual([
      ["old-key-1", "old-key-2"],
    ]);
    // …and the keys themselves.
    expect(state.revokedKeyCalls).toHaveLength(1);
  });

  it("NEGATIVE CONTROL: a non-owner revokes nothing — no grant, no key", async () => {
    state.app = makeApp();
    state.existingKeyIds = ["old-key-1"];
    const app = makeApp_({ scopes: WRITE, userId: OTHER });

    const res = await app.request(`/apps/${PUBLIC_ID}`, { method: "DELETE" });

    expect(res.status).toBe(404);
    expect(state.revokedGrantKeyIdCalls).toHaveLength(0);
    expect(state.revokedKeyCalls).toHaveLength(0);
  });
});

describe("approve executor — app/connect writes approved_requests", () => {
  it("records the approved requests and writes NOTHING else (no key)", async () => {
    registerAppExecutors();
    const executor = proposalExecRegistry.resolveExact("app/connect");
    expect(executor).toBeDefined();

    state.selectResult = []; // no already-approved row
    const result = await executor!.execute({
      proposal: {
        id: PROPOSAL_ID,
        targetType: "app",
        targetId: APP_UUID,
        proposalType: "connect",
        workspaceId: null,
        sessionId: null,
        projectId: null,
        agentUserId: null,
        sourceMessageId: null,
        data: {
          appId: APP_UUID,
          publicId: PUBLIC_ID,
          name: "synap.live",
          requests: [
            { permission: "entity.person.create", workspaceId: WORKSPACE_ID },
          ],
        },
      },
      payload: null,
      userId: OWNER,
      input: { proposalId: PROPOSAL_ID },
      ctx: {} as never,
      deps: {
        emitProposalReviewed: () => {},
        reportProposalOutcome: () => {},
      } as never,
    });

    expect(result.success).toBe(true);
    expect(state.approvedWrites).toEqual([
      {
        appId: APP_UUID,
        requests: [
          { permission: "entity.person.create", workspaceId: WORKSPACE_ID },
        ],
      },
    ]);
    // The executor mints NOTHING — the key is a separate, human-driven door.
    expect(state.keyInput).toBeNull();
    expect(state.grantArgs).toBeNull();
  });

  it("refuses approval from someone who is not the app's owner", async () => {
    registerAppExecutors();
    const executor = proposalExecRegistry.resolveExact("app/connect")!;
    state.selectResult = [];

    await expect(
      executor.execute({
        proposal: {
          id: PROPOSAL_ID,
          targetType: "app",
          targetId: APP_UUID,
          proposalType: "connect",
          workspaceId: null,
          sessionId: null,
          projectId: null,
          agentUserId: null,
          sourceMessageId: null,
          data: {
            appId: APP_UUID,
            publicId: PUBLIC_ID,
            name: "synap.live",
            requests: [
              { permission: "entity.person.create", workspaceId: WORKSPACE_ID },
            ],
          },
        },
        payload: null,
        userId: OTHER,
        input: { proposalId: PROPOSAL_ID },
        ctx: {} as never,
        deps: {
          emitProposalReviewed: () => {},
          reportProposalOutcome: () => {},
        } as never,
      })
    ).rejects.toThrow(/owner/i);
    expect(state.approvedWrites).toHaveLength(0);
  });
});
