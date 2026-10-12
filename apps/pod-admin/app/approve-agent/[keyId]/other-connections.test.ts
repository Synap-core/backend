import { describe, expect, it } from "vitest";
import {
  approveBody,
  approvedOutcome,
  newerRequestHref,
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
    expect(
      v.others.map(({ keyId, computer, lastUsed }) => ({
        keyId,
        computer,
        lastUsed,
      }))
    ).toEqual([
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

describe("rows a person can tell apart", () => {
  // Rules out two unlabelled connections rendering identically: each row
  // carries the day it connected.
  it("two unlabelled connections differ by the day they connected", () => {
    const v = viewConnections({
      connections: [
        conn({ keyId: "u1", createdAt: "2026-10-03T10:00:00.000Z" }),
        conn({ keyId: "u2", createdAt: "2026-09-20T10:00:00.000Z" }),
      ],
    });
    const [a, b] = v.others;
    expect(a.computer).toBe(b.computer);
    expect(a.connected).toBe("connected 3 Oct 2026");
    expect(b.connected).toBe("connected 20 Sept 2026");
  });

  // Rules out the "(older CLI)" guess: the pod does not know why a name is missing.
  it("a connection with no computer name reads plain 'unlabelled'", () => {
    const v = viewConnections({ connections: [conn({ keyId: "u" })] });
    expect(v.others[0].computer).toBe("unlabelled");
  });

  // Rules out a hard-coded "Claude Code": the agent's name comes from the data.
  it("the section names the agent from the pod's answer", () => {
    expect(viewConnections({ agentType: "claude-code" }).agent).toBe(
      "Claude Code"
    );
    expect(
      viewConnections({ agentType: "my-bot", agentName: "Hermes" }).agent
    ).toBe("Hermes");
  });
});

describe("newerRequestHref", () => {
  // Rules out a banner that names a newer request but cannot open it.
  it("links a superseded request to the newer one's own page", () => {
    const v = viewConnections({
      connections: [],
      supersededBy: { keyId: "newer-key", createdAt: new Date().toISOString() },
    });
    expect(newerRequestHref(v, "claude-code")).toBe(
      "/approve-agent/newer-key?agentType=claude-code"
    );
    expect(newerRequestHref(viewConnections({ connections: [] }), "x")).toBe(
      null
    );
  });
});

describe("approvedOutcome", () => {
  // Rules out a success screen that forgets what approving switched off.
  it("past-tense heading, one row per replaced and per ticked connection", () => {
    const v = viewConnections({
      displayName: "Claude Code on devbox",
      connections: [
        conn({
          keyId: "old",
          instanceId: "d",
          instanceLabel: "devbox",
          sameComputer: true,
        }),
        conn({ keyId: "mac", instanceLabel: "MacBook" }),
        conn({ keyId: "pi", instanceLabel: "raspberry" }),
      ],
    });
    expect(approvedOutcome(v, ["mac", "ghost"])).toEqual({
      title: "Claude Code on devbox connected",
      rows: ["Replaced: devbox", "Disconnected: MacBook"],
    });
  });
});
