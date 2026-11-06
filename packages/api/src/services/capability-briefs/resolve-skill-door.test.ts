/**
 * The skill door follows the KEY on the Synap account connector (W5): every key
 * `/mcp/redeem` mints carries the Synap account origin (0400), whichever
 * client's agent it belongs to, so ChatGPT behind mcp.synap.live is taught
 * `pod__*` names while a computer key is taught the pod's. An `mcp:` instance
 * id is no evidence: `/setup/agent` takes any instance id.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  keyOrigin: null as string | null | undefined,
  agentType: null as string | null,
  reads: [] as string[],
}));

// Partial: only `db` is stubbed, at the database boundary; every other name is
// the real module's (the total-mock ratchets).
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: async () => {
              if (table === actual.apiKeys) {
                h.reads.push("api_keys");
                return h.keyOrigin === undefined
                  ? []
                  : [{ origin: h.keyOrigin }];
              }
              if (table !== actual.users)
                throw new Error("unexpected table read");
              h.reads.push("users");
              return h.agentType === null ? [] : [{ agentType: h.agentType }];
            },
          }),
        }),
      }),
    },
  };
});

import { resolveSkillDoor } from "./resolve-skill-door.js";

beforeEach(() => {
  h.keyOrigin = null;
  h.agentType = null;
  h.reads = [];
});

describe("resolveSkillDoor", () => {
  it("a client's own agent behind the Synap account reads the connector's names", async () => {
    h.agentType = "chatgpt";
    h.keyOrigin = "synap-account";
    expect(await resolveSkillDoor("agent-chatgpt", "key-1")).toBe(
      "cp-connector"
    );
  });

  it("the same client on any other key reads the pod's names", async () => {
    h.agentType = "chatgpt";
    h.keyOrigin = null;
    expect(await resolveSkillDoor("agent-chatgpt", "key-2")).toBe("pod-mcp");
  });

  it("the pre-W5 claude-web agent still reads the connector's names, key or not", async () => {
    h.agentType = "claude-web";
    expect(await resolveSkillDoor("agent-web")).toBe("cp-connector");
    h.keyOrigin = undefined; // key row gone
    expect(await resolveSkillDoor("agent-web", "key-gone")).toBe(
      "cp-connector"
    );
  });

  it("no key and no agent: pod names, nothing read", async () => {
    expect(await resolveSkillDoor(null)).toBe("pod-mcp");
    expect(h.reads).toEqual([]);
  });
});
