import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A capability's own key needs no second vault grant (founder, 2026-10-28).
 *
 * Before: an agent running an approved, granted verb of an installed capability
 * (jev_choose, exa_search) still failed `Vault grant check failed: no_grant`,
 * because the key the install created was grant-gated per agent and per space.
 * The capability gate had already said yes to the same act.
 *
 * SEAM: the real `vaultHandler` (`__vaultHandlerForTests`), with the secret row
 * and the tool's member_of edge as the database returns them. Asserted on the
 * options it passes to `resolveVaultSecret` (undefined = ungated): that argument
 * IS the decision. The resolver returns null, so the handler stops at its 404
 * and nothing is fetched.
 *
 * NOT covered here: that every call reaching a handler passed the capability
 * gate (triggerProviderAction returns before the handler on deny / dry-run /
 * propose), nor the redeem door (rest/vault.ts), which this change leaves gated.
 */

const { mockResolveVaultSecret, mockFindFirst, mockEdgeRows } = vi.hoisted(
  () => ({
    mockResolveVaultSecret: vi.fn(),
    mockFindFirst: vi.fn(),
    mockEdgeRows: vi.fn(),
  })
);

vi.mock("../utils/vault-resolver.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../utils/vault-resolver.js")>();
  return { ...actual, resolveVaultSecret: mockResolveVaultSecret };
});

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(mockEdgeRows()),
  };
  return {
    ...actual,
    db: {
      query: { secrets: { findFirst: mockFindFirst } },
      select: () => chain,
    },
  };
});

import { __vaultHandlerForTests as vaultHandler } from "./external-dispatch.js";

const OWNER = "owner-1";
const AGENT = "agent-1";
const CAP = "cap-jev";
const TOOL = {
  id: "tool-jev-api",
  name: "jev_api",
  config: {
    baseUrl: "https://api.typesafe.ai",
    auth: { in: "header", name: "Authorization", prefix: "Bearer " },
  },
};

function run(secret: Record<string, unknown>) {
  mockFindFirst.mockResolvedValueOnce({
    userId: OWNER,
    providerIntegrationId: null,
    accountHint: null,
    isPodWide: false,
    capabilityId: null,
    ...secret,
  });
  return vaultHandler({
    input: {
      userId: OWNER,
      agentUserId: AGENT,
      workspaceId: "ws-1",
      provider: "vault://secret-1",
      method: "POST",
      path: "/v1/systemone",
      body: {},
    },
    tool: TOOL,
  } as never);
}

/** The 4th argument resolveVaultSecret received: undefined = ungated. */
function optsPassed() {
  expect(mockResolveVaultSecret).toHaveBeenCalledTimes(1);
  return mockResolveVaultSecret.mock.calls[0]![3];
}

const GATED = {
  requireGrant: true,
  redeemer: { agentUserId: AGENT, workspaceId: "ws-1" },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveVaultSecret.mockResolvedValue(null);
  mockEdgeRows.mockReturnValue([{ capabilityId: CAP }]);
});

describe("vaultHandler — a capability's own key needs no second grant", () => {
  it("the owner's connection OF the tool's own capability is ungated for an agent", async () => {
    await run({ capabilityId: CAP });
    expect(optsPassed()).toBeUndefined();
  });

  it("a key of ANOTHER capability is still grant-gated", async () => {
    await run({ capabilityId: "cap-exa" });
    expect(optsPassed()).toEqual(GATED);
  });

  it("a personal vault key (no capability) is still grant-gated, and no edge is read", async () => {
    await run({ capabilityId: null });
    expect(optsPassed()).toEqual(GATED);
    expect(mockEdgeRows).not.toHaveBeenCalled();
  });

  it("another member's key of the same capability is still grant-gated", async () => {
    await run({ capabilityId: CAP, userId: "someone-else" });
    expect(optsPassed()).toEqual(GATED);
  });

  it("a tool that belongs to no capability gets no bypass", async () => {
    mockEdgeRows.mockReturnValueOnce([]);
    await run({ capabilityId: CAP });
    expect(optsPassed()).toEqual(GATED);
  });
});
