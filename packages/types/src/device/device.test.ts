import { describe, expect, it } from "vitest";
import {
  COMPUTER_NOUN,
  accessLine,
  approveDecision,
  canApprove,
  decidedRead,
  defaultAgents,
  deviceApproveIsHold,
  deviceReadFromError,
  initialDeviceCode,
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
} from "./index.js";

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

describe("a link's code", () => {
  it("reads a complete code in any case, with or without a dash", () => {
    expect(initialDeviceCode("abcd-efgh")).toBe("abcd-efgh");
    expect(initialDeviceCode(" ABCDEFGH ")).toBe("ABCDEFGH");
    // A router hands a repeated param as an array: the first value counts.
    expect(initialDeviceCode(["abcdefgh", "zzzz"])).toBe("abcdefgh");
  });
  it("drops an incomplete or absent code — the person types it instead", () => {
    expect(initialDeviceCode("abcd")).toBeNull();
    expect(initialDeviceCode("")).toBeNull();
    expect(initialDeviceCode(undefined)).toBeNull();
    expect(initialDeviceCode(42)).toBeNull();
  });
});

describe("deviceReadFromError — a refusal is an answer, a failure is not", () => {
  it("a miss is 'unknown' whether the surface saw a status or a tRPC code", () => {
    expect(deviceReadFromError({ status: 404 })).toEqual({ kind: "unknown" });
    expect(deviceReadFromError({ code: "NOT_FOUND" })).toEqual({
      kind: "unknown",
    });
  });
  it("a lock-out is 'locked', with the pod's words or a fallback", () => {
    expect(
      deviceReadFromError({
        code: "TOO_MANY_REQUESTS",
        message: "Too many wrong codes.",
      })
    ).toEqual({ kind: "locked", message: "Too many wrong codes." });
    expect(deviceReadFromError({ status: 429 })).toEqual({
      kind: "locked",
      message: "Wait a few minutes, then try again.",
    });
  });
  it("anything else FAILED — never folded into 'gone'", () => {
    expect(deviceReadFromError({ status: 502 })).toEqual({
      kind: "failed",
      message: "Error (502)",
    });
    expect(
      deviceReadFromError({ code: "INTERNAL_SERVER_ERROR", message: "boom" })
    ).toEqual({
      kind: "failed",
      message: "boom",
    });
    expect(deviceReadFromError({})).toEqual({
      kind: "failed",
      message: "Could not reach this pod.",
    });
  });
});

describe("after a decision lands", () => {
  it("the same request reads approved or denied", () => {
    expect(deviceStage("ABCDEFGH", decidedRead(REQUEST, "approve"))).toBe(
      "approved"
    );
    expect(deviceStage("ABCDEFGH", decidedRead(REQUEST, "deny"))).toBe(
      "denied"
    );
  });
});

describe("the pending choices", () => {
  it("every agent the terminal asked for starts checked", () => {
    expect(defaultAgents(REQUEST)).toEqual(["claude-code", "codex"]);
  });
  it("Approve needs a name", () => {
    expect(canApprove("devbox")).toBe(true);
    expect(canApprove("   ")).toBe(false);
  });
  it("the access sentence names the computer and the key's validity", () => {
    expect(accessLine(REQUEST, " My devbox ")).toBe(
      "My devbox gets its own access: it reads your data and proposes changes — every change waits for your approval. Key valid 90 days."
    );
    expect(accessLine(REQUEST, "")).toMatch(/^devbox gets/);
  });
});

describe("hold to approve — the connect card's rule", () => {
  it("the AI read & propose preset is a tap (no full access, no approving)", () => {
    expect(deviceApproveIsHold(REQUEST)).toBe(false);
  });
  it("full access is a hold", () => {
    expect(deviceApproveIsHold({ ...REQUEST, accessName: "Full access" })).toBe(
      true
    );
  });
  it("an access name this build does not know is a hold", () => {
    expect(
      deviceApproveIsHold({ ...REQUEST, accessName: "Something new" })
    ).toBe(true);
  });
});
