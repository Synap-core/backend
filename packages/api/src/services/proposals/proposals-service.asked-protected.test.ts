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
