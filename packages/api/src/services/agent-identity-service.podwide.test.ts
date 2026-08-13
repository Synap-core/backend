/**
 * provisionSurfaceAgentKey — pod-wide (linkedUserId: null) opt-in door.
 *
 * #1b opens minting of a POD-WIDE agent key: `linkedUserId: null`, bound to the
 * agent-user principal itself so it is governed as its OWN identity (#1a's
 * resolveKeyIdentity derives agentUserId from userType==='agent'), NOT by
 * impersonating the human creator.
 *
 * The door is OPT-IN:
 *   • podWide: true  → the mint receives linkedUserId = null.
 *   • default        → the mint receives the creator (never null) — the key acts
 *     for a human, the pre-existing fail-closed contract.
 *   • createdByUserId is REQUIRED either way — NO_HUMAN_OWNER regardless of
 *     podWide (the agent-user still needs a creator for the (creator × agentType)
 *     singleton + attribution). podWide only drops the KEY's linked human.
 *
 * No live DB: `@synap/database` and the two mint helpers are stubbed. We capture
 * the `linkedUserId` handed to the canonical mint primitive
 * (createAndVerifyHubInboundKey) and assert on it. The full DB round-trip
 * (agent-user row userType='agent', key row persistence) is DB-gated and covered
 * at runtime (redeploy — NEEDS-DOGFOOD).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

/** Captures the input handed to the canonical hub-inbound mint primitive. */
let lastMintInput: Record<string, unknown> | undefined;

vi.mock("@synap/database", () => ({
  // findOrCreateServiceAgentUser short-circuits on an existing agent user, so no
  // insert path is exercised. Its principal is userType='agent' by construction
  // (that insert shape is asserted by agent-creator-type-singleton + the
  // kratos-identity-invariant tests).
  db: {
    query: {
      users: {
        findFirst: vi.fn(async () => ({
          id: "agent-user-1",
          email: "agent-generic-abcdef@synap.agent",
        })),
      },
      apiKeys: { findFirst: vi.fn(async () => null) },
    },
  },
  eq: vi.fn(),
  and: vi.fn(),
  inArray: vi.fn(),
  isNull: vi.fn(),
  sql: vi.fn(),
  apiKeys: {},
  EventRepository: class {},
  ApiKeyRepository: class {},
}));

vi.mock("@synap/database/schema", () => ({ agents: {}, users: {} }));

vi.mock("./hub-integration-registration.js", () => ({
  SETUP_AGENT_HUB_SCOPES: ["hub-protocol.read", "hub-protocol.write"],
  AGENT_KEY_TTL_DAYS: 90,
  AGENT_KEY_ROTATION_LEAD_DAYS: 14,
  revokeActiveHubInboundKeysForUser: vi.fn(async () => undefined),
}));

vi.mock("./external-registration.js", () => ({
  createAndVerifyHubInboundKey: vi.fn(
    async (_repo: unknown, input: Record<string, unknown>) => {
      lastMintInput = input;
      return {
        outcome: "CONNECTED_VERIFIED",
        plainKey: "synap_hub_live_stub",
        apiKey: { id: "minted-key-id" },
      };
    }
  ),
}));

import { provisionSurfaceAgentKey } from "./agent-identity-service.js";

describe("provisionSurfaceAgentKey — pod-wide opt-in", () => {
  beforeEach(() => {
    lastMintInput = undefined;
  });

  it("DEFAULT (no podWide): mints the key linked to the creator, never null", async () => {
    const result = await provisionSurfaceAgentKey({
      agentType: "generic",
      createdByUserId: "human-1",
      linkedUserId: null,
    });
    expect(result.agentUserId).toBe("agent-user-1");
    // linkedUserId defaults to the creator — the key acts for that human.
    expect(lastMintInput?.linkedUserId).toBe("human-1");
    expect(lastMintInput?.keyType).toBe("hub_inbound");
    // The key owner is the agent-user principal (governed by #1a).
    expect(lastMintInput?.userId).toBe("agent-user-1");
  });

  it("OPT-IN (podWide): mints the key with linkedUserId = null, owned by the agent-user", async () => {
    const result = await provisionSurfaceAgentKey({
      agentType: "generic",
      createdByUserId: "human-1",
      linkedUserId: null,
      podWide: true,
    });
    expect(result.agentUserId).toBe("agent-user-1");
    // The DELIBERATE null-linked mint — governed as the agent-user's own principal.
    expect(lastMintInput?.linkedUserId).toBeNull();
    expect(lastMintInput?.keyType).toBe("hub_inbound");
    expect(lastMintInput?.userId).toBe("agent-user-1");
  });

  it("OPT-IN (podWide): ignores an explicitly passed linkedUserId — the key stays pod-wide", async () => {
    await provisionSurfaceAgentKey({
      agentType: "generic",
      createdByUserId: "human-1",
      linkedUserId: "human-2",
      podWide: true,
    });
    expect(lastMintInput?.linkedUserId).toBeNull();
  });

  it("still requires a creator: NO_HUMAN_OWNER without createdByUserId (default)", async () => {
    await expect(
      provisionSurfaceAgentKey({
        agentType: "generic",
        createdByUserId: null,
        linkedUserId: null,
      })
    ).rejects.toMatchObject({ code: "NO_HUMAN_OWNER" });
    expect(lastMintInput).toBeUndefined();
  });

  it("still requires a creator: NO_HUMAN_OWNER without createdByUserId (even with podWide)", async () => {
    // podWide drops the KEY's linked human, NOT the agent-user's creator. A
    // pod-wide agent still needs a principal creator to exist.
    await expect(
      provisionSurfaceAgentKey({
        agentType: "generic",
        createdByUserId: null,
        linkedUserId: null,
        podWide: true,
      })
    ).rejects.toMatchObject({ code: "NO_HUMAN_OWNER" });
    expect(lastMintInput).toBeUndefined();
  });
});
