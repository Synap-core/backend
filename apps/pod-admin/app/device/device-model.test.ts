import { describe, expect, it } from "vitest";
import {
  COMPUTER_NOUN,
  approveDecision,
  defaultComputerName,
  defaultReuseId,
  denyDecision,
  deviceStage,
  formatCode,
  goneTitle,
  hostedAgentName,
  isCompleteCode,
  type DeviceRead,
  type DeviceRequest,
} from "./device-model";

const REQUEST: DeviceRequest = {
  requestId: "11111111-1111-4111-8111-111111111111",
  status: "pending",
  clientName: "synap-cli",
  hostname: "devbox",
  platform: "linux",
  agents: [
    {
      agentType: "claude-code",
      name: "Claude Code",
      displayName: "Claude Code on devbox",
    },
    { agentType: "codex", name: "Codex", displayName: "Codex on devbox" },
  ],
  requesterIp: "203.0.113.7",
  userAgent: "synap-cli/1",
  createdAt: new Date(Date.now() - 120_000).toISOString(),
  expiresAt: new Date(Date.now() + 480_000).toISOString(),
  reusableComputers: [],
  keyTtlDays: 90,
  accessName: "AI — read & propose",
};

const ok = (over: Partial<DeviceRequest> = {}): DeviceRead => ({
  kind: "ok",
  request: { ...REQUEST, ...over },
});

describe("code", () => {
  it("accepts lowercase and no dash, and prints it as the terminal does", () => {
    expect(formatCode("abcdefgh")).toBe("ABCD-EFGH");
    expect(formatCode("abcd-efgh")).toBe("ABCD-EFGH");
    expect(isCompleteCode("abcd efgh")).toBe(true);
    expect(isCompleteCode("ABCD-EF")).toBe(false);
  });
});

describe("deviceStage — every read lands in exactly one state", () => {
  it.each<[string | null, DeviceRead, string]>([
    [null, { kind: "loading" }, "enter"],
    ["ABCDEFGH", { kind: "loading" }, "loading"],
    ["ABCDEFGH", ok(), "pending"],
    ["ABCDEFGH", ok({ status: "approved" }), "approved"],
    ["ABCDEFGH", ok({ status: "denied" }), "denied"],
    ["ABCDEFGH", ok({ status: "expired" }), "gone"],
    ["ABCDEFGH", ok({ status: "consumed" }), "gone"],
    ["ABCDEFGH", { kind: "unknown" }, "gone"],
    ["ABCDEFGH", { kind: "locked", message: "wait" }, "locked"],
    // A failed read is NOT a calm empty/gone state.
    ["ABCDEFGH", { kind: "failed", message: "502" }, "failed"],
  ])("%s / %o → %s", (code, read, stage) => {
    expect(deviceStage(code, read)).toBe(stage);
  });

  it("explains why a code leads nowhere", () => {
    expect(goneTitle(ok({ status: "expired" }))).toBe("This request expired");
    expect(goneTitle(ok({ status: "consumed" }))).toBe(
      "This code was already used"
    );
    expect(goneTitle({ kind: "unknown" })).toBe(
      "No computer is waiting with that code"
    );
  });
});

describe("reconnect or new (locked decision 2)", () => {
  const old = { id: "m-1", name: "devbox", createdAt: REQUEST.createdAt };
  it("reuses the same-name computer by default", () => {
    const r = { ...REQUEST, reusableComputers: [old] };
    expect(defaultReuseId(r)).toBe("m-1");
    expect(defaultComputerName(r, "m-1")).toBe("devbox");
  });
  it("adds a new computer when none carries the name", () => {
    const r = { ...REQUEST, reusableComputers: [{ ...old, name: "work box" }] };
    expect(defaultReuseId(r)).toBeNull();
    expect(defaultComputerName(r, null)).toBe("devbox");
  });
});

describe("decisions", () => {
  it("'This wasn't me' sends deny and nothing else", () => {
    expect(denyDecision(REQUEST, "abcd-efgh")).toEqual({
      requestId: REQUEST.requestId,
      userCode: "ABCDEFGH",
      decision: "deny",
    });
  });

  it("Approve sends the kept agents, reuse and the name", () => {
    expect(
      approveDecision(REQUEST, "ABCD-EFGH", {
        agents: ["codex"],
        reuseComputerId: "m-1",
        computerName: "  My devbox ",
      })
    ).toEqual({
      requestId: REQUEST.requestId,
      userCode: "ABCDEFGH",
      decision: "approve",
      agents: ["codex"],
      reuseComputerId: "m-1",
      computerName: "My devbox",
    });
  });

  it("names agents by the computer as it is renamed, through the one door", () => {
    expect(hostedAgentName(REQUEST.agents[0]!, "My devbox")).toBe(
      "Claude Code on My devbox"
    );
    expect(COMPUTER_NOUN).toBe("Computer");
  });
});
