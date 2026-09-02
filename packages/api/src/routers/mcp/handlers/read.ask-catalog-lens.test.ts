/**
 * synap_ask — catalog lens follows the query lens (DOOR PARITY regression).
 *
 * The type-inference catalog used to fetch from the caller's FIRST-membership
 * workspace (`wsIds[0]`, an unordered SELECT) whenever no `workspaceId` was
 * passed — a DIFFERENT workspace than the one `ask()` actually retrieved
 * from. The hub `/knowledge/answer` door reads the same `workspaceId` for
 * both catalog and retrieval; this door must match it: catalog tracks
 * whatever `workspaceId` the caller passed, and unscoped means pod-wide
 * (no catalog fetch, no membership fallback) for both.
 *
 * `ask`/`synthesizeAnswer` and `getUserMemberWorkspaceIds` are mocked so this
 * exercises the handler's own branching, not retrieval or the DB.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  askMock,
  synthesizeAnswerMock,
  getUserMemberWorkspaceIds,
  getUserAccessibleWorkspaceIds,
  listProfiles,
} = vi.hoisted(() => ({
  askMock: vi.fn(),
  synthesizeAnswerMock: vi.fn(),
  getUserMemberWorkspaceIds: vi.fn(),
  getUserAccessibleWorkspaceIds: vi.fn(),
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
  getUserAccessibleWorkspaceIds,
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
    listProfiles.mockResolvedValue({ profiles: [] });
    askMock.mockResolvedValue({ answers: [], routedTo: [], pending: null });
    synthesizeAnswerMock.mockResolvedValue({ answer: "ok" });
    // Accessible by default; the leak case overrides this explicitly below.
    getUserAccessibleWorkspaceIds.mockResolvedValue(["ws-explicit"]);
  });

  it("fetches the catalog from the EXPLICIT workspaceId (not membership[0])", async () => {
    await readHandlers.synap_ask!(
      makeCtx({ args: { query: "who is Alice", workspaceId: "ws-explicit" } })
    );

    expect(listProfiles).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-explicit" })
    );
    expect(getUserMemberWorkspaceIds).not.toHaveBeenCalled();
    // Retrieval must use the SAME lens the catalog was built from.
    expect(askMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-explicit" })
    );
  });

  it("stays pod-wide when unscoped: no catalog fetch, no membership[0] fallback", async () => {
    getUserMemberWorkspaceIds.mockResolvedValue(["ws-other-1", "ws-other-2"]);

    await readHandlers.synap_ask!(makeCtx());

    expect(listProfiles).not.toHaveBeenCalled();
    // If it fell back to the arbitrary pick, this would be consulted — it must not be.
    expect(getUserMemberWorkspaceIds).not.toHaveBeenCalled();
    expect(askMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: null, catalog: [] })
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
    getUserAccessibleWorkspaceIds.mockResolvedValue(["ws-mine"]);

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
    expect(listProfiles).not.toHaveBeenCalled();
  });
});
