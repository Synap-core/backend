/**
 * The skill door follows the KEY on the Synap account connector (W5): every key
 * the Control Plane holds carries its `mcp:` instanceId, whichever client's
 * agent it belongs to, so Grok behind mcp.synap.live is taught `pod__*` names
 * while Grok's own computer key (`synap connect grok`) is taught the pod's.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  keyInstanceId: null as string | null | undefined,
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
                return h.keyInstanceId === undefined
                  ? []
                  : [{ instanceId: h.keyInstanceId }];
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
  h.keyInstanceId = null;
  h.agentType = null;
  h.reads = [];
});

describe("resolveSkillDoor", () => {
  it("a client's own agent behind the Synap account reads the connector's names", async () => {
    h.agentType = "grok";
    h.keyInstanceId = "mcp:cp-user:pod-1:grok";
    expect(await resolveSkillDoor("agent-grok", "key-1")).toBe("cp-connector");
  });

  it("the same client on its computer key reads the pod's names", async () => {
    h.agentType = "grok";
    h.keyInstanceId = "machine-abc";
    expect(await resolveSkillDoor("agent-grok", "key-2")).toBe("pod-mcp");
  });

  it("the pre-W5 claude-web agent still reads the connector's names, key or not", async () => {
    h.agentType = "claude-web";
    expect(await resolveSkillDoor("agent-web")).toBe("cp-connector");
    h.keyInstanceId = undefined; // key row gone
    expect(await resolveSkillDoor("agent-web", "key-gone")).toBe(
      "cp-connector"
    );
  });

  it("no key and no agent: pod names, nothing read", async () => {
    expect(await resolveSkillDoor(null)).toBe("pod-mcp");
    expect(h.reads).toEqual([]);
  });
});
