import { describe, expect, it } from "vitest";
import {
  approveBody,
  UNLABELLED_COMPUTER,
  viewConnections,
  type OtherConnection,
} from "./other-connections";

const conn = (o: Partial<OtherConnection>): OtherConnection => ({
  keyId: "k",
  instanceId: null,
  instanceLabel: null,
  displayName: "Claude Code",
  createdAt: new Date(Date.now() - 3_600_000).toISOString(),
  lastUsedAt: null,
  sameComputer: false,
  ...o,
});

describe("viewConnections", () => {
  it("splits this computer's connection (replaced) from every other one (a choice)", () => {
    const v = viewConnections({
      displayName: "Claude Code on devbox",
      createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      connections: [
        conn({
          keyId: "laptop",
          instanceId: "m-l",
          instanceLabel: "MacBook",
          lastUsedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
        }),
        conn({ keyId: "old-devbox", instanceId: "m-d", sameComputer: true }),
        conn({ keyId: "legacy" }),
      ],
      supersededBy: null,
    });
    expect(v.known).toBe(true);
    expect(v.title).toBe("Claude Code on devbox");
    expect(v.requested).toBe("Requested 5m ago");
    expect(v.replaced.map((r) => r.keyId)).toEqual(["old-devbox"]);
    expect(v.others).toEqual([
      { keyId: "laptop", computer: "MacBook", lastUsed: "last used 2m ago" },
      {
        keyId: "legacy",
        computer: UNLABELLED_COMPUTER,
        lastUsed: "never used",
      },
    ]);
    expect(v.superseded).toBe(false);
  });

  // Rules out reading an older pod (no `connections`) as "no other computer".
  it("an older pod's answer is unknown, not empty", () => {
    const v = viewConnections({});
    expect(v.known).toBe(false);
    expect(v.others).toEqual([]);
  });

  it("a request with a newer one from the same computer is superseded", () => {
    expect(
      viewConnections({
        connections: [],
        supersededBy: { keyId: "n", createdAt: new Date().toISOString() },
      }).superseded
    ).toBe(true);
  });
});

describe("approveBody", () => {
  // Rules out posting a same-computer key (or a stale id) as a choice.
  it("sends only ids offered as a choice — never one approval replaces anyway", () => {
    const v = viewConnections({
      connections: [
        conn({ keyId: "a" }),
        conn({ keyId: "same", instanceId: "m", sameComputer: true }),
      ],
    });
    expect(approveBody(v, ["a", "same", "ghost"])).toEqual({
      alsoDisconnect: ["a"],
    });
    expect(approveBody(v, [])).toEqual({ alsoDisconnect: [] });
  });
});
