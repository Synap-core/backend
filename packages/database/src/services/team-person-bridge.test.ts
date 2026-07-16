import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const userFind = vi.fn();
  const workspaceMemberFind = vi.fn();
  return {
    userFind,
    workspaceMemberFind,
    resolveIdentity: vi.fn(),
  };
});

vi.mock("@synap-core/core", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("./identity-resolution-service.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./identity-resolution-service.js")>();
  return {
    ...actual,
    resolveIdentity: mocks.resolveIdentity,
    registerIdentitySignals: vi.fn(),
  };
});

import {
  userExternalIdSignal,
  detachTeamMemberFacet,
} from "./team-person-bridge.js";

function makeDb() {
  return {
    query: {
      users: { findFirst: mocks.userFind },
      workspaceMembers: { findFirst: mocks.workspaceMemberFind },
    },
    select: vi.fn(),
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.workspaceMemberFind.mockResolvedValue(null);
  mocks.resolveIdentity.mockResolvedValue({
    match: null,
    candidates: [],
  });
});

describe("userExternalIdSignal", () => {
  it("prefixes the user id with user:", () => {
    expect(userExternalIdSignal("abc-123")).toBe("user:abc-123");
  });

  it("is stable for empty string (caller responsibility to validate)", () => {
    expect(userExternalIdSignal("")).toBe("user:");
  });
});

describe("detachTeamMemberFacet", () => {
  it("returns user_not_found when member is missing", async () => {
    mocks.userFind.mockResolvedValue(undefined);

    const result = await detachTeamMemberFacet(makeDb(), {
      memberUserId: "missing-user",
      workspaceId: "ws-1",
      ownerUserId: "owner-1",
    });

    expect(result).toEqual({
      detached: false,
      entityId: null,
      reason: "user_not_found",
    });
    expect(mocks.resolveIdentity).not.toHaveBeenCalled();
  });

  it("skips agents", async () => {
    mocks.userFind.mockResolvedValue({
      id: "agent-1",
      email: "agent@example.com",
      name: "Bot",
      userType: "agent",
    });

    const result = await detachTeamMemberFacet(makeDb(), {
      memberUserId: "agent-1",
      workspaceId: "ws-1",
      ownerUserId: "owner-1",
    });

    expect(result).toEqual({
      detached: false,
      entityId: null,
      reason: "agent",
    });
    expect(mocks.resolveIdentity).not.toHaveBeenCalled();
  });

  it("returns no_person when identity resolve finds no person", async () => {
    mocks.userFind.mockResolvedValue({
      id: "user-1",
      email: "alice@example.com",
      name: "Alice",
      userType: "human",
    });
    mocks.workspaceMemberFind.mockResolvedValue({ userId: "owner-1" });
    mocks.resolveIdentity.mockResolvedValue({
      match: null,
      candidates: [],
    });

    const result = await detachTeamMemberFacet(makeDb(), {
      memberUserId: "user-1",
      workspaceId: "ws-1",
      ownerUserId: "owner-1",
    });

    expect(result).toEqual({
      detached: false,
      entityId: null,
      reason: "no_person",
    });
    expect(mocks.resolveIdentity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: "owner-1",
        kindSlug: "person",
        signals: expect.arrayContaining([
          { type: "external_id", value: "user:user-1" },
          { type: "email", value: "alice@example.com" },
        ]),
      })
    );
  });

  it("never throws on unexpected errors", async () => {
    mocks.userFind.mockRejectedValue(new Error("db down"));

    const result = await detachTeamMemberFacet(makeDb(), {
      memberUserId: "user-1",
      workspaceId: "ws-1",
      ownerUserId: "owner-1",
    });

    expect(result).toEqual({
      detached: false,
      entityId: null,
      reason: "error",
    });
  });
});
