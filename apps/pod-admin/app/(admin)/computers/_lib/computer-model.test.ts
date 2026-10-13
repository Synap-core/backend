import { describe, expect, it } from "vitest";
import { AGENT_CONNECT_COMMAND } from "@synap-core/types/agents";
import {
  RECONNECT_COMMAND,
  activityLine,
  agentsPhrase,
  computerCounts,
  computerFilterOf,
  computerMatches,
  computerSummary,
  expiredLine,
  keyLifetimeLine,
  keyStatus,
  keysOnComputer,
  ownerWords,
  platformLabel,
  revokeImpact,
  revokeLine,
  rosterLine,
  validKeyTtl,
  type ComputerKeyLike,
  type ComputerKeyState,
  type ComputerLike,
} from "./computer-model";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const DAY = 86_400_000;

const key = (
  state: ComputerKeyState,
  expiresAt: Date | null = null,
  id = `k-${state}`
): ComputerKeyLike => ({ id, state, expiresAt });

function computer(over: Partial<ComputerLike> = {}): ComputerLike {
  return {
    id: "c1",
    name: "devbox",
    hostname: "devbox.local",
    platform: "linux",
    createdAt: new Date(NOW - 30 * DAY),
    lastSeenAt: new Date(NOW - 60_000),
    key: key("active", new Date(NOW + 60 * DAY)),
    keyTtlDays: null,
    effectiveKeyTtlDays: 90,
    minKeyTtlDays: 7,
    maxKeyTtlDays: 365,
    accessName: "AI — read & propose",
    agents: [],
    ...over,
  };
}

const agent = (id: string, k: ComputerKeyLike | null) => ({
  id,
  agentType: "claude-code",
  name: id,
  displayName: `${id} on devbox`,
  lastSeenAt: null,
  key: k,
});

describe("keyStatus", () => {
  it("reads each state as the console's pill", () => {
    expect(keyStatus(key("active"), NOW)).toEqual({
      kind: "healthy",
      label: "Active",
    });
    expect(keyStatus(key("expiring", new Date(NOW + 2.5 * DAY)), NOW)).toEqual({
      kind: "stale",
      label: "Expires in 3 days",
    });
    expect(keyStatus(key("expiring", new Date(NOW + 1000)), NOW).label).toBe(
      "Expires in 1 day"
    );
    expect(keyStatus(key("expired"), NOW)).toEqual({
      kind: "down",
      label: "Expired",
    });
    expect(keyStatus(key("revoked"), NOW)).toEqual({
      kind: "unknown",
      label: "Revoked",
    });
    expect(keyStatus(null, NOW).label).toBe("No key");
  });
});

describe("the list's filters", () => {
  const list = [
    computer({ key: key("active") }),
    computer({ key: key("expiring") }),
    computer({ key: key("expired") }),
    computer({ key: key("expired") }),
    computer({ key: key("revoked") }),
    computer({ key: null }),
  ];

  it("counts each state; a computer with no key counts under All only", () => {
    expect(computerCounts(list)).toEqual({
      all: 6,
      active: 1,
      expiring: 1,
      expired: 2,
      revoked: 1,
    });
    expect(list.filter((c) => computerMatches("all", c))).toHaveLength(6);
    expect(list.filter((c) => computerMatches("expired", c))).toHaveLength(2);
  });

  it("reads ?status=, falling back to All", () => {
    expect(computerFilterOf("expiring")).toBe("expiring");
    expect(computerFilterOf("nonsense")).toBe("all");
    expect(computerFilterOf(null)).toBe("all");
  });

  it("calls out expired keys only (an expiring key renews on its own)", () => {
    expect(expiredLine([computer({ key: key("expiring") })])).toBeNull();
    expect(expiredLine(list)).toBe("2 computers' keys have expired");
    expect(expiredLine([computer({ key: key("expired") })])).toBe(
      "One computer's key has expired"
    );
  });

  it("rolls the roster up in one line", () => {
    expect(
      rosterLine([
        computer({ agents: [agent("a", null), agent("b", null)] }),
        computer(),
      ])
    ).toBe("2 agents on 2 computers");
    expect(rosterLine([computer({ agents: [agent("a", null)] })])).toBe(
      "1 agent on 1 computer"
    );
  });
});

