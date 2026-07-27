import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tripwire for Option B / D1 (GOVERNANCE-PHASE2-PLAN.md §1, ratified
 * 2026-07-27): a `governance_rules` `target_kind: "capability"` row must now
 * be consulted by `gateCapabilityExecution` at BOTH points it would otherwise
 * return `propose` — the no-grant route and the policy-propose fallthrough —
 * while every floor (approved===false deny, dry-run, secret exclusion) stays
 * absolute regardless of the rule.
 *
 * `getDb`/`eq`/`findCapabilityGrant` (from `@synap/database`) and
 * `resolveGovernanceRule` (from `@synap/database/agent-governance`) are
 * mocked so this stays a pure unit test of the gate's branching — no live DB.
 */

const findCapabilityGrantMock = vi.fn();
const resolveGovernanceRuleMock = vi.fn();

vi.mock("@synap/database", () => ({
  getDb: async () => ({}),
  eq: (a: unknown, b: unknown) => ({ a, b }),
  findCapabilityGrant: (...args: unknown[]) => findCapabilityGrantMock(...args),
}));

vi.mock("@synap/database/agent-governance", () => ({
  resolveGovernanceRule: (...args: unknown[]) =>
    resolveGovernanceRuleMock(...args),
}));

vi.mock("@synap/database/schema", () => ({
  tools: {},
  skills: {},
}));

const { gateCapabilityExecution } = await import("./index.js");

const BASE_INPUT = {
  capabilityKind: "tool" as const,
  capabilityId: "tool-123",
  tool: { id: "tool-123", approved: true, createdBy: "owner-1" },
  actorUserId: "agent-1",
  agentUserId: "agent-1",
  workspaceId: "ws-1",
};

describe("gateCapabilityExecution — capability rule consultation (Option B)", () => {
  beforeEach(() => {
    findCapabilityGrantMock.mockReset();
    resolveGovernanceRuleMock.mockReset();
  });

  it("approved + NO grant + auto rule → run (rule authorizes with no grant at all)", async () => {
    findCapabilityGrantMock.mockResolvedValue({ ok: false });
    resolveGovernanceRuleMock.mockResolvedValue({
      verdict: "auto",
      matchedPattern: "tool-123",
    });

    const decision = await gateCapabilityExecution(BASE_INPUT);

    expect(decision).toEqual({ decision: "run" });
    expect(resolveGovernanceRuleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentUserId: "agent-1",
        workspaceId: "ws-1",
        capabilityId: "tool-123",
      })
    );
  });

  it("approved + propose-mode grant + auto rule → run", async () => {
    findCapabilityGrantMock.mockResolvedValue({
      ok: true,
      execMode: "propose",
    });
    resolveGovernanceRuleMock.mockResolvedValue({
      verdict: "auto",
      matchedPattern: "tool-123",
    });

    const decision = await gateCapabilityExecution(BASE_INPUT);

    expect(decision).toEqual({ decision: "run" });
  });

  it("UNAPPROVED + auto rule → still DENY (deny floor is absolute)", async () => {
    const decision = await gateCapabilityExecution({
      ...BASE_INPUT,
      tool: { id: "tool-123", approved: false, createdBy: "owner-1" },
    });

    expect(decision.decision).toBe("deny");
    // The deny floor returns before any grant/rule lookup at all.
    expect(findCapabilityGrantMock).not.toHaveBeenCalled();
    expect(resolveGovernanceRuleMock).not.toHaveBeenCalled();
  });

  it("dry-run grant + auto rule → still dry-run (a rule can never override dry-run)", async () => {
    findCapabilityGrantMock.mockResolvedValue({
      ok: true,
      execMode: "dry-run",
    });
    resolveGovernanceRuleMock.mockResolvedValue({
      verdict: "auto",
      matchedPattern: "tool-123",
    });

    const decision = await gateCapabilityExecution(BASE_INPUT);

    expect(decision).toEqual({ decision: "dry-run" });
    // dry-run short-circuits before the policy-propose rule consultation —
    // the rule lookup only ever happens on the no-grant route, which never
    // fires here because a grant exists.
    expect(resolveGovernanceRuleMock).not.toHaveBeenCalled();
  });

  it("no grant + no matching rule → propose (unchanged fallback)", async () => {
    findCapabilityGrantMock.mockResolvedValue({ ok: false });
    resolveGovernanceRuleMock.mockResolvedValue(undefined);

    const decision = await gateCapabilityExecution(BASE_INPUT);

    expect(decision.decision).toBe("propose");
  });

  it("revoked/expired rule (resolver returns undefined) + propose-mode grant → propose", async () => {
    findCapabilityGrantMock.mockResolvedValue({
      ok: true,
      execMode: "propose",
    });
    resolveGovernanceRuleMock.mockResolvedValue(undefined);

    const decision = await gateCapabilityExecution(BASE_INPUT);

    expect(decision.decision).toBe("propose");
  });

  it("secret grantable + auto rule → rule ignored, no grant means still propose (never mints secret decrypt)", async () => {
    findCapabilityGrantMock.mockResolvedValue({ ok: false });
    resolveGovernanceRuleMock.mockResolvedValue({
      verdict: "auto",
      matchedPattern: "secret-123",
    });

    // `capabilityKind: "secret"` is not constructible under `CapabilityRunKind`
    // — cast to prove the runtime defence-in-depth guard holds even if the
    // type were bypassed (e.g. a future widening or an `as any` call site).
    const decision = await gateCapabilityExecution({
      ...BASE_INPUT,
      capabilityKind: "secret" as never,
      capabilityId: "secret-123",
    });

    expect(decision.decision).toBe("propose");
    // The rule is never even queried for a secret grantable.
    expect(resolveGovernanceRuleMock).not.toHaveBeenCalled();
  });

  it("threads the tool row's stable NAME through to resolveGovernanceRule as capabilityVerbName (2026-07-27)", async () => {
    findCapabilityGrantMock.mockResolvedValue({ ok: false });
    resolveGovernanceRuleMock.mockResolvedValue(undefined);

    await gateCapabilityExecution({
      ...BASE_INPUT,
      tool: {
        id: "tool-123",
        approved: true,
        createdBy: "owner-1",
        name: "unipile_list_accounts",
      },
    });

    expect(resolveGovernanceRuleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilityId: "tool-123",
        capabilityVerbName: "unipile_list_accounts",
      })
    );
  });

  it("a 'propose' verdict rule (not auto) never widens — still propose", async () => {
    findCapabilityGrantMock.mockResolvedValue({ ok: false });
    resolveGovernanceRuleMock.mockResolvedValue({
      verdict: "propose",
      matchedPattern: "tool-123",
    });

    const decision = await gateCapabilityExecution(BASE_INPUT);

    expect(decision.decision).toBe("propose");
  });
});
