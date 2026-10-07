/**
 * `GET /setup/agent/pending/:keyId/details` — what the approval page shows.
 * The person approves the key's REAL scopes and grant (pod-admin used to show
 * a hard-coded list). Same caller rule as approve/reject: the key's linked
 * human or a pod admin. Mocked: the Kratos session, the pod-admin check, the
 * key row and its grant.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const HUMAN = "0aaaaaaa-0000-4000-8000-000000000001";
const OTHER = "0bbbbbbb-0000-4000-8000-000000000002";
const KEY = "1aaaaaaa-0000-4000-8000-000000000001";

const getSession = vi.fn();
const assertPodAdmin = vi.fn();
const findUser = vi.fn();
const findKey = vi.fn();
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
  expiresAt: null,
  revokedAt: null,
  linkedUserId,
});

beforeEach(() => {
  for (const m of [
    getSession,
    assertPodAdmin,
    findUser,
    findKey,
    resolveForKey,
  ])
    m.mockReset();
  getSession.mockResolvedValue({ identity: { id: "kratos-human" } });
  findUser.mockResolvedValue({ id: HUMAN });
  assertPodAdmin.mockRejectedValue(new Error("FORBIDDEN"));
});

describe("GET /setup/agent/pending/:keyId/details", () => {
  it("returns the key's real scopes and grant to its linked human", async () => {
    findKey.mockReturnValue(row(HUMAN));
    resolveForKey.mockResolvedValue({
      scopes: [
        {
          permissions: ["entity.note.create"],
          workspaceIds: null,
          projectIds: null,
          entityIds: null,
        },
      ],
      clientId: null,
    });
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      keyName: "raycast",
      scopes: ["hub-protocol.read", "mcp.read"],
      grant: { permissions: ["entity.note.create"] },
    });
  });

  it("an ungranted key says grant: null (never a made-up list)", async () => {
    findKey.mockReturnValue(row(HUMAN));
    resolveForKey.mockResolvedValue(null);
    expect((await (await get()).json()).grant).toBeNull();
  });

  it("refuses someone else's pending key, and a caller with no session", async () => {
    findKey.mockReturnValue(row(OTHER));
    expect((await get()).status).toBe(403);
    getSession.mockResolvedValue(null);
    expect((await get(null)).status).toBe(401);
  });
});
