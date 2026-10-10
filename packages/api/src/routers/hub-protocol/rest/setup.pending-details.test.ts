/**
 * What the approval pages show: `GET /setup/agent/pending/:keyId/details`
 * (one key) and `POST /setup/agent/pending/lookup` (the `synap init` batch).
 * The person approves the key's REAL scopes, EVERY live grant scope and its
 * expiry (pod-admin used to show a hard-coded list). Same caller rule as
 * approve/reject: the key's linked human or a pod admin. Also: the legacy
 * `/review` HTML page now forwards to pod-admin. Mocked: the Kratos session,
 * the pod-admin check, the key rows and their grants.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const HUMAN = "0aaaaaaa-0000-4000-8000-000000000001";
const OTHER = "0bbbbbbb-0000-4000-8000-000000000002";
const KEY = "1aaaaaaa-0000-4000-8000-000000000001";
const OTHER_KEY = "1bbbbbbb-0000-4000-8000-000000000002";

const getSession = vi.fn();
const assertPodAdmin = vi.fn();
const findUser = vi.fn();
const findKey = vi.fn();
const selectKeys = vi.fn();
const resolveForKey = vi.fn();

vi.mock("@synap/auth", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSession,
}));
vi.mock("../../../trpc.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertPodAdmin,
}));
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    GrantRepository: class {
      resolveForKey = resolveForKey;
    },
    db: {
      query: {
        users: { findFirst: findUser },
        apiKeys: { findFirst: vi.fn(async () => findKey()) },
      },
      select: () => ({
        from: () => ({
          leftJoin: () => ({ where: async () => selectKeys() }),
        }),
      }),
    },
  };
});

const { registerSetupRoutes } = await import("./setup.js");

const get = (cookie: string | null = "ory_session=x") => {
  const app = new OpenAPIHono();
  registerSetupRoutes(app as never);
  return app.request(`/setup/agent/pending/${KEY}/details`, {
    headers: cookie ? { cookie } : {},
  });
};

const row = (linkedUserId: string) => ({
  id: KEY,
  keyName: "raycast",
  scope: ["hub-protocol.read", "mcp.read"],
  expiresAt: EXPIRES,
  revokedAt: null,
  linkedUserId,
});

const EXPIRES = new Date("2027-01-12T00:00:00.000Z");
const TWO_SCOPES = {
  scopes: [
    {
      permissions: ["entity.note.create"],
      workspaceIds: ["2aaaaaaa-0000-4000-8000-000000000001"],
      projectIds: null,
      entityIds: null,
    },
    { permissions: ["proposal"], workspaceIds: null },
  ],
  clientId: null,
};
const TWO_SCOPES_WIRE = [
  {
    permissions: ["entity.note.create"],
    workspaceIds: ["2aaaaaaa-0000-4000-8000-000000000001"],
    projectIds: null,
    entityIds: null,
  },
  {
    permissions: ["proposal"],
    workspaceIds: null,
    projectIds: null,
    entityIds: null,
  },
];

beforeEach(() => {
  for (const m of [
    getSession,
    assertPodAdmin,
    findUser,
    findKey,
    selectKeys,
    resolveForKey,
  ])
    m.mockReset();
  getSession.mockResolvedValue({ identity: { id: "kratos-human" } });
  findUser.mockResolvedValue({ id: HUMAN });
  assertPodAdmin.mockRejectedValue(new Error("FORBIDDEN"));
});

describe("GET /setup/agent/pending/:keyId/details", () => {
  it("returns the key's scopes, EVERY live grant scope and its expiry to its linked human", async () => {
    findKey.mockReturnValue(row(HUMAN));
    resolveForKey.mockResolvedValue(TWO_SCOPES);
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      keyName: "raycast",
      scopes: ["hub-protocol.read", "mcp.read"],
      expiresAt: EXPIRES.toISOString(),
      grants: TWO_SCOPES_WIRE,
    });
    expect(resolveForKey).toHaveBeenCalledWith(KEY);
  });

  it("an ungranted key says grants: null (never a made-up list)", async () => {
    findKey.mockReturnValue(row(HUMAN));
    resolveForKey.mockResolvedValue(null);
    expect((await (await get()).json()).grants).toBeNull();
  });

  it("someone else's pending key answers exactly like a missing one", async () => {
    findKey.mockReturnValue(row(OTHER));
    const theirs = await get();
    findKey.mockReturnValue(undefined);
    const missing = await get();
    expect(theirs.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await theirs.json()).toEqual(await missing.json());
    expect(resolveForKey).not.toHaveBeenCalled();
  });

  it("a pod admin may read another person's pending key", async () => {
    assertPodAdmin.mockResolvedValue(undefined);
    findKey.mockReturnValue(row(OTHER));
    resolveForKey.mockResolvedValue(null);
    expect((await get()).status).toBe(200);
  });

  it("no session → 401", async () => {
    getSession.mockResolvedValue(null);
    expect((await get(null)).status).toBe(401);
  });
});

const lookup = (keyIds: string[]) => {
  const app = new OpenAPIHono();
  registerSetupRoutes(app as never);
  return app.request("/setup/agent/pending/lookup", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: "ory_session=x" },
    body: JSON.stringify({ keyIds }),
  });
};

describe("POST /setup/agent/pending/lookup", () => {
  it("each decidable key carries its scopes, every live grant scope and its expiry", async () => {
    selectKeys.mockReturnValue([
      {
        ...row(HUMAN),
        isActive: false,
        instanceId: "laptop",
        agentType: "claude-code",
        agentName: "Claude Code",
      },
      {
        ...row(HUMAN),
        id: OTHER_KEY,
        isActive: false,
        instanceId: null,
        agentType: "codex",
        agentName: null,
      },
    ]);
    resolveForKey.mockImplementation(async (id: string) =>
      id === KEY ? TWO_SCOPES : null
    );
    const res = await lookup([KEY, OTHER_KEY]);
    expect(res.status).toBe(200);
    const { keys } = await res.json();
    expect(keys[0]).toMatchObject({
      keyId: KEY,
      status: "pending",
      scopes: ["hub-protocol.read", "mcp.read"],
      expiresAt: EXPIRES.toISOString(),
      grants: TWO_SCOPES_WIRE,
    });
    expect(keys[1]).toMatchObject({ keyId: OTHER_KEY, grants: null });
  });

  it("a key the caller may not decide carries no access facts", async () => {
    selectKeys.mockReturnValue([
      {
        ...row(OTHER),
        isActive: false,
        instanceId: null,
        agentType: null,
        agentName: null,
      },
    ]);
    const { keys } = await (await lookup([KEY])).json();
    expect(keys).toEqual([{ keyId: KEY, status: "forbidden" }]);
    expect(resolveForKey).not.toHaveBeenCalled();
  });
});

describe("GET /setup/agent/pending/:keyId/review", () => {
  it("forwards to the pod-admin approval page (no hard-coded scope list)", async () => {
    const prev = process.env.PUBLIC_URL;
    process.env.PUBLIC_URL = "https://pod.example.com";
    try {
      const app = new OpenAPIHono();
      registerSetupRoutes(app as never);
      const res = await app.request(
        `/setup/agent/pending/${KEY}/review?agentType=raycast`
      );
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(
        `https://pod-admin.example.com/approve-agent/${KEY}?agentType=raycast`
      );
    } finally {
      if (prev === undefined) delete process.env.PUBLIC_URL;
      else process.env.PUBLIC_URL = prev;
    }
  });
});
