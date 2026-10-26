/**
 * The `proposalUpdates` digest REACHES an agent's tool result through the real
 * `executeMCPToolViaHubProtocol` (review of #199: only the helper and the merge
 * were tested, not the call site).
 *
 * Drives a real read tool (`synap_list_capabilities`, catalog stubbed the way
 * `synap-list-capabilities-core-pack.test.ts` stubs it) as an AGENT, with the
 * digest read replaced by a recorder. Negative control (2026-10-25,
 * negctl/tickets-1025-7): the adapter's `withProposalUpdates` line removed
 * turns the agent case red.
 */
import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({
  listCapabilities: vi.fn(async () => []),
  calls: [] as unknown[][],
}));

vi.mock(
  "../../services/capabilities/capability-registry.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../services/capabilities/capability-registry.js")
    >()),
    listCapabilities: h.listCapabilities,
  })
);
vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  getDb: vi.fn(async () => ({}) as never),
}));
vi.mock("../hub-protocol/rest/_shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hub-protocol/rest/_shared.js")>()),
  verifyWorkspaceAccess: vi.fn(async () => true),
}));
vi.mock("../../services/agent-identity-service.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../services/agent-identity-service.js")
  >()),
  getAgentFocusWorkspaceId: vi.fn(async () => undefined),
}));
vi.mock(
  "../../services/proposals/proposal-updates-digest.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../services/proposals/proposal-updates-digest.js")
    >()),
    takeProposalUpdates: vi.fn(async (...args: unknown[]) => {
      h.calls.push(args);
      return [
        {
          id: "df94aeac-b66d-47f7-ba77-27df3bdf6e6f",
          status: "approved",
          change: "settings/settings.update",
          reviewedAt: "2026-10-25T17:26:14.242Z",
          reviewUrl: "/open/df94aeac-b66d-47f7-ba77-27df3bdf6e6f",
        },
      ];
    }),
  })
);

import { executeMCPToolViaHubProtocol } from "./adapter.js";

const WS = "0aaaaaaa-0000-4000-8000-000000000001";

const payload = (
  result: Awaited<ReturnType<typeof executeMCPToolViaHubProtocol>>
) => {
  const block = result.content?.[0];
  if (!block || block.type !== "text") throw new Error("expected text");
  return JSON.parse(block.text) as Record<string, unknown>;
};

describe("executeMCPToolViaHubProtocol — proposalUpdates reaches the agent", () => {
  it("an AGENT call carries the digest, read for that agent AND its person", async () => {
    h.calls.length = 0;
    const result = await executeMCPToolViaHubProtocol(
      "synap_list_capabilities",
      { workspaceId: WS },
      "user-1",
      ["mcp.read"],
      undefined,
      "agent-1"
    );
    expect(payload(result).proposalUpdates).toEqual([
      expect.objectContaining({ status: "approved" }),
    ]);
    expect(h.calls[0]!.slice(0, 2)).toEqual(["agent-1", "user-1"]);
  });

  it("a person's own call (no agent) carries none and reads nothing", async () => {
    h.calls.length = 0;
    const result = await executeMCPToolViaHubProtocol(
      "synap_list_capabilities",
      { workspaceId: WS },
      "user-1",
      ["mcp.read"]
    );
    expect(payload(result)).not.toHaveProperty("proposalUpdates");
    expect(h.calls).toEqual([]);
  });
});
