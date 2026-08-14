/**
 * `resolveKeyIdentity` — the one identity door. Asserts the `isAgent` /
 * `agentUserId` derivation is driven by the key PRINCIPAL's `userType`, never
 * by `linkedUserId` presence — the conflation that let a pod-wide agent key
 * (isAgent, no linkedUserId) be misclassified as human-owned at the
 * `/setup/agent` surface-key door.
 */
import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({
  userType: undefined as string | undefined,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      query: {
        users: {
          findFirst: async () =>
            h.userType === undefined ? undefined : { userType: h.userType },
        },
      },
    },
  };
});

import { resolveKeyIdentity } from "./key-identity.js";

describe("resolveKeyIdentity", () => {
  it("a pod-wide agent key (isAgent, no linkedUserId) resolves isAgent=true", async () => {
    h.userType = "agent";
    const identity = await resolveKeyIdentity({
      userId: "agent-principal-1",
      linkedUserId: null,
    });
    expect(identity.isAgent).toBe(true);
    expect(identity.agentUserId).toBe("agent-principal-1");
    // The old conflation read this as "human-owned" purely off linkedUserId
    // being null. It must not be — the principal is an agent.
  });

  it("a linked agent key resolves isAgent=true (unchanged from today)", async () => {
    h.userType = "agent";
    const identity = await resolveKeyIdentity({
      userId: "agent-principal-2",
      linkedUserId: "human-1",
    });
    expect(identity.isAgent).toBe(true);
    expect(identity.agentUserId).toBe("agent-principal-2");
    expect(identity.effectiveUserId).toBe("human-1");
  });

  it("a genuine human key (userType human, no linkedUserId) resolves isAgent=false", async () => {
    h.userType = "human";
    const identity = await resolveKeyIdentity({
      userId: "human-2",
      linkedUserId: null,
    });
    expect(identity.isAgent).toBe(false);
    expect(identity.agentUserId).toBeUndefined();
    expect(identity.effectiveUserId).toBe("human-2");
  });
});
