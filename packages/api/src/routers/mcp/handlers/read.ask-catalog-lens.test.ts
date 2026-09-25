/**
 * synap_ask — catalog lens follows the query lens (DOOR PARITY regression).
 *
 * The type-inference catalog used to fetch from the caller's FIRST-membership
 * workspace (`wsIds[0]`, an unordered SELECT) whenever no `workspaceId` was
 * passed, and later from NO catalog at all — while the Hub door used the
 * pod-wide profile UNION. All doors now share `resolveKnowledgeLens`
 * (services/knowledge/resolve-lens.ts): catalog tracks the query lens, and
 * unscoped means the pod-wide union (`getAccessibleProfiles(userId, "")`).
 * Cross-door sameness is `__tripwires__/knowledge-lens-door-parity.test.ts`;
 * this file pins the MCP door's own branches.
 *
 * `ask`/`synthesizeAnswer`, the workspace floor and the profile repository are
 * mocked so this exercises the handler's own branching, not retrieval or the DB.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  askMock,
  synthesizeAnswerMock,
  getUserMemberWorkspaceIds,
  validateWorkspaceAccess,
  getAccessibleProfiles,
  listProfiles,
} = vi.hoisted(() => ({
  askMock: vi.fn(),
  synthesizeAnswerMock: vi.fn(),
  getUserMemberWorkspaceIds: vi.fn(),
  validateWorkspaceAccess: vi.fn(),
  getAccessibleProfiles: vi.fn(),
  listProfiles: vi.fn(),
}));

vi.mock("../../../services/knowledge/ask.js", () => ({
  ask: askMock,
}));

vi.mock("../../../services/knowledge/synthesize.js", () => ({
  synthesizeAnswer: synthesizeAnswerMock,
}));

vi.mock("../../hub-protocol/rest/_shared.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../hub-protocol/rest/_shared.js")
  >()),
  getUserMemberWorkspaceIds,
}));

vi.mock("../../../utils/workspace-membership.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../utils/workspace-membership.js")
  >()),
  validateWorkspaceAccess,
}));

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  getDb: async () => ({}),
  ProfileRepository: class {
    getAccessibleProfiles = getAccessibleProfiles;
  },
}));

import { readHandlers } from "./read.js";
import type { McpToolContext } from "./shared.js";

function makeCtx(overrides: Partial<McpToolContext> = {}): McpToolContext {
  return {
    toolName: "synap_ask",
    args: { query: "who is Alice" },
    userId: "user-1",
    apiKeyScopes: ["mcp.read"],
    caller: {
      profiles: { listProfiles },
    } as unknown as McpToolContext["caller"],
    lensCaller: {} as McpToolContext["lensCaller"],
    workspaceAccessible: false,
    ...overrides,
  };
}

describe("synap_ask — catalog lens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAccessibleProfiles.mockResolvedValue([]);
    askMock.mockResolvedValue({ answers: [], routedTo: [], pending: null });
    synthesizeAnswerMock.mockResolvedValue({ answer: "ok" });
    // Accessible by default; the leak case overrides this explicitly below.
    validateWorkspaceAccess.mockImplementation(
      async (_u: string, requested: string[]) =>
        requested.filter((id) => id === "ws-explicit")
    );
  });

  it("fetches the catalog from the EXPLICIT workspaceId (not membership[0])", async () => {
    await readHandlers.synap_ask!(
      makeCtx({ args: { query: "who is Alice", workspaceId: "ws-explicit" } })
    );

    expect(getAccessibleProfiles).toHaveBeenCalledWith("user-1", "ws-explicit");
    expect(getUserMemberWorkspaceIds).not.toHaveBeenCalled();
    // Retrieval must use the SAME lens the catalog was built from.
    expect(askMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-explicit" })
    );
  });

  it("stays pod-wide when unscoped: catalog = pod-wide UNION, no membership[0] fallback", async () => {
    getUserMemberWorkspaceIds.mockResolvedValue(["ws-other-1", "ws-other-2"]);
    getAccessibleProfiles.mockImplementation(async (_u: string, ws: string) =>
      ws === "" ? [{ slug: "client", displayName: "Client" }] : []
    );

    await readHandlers.synap_ask!(makeCtx());

    // Pod-wide = the workspace-less (union) branch, never one arbitrary workspace.
    expect(getAccessibleProfiles).toHaveBeenCalledWith("user-1", "");
    expect(getUserMemberWorkspaceIds).not.toHaveBeenCalled();
    expect(listProfiles).not.toHaveBeenCalled();
    expect(askMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: null,
        catalog: [{ slug: "client", displayName: "Client" }],
      })
    );
  });

  /**
   * SECURITY, not just parity. `ask()` forwards `workspaceId` as the PROCEDURAL
   * namespace, and `knowledge_keys` has no user column — so honouring a
   * caller-supplied id the user is not a member of would read another
   * workspace's runbooks. The `mcp.read` scope proves "may call recall", never
   * "may see THIS workspace". The hub `/knowledge/answer` door degrades a
   * foreign id to pod-wide; this door must too.
   */
  it("degrades a NON-ACCESSIBLE workspaceId to pod-wide instead of honouring it", async () => {
    validateWorkspaceAccess.mockResolvedValue([]);

    await readHandlers.synap_ask!(
      makeCtx({ args: { query: "secrets", workspaceId: "ws-someone-elses" } })
    );

    // Never used as the procedural namespace...
    expect(askMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: null })
    );
    expect(askMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-someone-elses" })
    );
    // ...and never used to build the type-inference catalog either.
    expect(getAccessibleProfiles).not.toHaveBeenCalledWith(
      "user-1",
      "ws-someone-elses"
    );
  });
});
