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
const resolveOriginTrustMock = vi.fn();

vi.mock("@synap/database", () => ({
  getDb: async () => ({}),
  eq: (a: unknown, b: unknown) => ({ a, b }),
  findCapabilityGrant: (...args: unknown[]) => findCapabilityGrantMock(...args),
}));

vi.mock("@synap/database/agent-governance", () => ({
  resolveGovernanceRule: (...args: unknown[]) =>
    resolveGovernanceRuleMock(...args),
  // #4 instruction-provenance (rung 2.55): the gate resolves the acting
  // channel's origin trust for every agent run. Default: `undefined` (no channel
  // context → tighten-only no-op), so the pre-existing rule/grant cases are
  // unaffected; the origin-trust cases below override it to "untrusted".
  resolveOriginTrust: (...args: unknown[]) => resolveOriginTrustMock(...args),
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
    // Default: no channel context → origin-trust no-ops (the common case).
    resolveOriginTrustMock.mockReset();
    resolveOriginTrustMock.mockResolvedValue(undefined);
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

/**
 * #4 instruction-provenance (rung 2.55) on the CAPABILITY-RUN path. The pure
 * engine's rung 2.55 (untrusted origin > every rung below) is proven in
 * governance-policy/policy.test.ts; these tripwires prove the GATE threads the
 * resolved origin trust so an untrusted-origin channel can never be laundered
 * into an auto-run by an "auto" governance rule OR an "auto" grant exec-mode —
 * the two widening shortcuts a capability run has. `channelId` is passed so the
 * gate calls `resolveOriginTrust`, which the mock forces to "untrusted".
 */
describe("gateCapabilityExecution — untrusted origin (#4 provenance)", () => {
  beforeEach(() => {
    findCapabilityGrantMock.mockReset();
    resolveGovernanceRuleMock.mockReset();
    resolveOriginTrustMock.mockReset();
  });

  const UNTRUSTED_INPUT = { ...BASE_INPUT, channelId: "chan-external-1" };

  it("untrusted origin + NO grant + auto rule → propose (rule can't widen an untrusted origin)", async () => {
    resolveOriginTrustMock.mockResolvedValue("untrusted");
    findCapabilityGrantMock.mockResolvedValue({ ok: false });
    resolveGovernanceRuleMock.mockResolvedValue({
      verdict: "auto",
      matchedPattern: "tool-123",
    });

    const decision = await gateCapabilityExecution(UNTRUSTED_INPUT);

    expect(decision.decision).toBe("propose");
    // The rule shortcut is skipped entirely for an untrusted origin (rung 2.55
    // sits above the capability rule rung 2.8) — it is never even consulted.
    expect(resolveGovernanceRuleMock).not.toHaveBeenCalled();
  });

  it("untrusted origin + auto-mode grant → propose (grant exec-mode can't auto-run an untrusted origin)", async () => {
    resolveOriginTrustMock.mockResolvedValue("untrusted");
    findCapabilityGrantMock.mockResolvedValue({ ok: true, execMode: "auto" });

    const decision = await gateCapabilityExecution(UNTRUSTED_INPUT);

    expect(decision.decision).toBe("propose");
  });

  it("TRUSTED origin + auto-mode grant → run (a trusted channel never tightens)", async () => {
    resolveOriginTrustMock.mockResolvedValue("trusted");
    findCapabilityGrantMock.mockResolvedValue({ ok: true, execMode: "auto" });

    const decision = await gateCapabilityExecution(UNTRUSTED_INPUT);

    expect(decision).toEqual({ decision: "run" });
  });

  it("untrusted origin still cannot cross the approval DENY floor (floor > rung 2.55)", async () => {
    resolveOriginTrustMock.mockResolvedValue("untrusted");

    const decision = await gateCapabilityExecution({
      ...UNTRUSTED_INPUT,
      tool: { id: "tool-123", approved: false, createdBy: "owner-1" },
    });

    // approved===false denies BEFORE origin trust is even resolved.
    expect(decision.decision).toBe("deny");
    expect(resolveOriginTrustMock).not.toHaveBeenCalled();
  });
});

/**
 * Every propose decision must name WHY. Measured on the live pod 2026-09-01:
 * 620 of 680 pending proposals carried no `governance_reason` at all, because
 * this gate never produced one — `createPendingProposal` had forwarded the
 * field all along, and the dominant producer simply never populated it.
 *
 * This matters at review time far more than it looks. The cluster fingerprint
 * keys on `targetId` (the capability), so an UNTRUSTED_ORIGIN run — rung 2.55,
 * the prompt-injection floor — folds into a cluster of hundreds of routine runs
 * and becomes invisible. A reviewer approving that group would sweep in the one
 * item the floor exists to surface.
 */
describe("propose decisions carry a structured cause", () => {
  // A separate top-level `describe` does NOT inherit the block above's
  // `beforeEach`, so without this the origin-trust mock keeps whatever the
  // previous test left and every case here silently reads as untrusted.
  beforeEach(() => {
    findCapabilityGrantMock.mockReset();
    resolveGovernanceRuleMock.mockReset();
    resolveOriginTrustMock.mockReset();
    resolveOriginTrustMock.mockResolvedValue(undefined);
  });

  it("no-grant route names CAPABILITY_PROPOSE", async () => {
    findCapabilityGrantMock.mockResolvedValue({ ok: false });
    resolveGovernanceRuleMock.mockResolvedValue(undefined);

    const decision = await gateCapabilityExecution(BASE_INPUT);

    expect(decision.decision).toBe("propose");
    expect(decision.decision === "propose" ? decision.reasonCode : null).toBe(
      "CAPABILITY_PROPOSE"
    );
  });

  it("an UNTRUSTED origin on the no-grant route names the FLOOR, not the generic cause", async () => {
    findCapabilityGrantMock.mockResolvedValue({ ok: false });
    // An auto rule that WOULD widen — rung 2.55 sits above rung 2.8, so it
    // must neither run the call nor let the generic reason mask the floor.
    resolveGovernanceRuleMock.mockResolvedValue({
      verdict: "auto",
      matchedPattern: "any",
    });

    resolveOriginTrustMock.mockResolvedValue("untrusted");

    const decision = await gateCapabilityExecution(BASE_INPUT);

    expect(
      decision.decision,
      "an untrusted origin can never be widened to run"
    ).toBe("propose");
    expect(
      decision.decision === "propose" ? decision.reasonCode : null,
      "the prompt-injection floor must be nameable at review time — this is the " +
        "signal a grouped approval would otherwise swallow"
    ).toBe("UNTRUSTED_ORIGIN");
  });

  it("the policy route carries the verdict's OWN code rather than re-deriving it", async () => {
    findCapabilityGrantMock.mockResolvedValue({
      ok: true,
      execMode: "propose",
    });
    resolveGovernanceRuleMock.mockResolvedValue(undefined);

    const decision = await gateCapabilityExecution(BASE_INPUT);

    expect(decision.decision).toBe("propose");
    const code = decision.decision === "propose" ? decision.reasonCode : null;
    expect(
      code,
      "a propose decision must never reach review with no cause"
    ).toBeTruthy();
  });
});
