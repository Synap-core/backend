/**
 * One-click approval (V1 D5): `POST /setup/agent/pending/approve-batch` and
 * `/lookup`, driven through the REAL routes. `synap init` mints one pending
 * key per harness and opens ONE page; the signed-in person approves them all.
 *
 * What is pinned, per key: the SAME gate as the single approve (the key's
 * linked human or a pod admin), no resurrection of a rejected key, and a
 * per-key outcome — partial success is normal. The positive control (the
 * person's own pending key flips) is what makes the refusals meaningful.
 *
 * Mocked: the Kratos session, the pod-admin check, and the db rows.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const HUMAN = "0aaaaaaa-0000-4000-8000-000000000001";
const OTHER = "0bbbbbbb-0000-4000-8000-000000000002";
const K_MINE = "1aaaaaaa-0000-4000-8000-000000000001";
const K_OTHER = "1bbbbbbb-0000-4000-8000-000000000002";
const K_REJECTED = "1ccccccc-0000-4000-8000-000000000003";
const K_ACTIVE = "1ddddddd-0000-4000-8000-000000000004";
const K_MISSING = "1eeeeeee-0000-4000-8000-000000000005";

const getSession = vi.fn();
const assertPodAdmin = vi.fn();
const findUser = vi.fn();
const findKey = vi.fn();
const flipped: string[] = [];

type KeyRow = {
  id: string;
  isActive: boolean;
  revokedAt: Date | null;
  linkedUserId: string | null;
};
const KEYS: Record<string, KeyRow> = {
  [K_MINE]: {
    id: K_MINE,
    isActive: false,
    revokedAt: null,
    linkedUserId: HUMAN,
  },
  [K_OTHER]: {
    id: K_OTHER,
    isActive: false,
    revokedAt: null,
    linkedUserId: OTHER,
  },
  [K_REJECTED]: {
    id: K_REJECTED,
    isActive: false,
    revokedAt: new Date(),
    linkedUserId: HUMAN,
  },
  [K_ACTIVE]: {
    id: K_ACTIVE,
    isActive: true,
    revokedAt: null,
    linkedUserId: HUMAN,
  },
};

vi.mock("@synap/auth", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getSession };
});

vi.mock("../../../trpc.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, assertPodAdmin };
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  // The update is keyed by the id bound in its WHERE; the test tracks which
  // ids the route tried to flip via the key lookup that preceded it.
  let lastLookedUp: string | null = null;
  return {
    ...actual,
    db: {
      query: {
        users: { findFirst: findUser },
        apiKeys: {
          findFirst: vi.fn(async () => {
            const row = findKey();
            lastLookedUp = row?.id ?? null;
            return row;
          }),
        },
      },
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => {
              if (!lastLookedUp) return [];
              flipped.push(lastLookedUp);
              return [{ id: lastLookedUp }];
            },
          }),
        }),
      }),
    },
  };
});

const { registerSetupRoutes } = await import("./setup.js");

function makeApp() {
  const app = new OpenAPIHono();
  registerSetupRoutes(app as never);
  return app;
}

const post = (path: string, body: unknown, cookie = "ory_session=x") =>
  makeApp().request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  flipped.length = 0;
  for (const m of [getSession, assertPodAdmin, findUser, findKey])
    m.mockReset();
  getSession.mockResolvedValue({ identity: { id: "kratos-human" } });
  findUser.mockResolvedValue({ id: HUMAN });
  // Not a pod admin: only the keys linked to HUMAN are theirs to decide.
  assertPodAdmin.mockRejectedValue(new Error("FORBIDDEN"));
});

describe("POST /setup/agent/pending/approve-batch", () => {
  it("approves the person's own pending keys and reports every other key honestly", async () => {
    const order = [K_MINE, K_OTHER, K_REJECTED, K_ACTIVE, K_MISSING];
    for (const id of order) findKey.mockReturnValueOnce(KEYS[id]);

    const res = await post("/setup/agent/pending/approve-batch", {
      keyIds: order,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      approved: 1,
      results: [
        { keyId: K_MINE, outcome: "approved" },
        { keyId: K_OTHER, outcome: "forbidden" },
        { keyId: K_REJECTED, outcome: "rejected" },
        { keyId: K_ACTIVE, outcome: "already_active" },
        { keyId: K_MISSING, outcome: "not_found" },
      ],
    });
    // Positive control + the floor: exactly the person's own pending key flipped.
    expect(flipped).toEqual([K_MINE]);
  });

  it("a pod admin may decide another person's pending key (same gate as the single approve)", async () => {
    assertPodAdmin.mockResolvedValue(undefined);
    findKey.mockReturnValueOnce(KEYS[K_OTHER]);
    const res = await post("/setup/agent/pending/approve-batch", {
      keyIds: [K_OTHER],
    });
    expect(await res.json()).toMatchObject({ approved: 1 });
    expect(flipped).toEqual([K_OTHER]);
  });

  it("no Kratos session → 401, nothing read or flipped", async () => {
    getSession.mockResolvedValue(null);
    const res = await post("/setup/agent/pending/approve-batch", {
      keyIds: [K_MINE],
    });
    expect(res.status).toBe(401);
    expect(findKey).not.toHaveBeenCalled();
    expect(flipped).toEqual([]);
  });

  it("a malformed body is a 400 (non-uuid ids, empty list, over the cap)", async () => {
    for (const keyIds of [
      ["nope"],
      [],
      Array.from({ length: 21 }, () => K_MINE),
    ]) {
      const res = await post("/setup/agent/pending/approve-batch", { keyIds });
      expect(res.status).toBe(400);
    }
    expect(flipped).toEqual([]);
  });
});

describe("POST /setup/agent/pending/lookup", () => {
  it("no Kratos session → 401 (the per-key describe gate is NOT covered here)", async () => {
    getSession.mockResolvedValue(null);
    const res = await post("/setup/agent/pending/lookup", { keyIds: [K_MINE] });
    expect(res.status).toBe(401);
  });
});
