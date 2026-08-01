/**
 * Phase 3A — Realtime auth handshake regression tests
 *
 * Covers the auth middleware on the `/presence` namespace introduced in
 * Phase 3A of the Eve OS vision (extending the userId-only handshake to
 * also accept a service-account API key with `realtime:observe`).
 *
 * Strategy: unit-test the auth resolution + room-join logic in isolation.
 * We don't spin up a real socket.io server here (the integration test
 * file does that). These are fast, hermetic checks that the auth contract
 * holds for both paths.
 *
 * The DB layer is mocked. The point of these tests is the BRANCH coverage:
 *   • userId path still works → existing behaviour preserved
 *   • apiKey path with valid key + correct scope → authenticated
 *   • apiKey path with invalid key → rejected
 *   • apiKey path with insufficient scope → rejected
 *   • Joining a workspace room as a service account works
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock the DB layer the validator imports ────────────────────────────────
const mockSelect = vi.fn();

vi.mock("@synap/database", () => ({
  db: {
    select: () => ({ from: () => ({ where: mockSelect }) }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  },
  and: (...args: unknown[]) => args,
  eq: (...args: unknown[]) => args,
  or: (...args: unknown[]) => args,
  isNull: (...args: unknown[]) => args,
  gt: (...args: unknown[]) => args,
}));

vi.mock("@synap/database/schema", () => ({
  apiKeys: {
    keyPrefix: "key_prefix",
    isActive: "is_active",
    expiresAt: "expires_at",
    keyHash: "key_hash",
    id: "id",
    scope: "scope",
    lastUsedAt: "last_used_at",
  },
}));

// bcrypt — we control the compare() return value per test
vi.mock("bcrypt", () => ({
  default: {
    compare: vi.fn(),
  },
}));

import bcrypt from "bcrypt";
import { validateRealtimeApiKey } from "../api-key-auth.js";

describe("validateRealtimeApiKey — Phase 3A handshake", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelect.mockReset();
  });

  it("rejects empty / non-string keys without touching the DB", async () => {
    const r1 = await validateRealtimeApiKey("");
    const r2 = await validateRealtimeApiKey(null as unknown as string);

    expect(r1).toBeNull();
    expect(r2).toBeNull();
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it("rejects keys with an unrecognised prefix", async () => {
    const result = await validateRealtimeApiKey("foo_bar_definitely_not_synap");
    expect(result).toBeNull();
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it("rejects when no candidate row exists", async () => {
    mockSelect.mockResolvedValueOnce([]);

    const result = await validateRealtimeApiKey("synap_user_abc");
    expect(result).toBeNull();
  });

  it("rejects when bcrypt compare fails for every candidate", async () => {
    mockSelect.mockResolvedValueOnce([
      {
        id: "k1",
        userId: "u1",
        keyHash: "h1",
        keyName: "k",
        scope: ["realtime:observe"],
      },
    ]);
    vi.mocked(bcrypt.compare).mockResolvedValueOnce(false as never);

    const result = await validateRealtimeApiKey("synap_user_abc");
    expect(result).toBeNull();
  });

  it("rejects a hash-matching key that lacks the realtime:observe scope", async () => {
    mockSelect.mockResolvedValueOnce([
      {
        id: "k2",
        userId: "u2",
        keyHash: "h2",
        keyName: "no-scope-key",
        scope: ["hub-protocol.read"], // missing realtime:observe
      },
    ]);
    vi.mocked(bcrypt.compare).mockResolvedValueOnce(true as never);

    const result = await validateRealtimeApiKey("synap_user_xyz");
    expect(result).toBeNull();
  });

  it("accepts a hash-matching key with realtime:observe scope", async () => {
    mockSelect.mockResolvedValueOnce([
      {
        id: "k3",
        userId: "agent-eve-uuid",
        keyHash: "h3",
        keyName: "Eve Hub Key",
        scope: ["hub-protocol.read", "realtime:observe"],
      },
    ]);
    vi.mocked(bcrypt.compare).mockResolvedValueOnce(true as never);

    const result = await validateRealtimeApiKey("synap_hub_live_xxx");

    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      apiKeyId: "k3",
      userId: "agent-eve-uuid",
      keyName: "Eve Hub Key",
      scopes: ["hub-protocol.read", "realtime:observe"],
    });
  });

  it("only bcrypt-compares against candidates with the matching prefix", async () => {
    // Single candidate but a longer scope list — verifies we read scopes
    // straight off the row and don't filter them
    mockSelect.mockResolvedValueOnce([
      {
        id: "k4",
        userId: "u4",
        keyHash: "h4",
        keyName: "k",
        scope: ["realtime:observe", "mcp.read"],
      },
    ]);
    vi.mocked(bcrypt.compare).mockResolvedValueOnce(true as never);

    const result = await validateRealtimeApiKey("synap_user_xyz");
    expect(result?.scopes).toContain("mcp.read");
    expect(bcrypt.compare).toHaveBeenCalledTimes(1);
  });
});

// ─── Handshake middleware — the userId path stays intact ────────────────────
//
// The middleware itself is inline in server.ts. We validate the contract
// at the spec level (rather than re-importing the full server with all its
// side effects).
//
// The contract under test:
//   • `userId` only → principal.kind === "user", principal.userId === userId
//   • `apiKey` only (valid + scoped) → principal.kind === "service",
//     principal.userId from the resolved row
//   • Neither → next() called with an Error
//   • Both    → apiKey wins (deterministic — no ambiguity for callers)
//
// We replicate the middleware logic here as a pure function so the test is
// hermetic and doesn't have to spin up Socket.IO.

type Principal =
  | { kind: "user"; userId: string }
  | {
      kind: "service";
      userId: string;
      apiKeyId: string;
      keyName: string;
      scopes: string[];
    };

async function resolveHandshakePrincipal(
  auth: Record<string, unknown>,
  validate: typeof validateRealtimeApiKey
): Promise<Principal | { error: string }> {
  const apiKey = typeof auth.apiKey === "string" ? auth.apiKey : null;
  const userId = typeof auth.userId === "string" ? auth.userId : null;

  if (apiKey) {
    const validated = await validate(apiKey);
    if (!validated) return { error: "Realtime auth: invalid api key" };
    return {
      kind: "service",
      userId: validated.userId,
      apiKeyId: validated.apiKeyId,
      keyName: validated.keyName,
      scopes: validated.scopes,
    };
  }

  if (userId) return { kind: "user", userId };

  return { error: "Realtime auth: missing userId or apiKey" };
}

describe("Handshake principal resolution — Phase 3A", () => {
  it("regression: userId-only handshake still works (unchanged contract)", async () => {
    const validate = vi.fn();
    const result = await resolveHandshakePrincipal(
      { userId: "user-123", userName: "Alice" },
      validate as unknown as typeof validateRealtimeApiKey
    );

    expect(result).toEqual({ kind: "user", userId: "user-123" });
    expect(validate).not.toHaveBeenCalled();
  });

  it("apiKey path with a valid key resolves to a service principal", async () => {
    const validate = vi.fn().mockResolvedValueOnce({
      apiKeyId: "k-eve",
      userId: "agent-eve",
      keyName: "Eve Hub Key",
      scopes: ["realtime:observe"],
    });

    const result = await resolveHandshakePrincipal(
      { apiKey: "synap_hub_live_xxx" },
      validate as unknown as typeof validateRealtimeApiKey
    );

    expect(result).toMatchObject({
      kind: "service",
      userId: "agent-eve",
      apiKeyId: "k-eve",
      keyName: "Eve Hub Key",
    });
  });

  it("apiKey path with an invalid key returns an error — handshake rejected", async () => {
    const validate = vi.fn().mockResolvedValueOnce(null);

    const result = await resolveHandshakePrincipal(
      { apiKey: "synap_hub_live_bogus" },
      validate as unknown as typeof validateRealtimeApiKey
    );

    expect(result).toEqual({ error: "Realtime auth: invalid api key" });
  });

  it("missing both userId and apiKey is rejected", async () => {
    const validate = vi.fn();
    const result = await resolveHandshakePrincipal(
      { workspaceId: "ws-1" },
      validate as unknown as typeof validateRealtimeApiKey
    );

    expect(result).toEqual({
      error: "Realtime auth: missing userId or apiKey",
    });
  });

  it("when both userId and apiKey are sent, apiKey wins (deterministic)", async () => {
    const validate = vi.fn().mockResolvedValueOnce({
      apiKeyId: "k-1",
      userId: "agent-eve",
      keyName: "Eve",
      scopes: ["realtime:observe"],
    });

    const result = await resolveHandshakePrincipal(
      { userId: "user-pretender", apiKey: "synap_user_legit" },
      validate as unknown as typeof validateRealtimeApiKey
    );

    // Service path took precedence — userId was ignored
    expect(result).toMatchObject({ kind: "service", userId: "agent-eve" });
  });
});

// ─── Workspace-room subscription as a service account ───────────────────────
//
// The real socket.join is called inside the connection handler in server.ts.
// Here we model the room-resolution logic in isolation:
//   • effectiveViewId = viewId ?? (workspaceId ? `workspace:${workspaceId}` : null)
//   • Always join `view:${effectiveViewId}`
//   • If workspaceId provided, also join `workspace:${workspaceId}` — the
//     room the bridge fans events into. Service accounts MUST be able to
//     join this for Phase 3A to work.
//   • Always join `user:${userId}` — bridge per-user emits

// ⚠️ REPLICA of the join logic in `server.ts`'s connection handler — it is not
// imported, so it can DRIFT. It already did: this helper kept returning `[]` for
// a workspace-less socket (asserting a disconnect branch that no longer exists)
// and the suite stayed green, catching nothing. If you change the join order or
// conditions in `server.ts`, change them here too, or extract the real function
// and import it.
function computeRoomsToJoin(args: {
  viewId: string | null;
  workspaceId: string | null;
  userId: string;
}): string[] {
  const effectiveViewId =
    args.viewId || (args.workspaceId ? `workspace:${args.workspaceId}` : null);

  // POD ALTITUDE: a socket with neither a view nor a workspace is no longer
  // disconnected. It is fully authenticated (Kratos token matched to auth.userId,
  // a check that never depended on a workspace) and holds its self-scoped room.
  const rooms = [`user:${args.userId}`];
  if (effectiveViewId) rooms.push(`view:${effectiveViewId}`);
  if (args.workspaceId) rooms.push(`workspace:${args.workspaceId}`);
  return rooms;
}

describe("Service-account room joins — Phase 3A", () => {
  it("a service account joining with workspaceId joins the workspace room", () => {
    const rooms = computeRoomsToJoin({
      viewId: null,
      workspaceId: "ws-eve-observer",
      userId: "agent-eve",
    });

    // The CRITICAL room for Phase 3A: bridge events fan to workspace:${id}
    expect(rooms).toContain("workspace:ws-eve-observer");
    expect(rooms).toContain("view:workspace:ws-eve-observer");
    expect(rooms).toContain("user:agent-eve");
  });

  it("a socket with no workspaceId or viewId connects at POD ALTITUDE (not rejected)", () => {
    const rooms = computeRoomsToJoin({
      viewId: null,
      workspaceId: null,
      userId: "agent-eve",
    });
    // Regression guard for the production defect: the Browser boots with no
    // active Space (SynapProvider clears the remembered workspace on first
    // membership resolution), so this is the FIRST connect for every user. It
    // used to hit a disconnect branch, so realtime never established until the
    // user entered a Space. It must now hold the connection.
    expect(rooms).toEqual(["user:agent-eve"]);
    expect(rooms).not.toEqual([]);
    // Pod-wide events reach this socket via `user:` — there is deliberately no
    // separate `pod:` room (it would hold the same single principal, have no
    // producer, and cost a pod_members lookup per connection).
    expect(rooms.some((r) => r.startsWith("pod:"))).toBe(false);
  });

  it("a service account with only viewId joins that view room (not workspace)", () => {
    const rooms = computeRoomsToJoin({
      viewId: "view-special",
      workspaceId: null,
      userId: "agent-eve",
    });

    expect(rooms).toContain("view:view-special");
    expect(rooms).not.toContain("workspace:view-special");
    expect(rooms).toContain("user:agent-eve");
  });
});
