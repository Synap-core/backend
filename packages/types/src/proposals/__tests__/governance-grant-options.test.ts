import { describe, it, expect } from "vitest";
import {
  PROPOSE_ONLY_CAPABILITY_VERBS,
  deriveGovernanceGrantOptions,
  deriveGovernanceNeverOption,
  isNonWidenableGovernanceReason,
  type GovernanceGrantContext,
} from "../index.js";

/**
 * B3 — "Always approve…" must not offer a rule that a non-widenable floor makes
 * permanently dead. The floored input is an agent `profile.create` proposal the
 * engine stamped `AGENT_SCHEMA_DEFINITION` (rung 2.08).
 */

const BASE: GovernanceGrantContext = {
  proposalId: "22222222-2222-4222-8222-222222222222",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  agentUserId: "agent-1",
  actionKey: "profile.create",
};

const ids = (
  ctx: GovernanceGrantContext,
  mode?: "agent-scoped" | "operator-any"
) => deriveGovernanceGrantOptions(ctx, mode).map((o) => o.id);

describe("deriveGovernanceGrantOptions — non-widenable floors", () => {
  it("control: without a floor reason, 'this action' is offered in both modes", () => {
    expect(ids(BASE)).toContain("action");
    expect(ids(BASE, "operator-any")).toContain("action");
  });

  it("a floored proposal drops 'this action' (agent-scoped)", () => {
    const got = ids({ ...BASE, governanceReason: "AGENT_SCHEMA_DEFINITION" });
    expect(got).not.toContain("action");
    // The wildcard agent grant and global still widen OTHER actions.
    expect(got).toContain("agent");
    expect(got).toContain("global");
  });

  it("operator mode drops both exact-action grants ('this action' and the exact 'this agent')", () => {
    const opts = deriveGovernanceGrantOptions(
      { ...BASE, governanceReason: "AGENT_SCHEMA_DEFINITION" },
      "operator-any"
    );
    expect(opts.map((o) => o.id)).not.toContain("action");
    expect(opts.find((o) => o.id === "agent")).toBeUndefined();
  });

  it("a context-dependent reason (widenable elsewhere) keeps the option", () => {
    expect(ids({ ...BASE, governanceReason: "UNTRUSTED_ORIGIN" })).toContain(
      "action"
    );
    expect(isNonWidenableGovernanceReason("SCOPE_IDENTITY_CHANGE")).toBe(false);
    expect(isNonWidenableGovernanceReason(null)).toBe(false);
  });
});

describe("deriveGovernanceGrantOptions — the outward floor (finding c173cc51)", () => {
  const RUN: GovernanceGrantContext = {
    ...BASE,
    actionKey: "capability.run",
    capabilityTarget: "messaging://unipile",
  };

  it("pod admin offers no wildcard rule: no 'Everything, always'", () => {
    const opts = deriveGovernanceGrantOptions(BASE, "operator-any");
    expect(opts.map((o) => o.id)).not.toContain("global");
    expect(
      opts.some(
        (o) => o.rule.targetPattern === "*" && o.rule.targetKind === "action"
      )
    ).toBe(false);
  });

  it("control: the desktop menu still offers it", () => {
    expect(ids(BASE)).toContain("global");
  });

  it("a capability run offers the capability, never the generic capability.run action", () => {
    for (const mode of ["agent-scoped", "operator-any"] as const) {
      const opts = deriveGovernanceGrantOptions(RUN, mode);
      expect(opts.map((o) => o.id)).toContain("capability");
      expect(opts.map((o) => o.id)).not.toContain("action");
      expect(opts.some((o) => o.rule.targetPattern === "capability.run")).toBe(
        false
      );
    }
  });

  it("a public post offers no 'this tool': the gate never lets a rule widen it", () => {
    for (const verb of PROPOSE_ONLY_CAPABILITY_VERBS) {
      for (const mode of ["agent-scoped", "operator-any"] as const) {
        expect(
          ids({ ...RUN, capabilityTarget: verb }, mode),
          `${verb} ${mode}`
        ).not.toContain("capability");
      }
    }
  });

  it("a run under a floor no rule widens offers no 'this tool'", () => {
    expect(
      ids({ ...RUN, governanceReason: "ADMIN" }, "operator-any")
    ).not.toContain("capability");
  });
});

describe("deriveGovernanceNeverOption — a request's 'Never' (decision G3)", () => {
  it("writes a deny for this agent and this exact action", () => {
    expect(deriveGovernanceNeverOption(BASE)).toEqual({
      id: "never",
      value: "profile.create",
      rule: {
        principalKind: "agent",
        agentUserId: "agent-1",
        scopeKind: "workspace",
        workspaceId: BASE.workspaceId,
        targetKind: "action",
        targetPattern: "profile.create",
        verdict: "deny",
        sourceProposalId: BASE.proposalId,
      },
    });
  });

  it("a capability run names the capability, never the generic capability.run", () => {
    const never = deriveGovernanceNeverOption({
      ...BASE,
      actionKey: "capability.run",
      capabilityTarget: "messaging://unipile",
    });
    expect(never?.rule).toMatchObject({
      principalKind: "agent",
      agentUserId: "agent-1",
      targetKind: "capability",
      targetPattern: "messaging://unipile",
      verdict: "deny",
    });
    expect(
      deriveGovernanceNeverOption({ ...BASE, actionKey: "capability.run" })
    ).toBeNull();
  });

  it("is offered on a floored request too: a deny refuses above the floors", () => {
    expect(
      deriveGovernanceNeverOption({
        ...BASE,
        governanceReason: "AGENT_SCHEMA_DEFINITION",
      })?.rule.targetPattern
    ).toBe("profile.create");
  });

  it("never a wildcard: no agent, a '*' or a glob action offers nothing", () => {
    expect(
      deriveGovernanceNeverOption({ ...BASE, agentUserId: null })
    ).toBeNull();
    expect(deriveGovernanceNeverOption({ ...BASE, actionKey: "*" })).toBeNull();
    expect(
      deriveGovernanceNeverOption({ ...BASE, actionKey: "entity.*" })
    ).toBeNull();
    expect(
      deriveGovernanceNeverOption({ ...BASE, actionKey: null })
    ).toBeNull();
  });

  it("a request with no space writes a pod-wide deny, still for one agent", () => {
    const never = deriveGovernanceNeverOption({ ...BASE, workspaceId: null });
    expect(never?.rule).toMatchObject({
      scopeKind: "pod",
      principalKind: "agent",
      agentUserId: "agent-1",
    });
    expect(never?.rule.workspaceId).toBeUndefined();
  });
});