describe("words", () => {
  it("agentsPhrase", () => {
    expect(agentsPhrase(0)).toBe("No agents");
    expect(agentsPhrase(1)).toBe("Runs 1 agent");
    expect(agentsPhrase(3)).toBe("Runs 3 agents");
  });

  it("platformLabel names the OS a person knows", () => {
    expect(platformLabel("darwin")).toBe("macOS");
    expect(platformLabel("linux")).toBe("Linux");
    expect(platformLabel("win32")).toBe("Windows");
    expect(platformLabel("freebsd")).toBe("Freebsd");
    expect(platformLabel(null)).toBeNull();
    expect(platformLabel("  ")).toBeNull();
  });

  it("ownerWords: 'you' on your own page and for your own computer", () => {
    expect(ownerWords(computer(), "me")).toBe("you");
    expect(
      ownerWords(computer({ owner: { id: "me", name: "Antoine" } }), "me")
    ).toBe("you");
    expect(
      ownerWords(computer({ owner: { id: "m2", name: "Marie" } }), "me")
    ).toBe("Marie");
    expect(ownerWords(computer({ owner: null }), "me")).toBeNull();
  });

  it("computerSummary says what runs on it, for whom, and when it was seen", () => {
    const rel = () => "4m ago";
    expect(
      computerSummary(
        computer({
          owner: { id: "m2", name: "Marie" },
          agents: [agent("a", null), agent("b", null)],
        }),
        "me",
        rel
      )
    ).toBe("Runs 2 agents for Marie. Last seen 4m ago.");
    expect(computerSummary(computer({ lastSeenAt: null }), "me", rel)).toBe(
      "No agents run on it; it belongs to you. It has not called the pod yet."
    );
  });

  it("keyLifetimeLine says whose lifetime it is", () => {
    expect(keyLifetimeLine(computer())).toBe("90 days (pod default)");
    expect(
      keyLifetimeLine(computer({ keyTtlDays: 30, effectiveKeyTtlDays: 30 }))
    ).toBe("30 days (this computer)");
    expect(
      keyLifetimeLine(computer({ keyTtlDays: 1, effectiveKeyTtlDays: 1 }))
    ).toBe("1 day (this computer)");
  });

  it("validKeyTtl holds the pod's bounds and whole days", () => {
    const c = computer();
    expect(validKeyTtl(7, c)).toBe(true);
    expect(validKeyTtl(365, c)).toBe(true);
    expect(validKeyTtl(6, c)).toBe(false);
    expect(validKeyTtl(366, c)).toBe(false);
    expect(validKeyTtl(30.5, c)).toBe(false);
  });

  it("the reconnect line is the connect command's own CLI", () => {
    expect(RECONNECT_COMMAND).toBe(
      AGENT_CONNECT_COMMAND.replace(/ init$/, " pods reconnect")
    );
    expect(RECONNECT_COMMAND).toMatch(/ pods reconnect$/);
  });
});

describe("activityLine", () => {
  const ev = (data: unknown, eventType = "users.update.completed") => ({
    eventType,
    userId: "u",
    data,
  });
  const humanize = (t: string) => `H(${t})`;

  it("says what was done to the computer", () => {
    expect(
      activityLine(ev({ kind: "machine_rename", to: "Build box" }), humanize)
    ).toBe("Renamed to “Build box”");
    expect(
      activityLine(ev({ kind: "machine_key_ttl", keyTtlDays: 30 }), humanize)
    ).toBe("Key lifetime set to 30 days");
    expect(
      activityLine(ev({ kind: "machine_key_ttl", keyTtlDays: null }), humanize)
    ).toBe("Key lifetime back to the pod default");
    expect(
      activityLine(ev({ kind: "machine_revoke", revokedKeys: 1 }), humanize)
    ).toBe("Revoked — 1 key stopped working");
  });

  it("falls back to the event type, humanized", () => {
    expect(activityLine(ev(null, "api_keys.revoke.completed"), humanize)).toBe(
      "H(api_keys revoke)"
    );
  });
});

describe("keys and the revoke's impact", () => {
  const c = computer({
    key: key("expiring", null, "own"),
    agents: [
      agent("live", key("active", null, "k1")),
      agent("old", key("revoked", null, "k2")),
      agent("keyless", null),
    ],
  });

  it("lists the computer's key first, then each agent that holds one", () => {
    expect(
      keysOnComputer(c).map((k) => [k.holderName, k.own, k.key.id])
    ).toEqual([
      ["devbox", true, "own"],
      ["live", false, "k1"],
      ["old", false, "k2"],
    ]);
  });

  it("counts only the live keys and the agents it disconnects", () => {
    expect(revokeImpact(c)).toEqual({ liveKeys: 2, agents: 1 });
    expect(revokeLine(c)).toBe("Revokes 2 keys and disconnects 1 agent.");
    expect(revokeLine(computer({ agents: [] }))).toBe("Revokes 1 key.");
    expect(revokeLine(computer({ key: key("revoked"), agents: [] }))).toBe(
      "Nothing on it can reach the pod now."
    );
  });
});
