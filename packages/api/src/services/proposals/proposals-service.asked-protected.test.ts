import { describe, it, expect } from "vitest";
import { computeRevisedEnvelope } from "./proposals-service.js";

/**
 * `asked` is NOT revisable: it is what an app/connect or agent/connect request
 * asked for, and the executors refuse an approval wider than it. A revise may
 * narrow `requests`; it may never rewrite `asked`.
 */
const AGENT_CONNECT = {
  targetType: "agent",
  changeType: "agent/connect",
  data: {
    requests: [{ permission: "document.read", workspaceId: null }],
    asked: [{ permission: "document.read", workspaceId: null }],
  },
};

describe("computeRevisedEnvelope — asked is not revisable", () => {
  it("refuses a patch that widens asked (nested form)", () => {
    expect(() =>
      computeRevisedEnvelope({
        envelope: AGENT_CONNECT,
        patch: {
          kind: "envelope",
          fields: { data: { asked: [{ permission: "*", workspaceId: null }] } },
        },
      })
    ).toThrow(/asked/);
  });

  it("refuses an inner patch that rewrites asked", () => {
    expect(() =>
      computeRevisedEnvelope({
        envelope: AGENT_CONNECT,
        patch: { kind: "inner", fields: { asked: [] } },
      })
    ).toThrow(/asked/);
  });

  it("still lets a revise narrow the requests", () => {
    expect(() =>
      computeRevisedEnvelope({
        envelope: AGENT_CONNECT,
        patch: { kind: "envelope", fields: { data: { requests: [] } } },
      })
    ).not.toThrow();
  });
});

describe("computeRevisedEnvelope — a connect request's identity is not revisable", () => {
  it.each(["keyId", "agentUserId", "appId"])(
    "refuses a patch that repoints %s (top level and nested)",
    (field) => {
      for (const fields of [
        { [field]: "someone-else" },
        { data: { [field]: "someone-else" } },
      ])
        expect(() =>
          computeRevisedEnvelope({
            envelope: AGENT_CONNECT,
            patch: { kind: "envelope", fields },
          })
        ).toThrow(new RegExp(field));
    }
  );
});

/**
 * A request the CLI filed AS THE PERSON (W3): `asPerson` makes its approval
 * need a proof of presence in every mode, and `instanceLabel` is the computer
 * the audit names. Neither may be cleared or rewritten by a revise.
 */
const AS_PERSON = {
  targetType: "agent",
  changeType: "agent/connect",
  data: {
    ...AGENT_CONNECT.data,
    asPerson: true,
    instanceLabel: "MacBook-Pro",
  },
};

describe("computeRevisedEnvelope — a request filed as the person stays so", () => {
  it.each([
    ["asPerson", false],
    ["instanceLabel", "Someone-elses-PC"],
  ] as const)("refuses a patch that rewrites %s", (field, value) => {
    for (const patch of [
      { kind: "envelope" as const, fields: { data: { [field]: value } } },
      { kind: "inner" as const, fields: { [field]: value } },
    ])
      expect(() =>
        computeRevisedEnvelope({ envelope: AS_PERSON, patch })
      ).toThrow(new RegExp(field));
  });

  it("a wholesale data replacement cannot drop them: they are restored", () => {
    const { merged } = computeRevisedEnvelope({
      envelope: AS_PERSON,
      patch: {
        kind: "envelope",
        fields: { data: { requests: [], asked: AGENT_CONNECT.data.asked } },
      },
    });
    const data = merged.data as Record<string, unknown>;
    expect(data.asPerson).toBe(true);
    expect(data.instanceLabel).toBe("MacBook-Pro");
  });
});
