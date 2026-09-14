import { describe, it, expect } from "vitest";
import {
  deriveGovernanceGrantOptions,
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
