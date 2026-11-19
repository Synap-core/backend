import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tripwire for the ONE approval store (founder decisions D2 and D3, 19 Nov
 * 2026, document b387ca45) on top of Option B / D1 (phase 2 D1, ratified
 * 2026-07-27): the `governance_rules` `target_kind: "capability"` row is the
 * ONLY answer to "may this agent run this tool without asking?". An "auto"
 * row runs it, grant or no grant; an "ask first" row or no row asks; a "Never"
 * refuses. A capability grant means only "may use": the gate never reads it.
 * Every floor (approved===false deny, untrusted origin, secret exclusion)
 * stays absolute regardless of the row.
 *
 * `findCapabilityGrantMock` still answers with an ACTIVE AUTO GRANT (the
 * shape the gate read before 0435) and is asserted never called: run against
 * the gate before D2, the "ask first" and "no row" cases below go red,
 * because that gate let the grant's exec mode run them.
 *
 * `getDb`/`eq` (from `@synap/database`) and `resolveGovernanceRule` (from
 * `@synap/database/agent-governance`) are mocked so this stays a pure unit
 * test of the gate's branching — no live DB.
 */

const findCapabilityGrantMock = vi.fn();
const AUTO_GRANT = { ok: true, grantId: "grant-1", execMode: "auto" };
const resolveGovernanceRuleMock = vi.fn();
const resolveOriginTrustMock = vi.fn();

vi.mock("@synap/database", () => ({
  getDb: async () => ({}),
  eq: (a: unknown, b: unknown) => ({ a, b }),
  // Not imported by the gate since D2; mocked so the gate from BEFORE D2
  // (the negative control) reads an active auto grant here.
  findCapabilityGrant: (...args: unknown[]) => findCapabilityGrantMock(...args),
  // No key grant: these runs come from no pod app, so the app outward floor
  // (app-outward-floor.test.ts) never applies here.
  getRequestGrant: () => undefined,
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
    findCapabilityGrantMock.mockResolvedValue(AUTO_GRANT);
    resolveGovernanceRuleMock.mockReset();
    // Default: no channel context → origin-trust no-ops (the common case).
    resolveOriginTrustMock.mockReset();
    resolveOriginTrustMock.mockResolvedValue(undefined);
  });

  it("approved + NO grant + auto rule → run (rule authorizes with no grant at all)", async () => {
    findCapabilityGrantMock.mockResolvedValue({ ok: false, code: "no_grant" });
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
      grantId: "grant-1",
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

  it("D2: an active AUTO grant + an 'ask first' row on the tool → propose (a stored ask-first now asks)", async () => {
    // The contradiction D2 closes: before it, the grant's exec mode ran this
    // and the propose row was never read.
    resolveGovernanceRuleMock.mockResolvedValue({
      verdict: "propose",
      matchedPattern: "tool-123",
    });

    const decision = await gateCapabilityExecution(BASE_INPUT);

    expect(decision).toMatchObject({
      decision: "propose",
      reasonCode: "CAPABILITY_PROPOSE",
    });
    expect(findCapabilityGrantMock).not.toHaveBeenCalled();
  });

  it("D2: an active AUTO grant and NO row → propose (a grant only means may-use)", async () => {
    resolveGovernanceRuleMock.mockResolvedValue(undefined);

    const decision = await gateCapabilityExecution(BASE_INPUT);

    expect(decision.decision).toBe("propose");
    expect(findCapabilityGrantMock).not.toHaveBeenCalled();
  });

  it("D2: a legacy dry-run grant is not read — the auto row decides", async () => {
    findCapabilityGrantMock.mockResolvedValue({
      ok: true,
      grantId: "grant-1",
      execMode: "dry-run",
    });
    resolveGovernanceRuleMock.mockResolvedValue({
      verdict: "auto",
      matchedPattern: "tool-123",
    });

    const decision = await gateCapabilityExecution(BASE_INPUT);

    expect(decision).toEqual({ decision: "run" });
    expect(findCapabilityGrantMock).not.toHaveBeenCalled();
  });

  it("PIN: an auto row runs in a can_act=false channel (the channel rung is not applied to a row)", async () => {
    // Lead's default for W1 (founder decides at review): an auto RULE never
    // met policy rung 7, and can_act=false is on nearly every agent
    // membership. The beforeEach's ACTIVE AUTO GRANT makes this red on the
    // gate before D2, whose grant path sent the run through rung 7.
    resolveGovernanceRuleMock.mockResolvedValue({
      verdict: "auto",
      matchedPattern: "tool-123",
    });

    const decision = await gateCapabilityExecution({
      ...BASE_INPUT,
      channelCapabilities: { canDraft: true, canPropose: true, canAct: false },
    });

    expect(decision).toEqual({ decision: "run" });
  });

  it("D3: the lookup asks for the tools this action belongs to (a row on the tool covers it)", async () => {
    resolveGovernanceRuleMock.mockResolvedValue(undefined);

    await gateCapabilityExecution(BASE_INPUT);

    expect(resolveGovernanceRuleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilityId: "tool-123",
        capabilityKind: "tool",
      })
    );
  });

  it("no grant + no matching rule → propose (unchanged fallback)", async () => {
    findCapabilityGrantMock.mockResolvedValue({ ok: false, code: "no_grant" });
    resolveGovernanceRuleMock.mockResolvedValue(undefined);

    const decision = await gateCapabilityExecution(BASE_INPUT);

    expect(decision.decision).toBe("propose");
  });

  it("revoked/expired rule (resolver returns undefined) + propose-mode grant → propose", async () => {
    findCapabilityGrantMock.mockResolvedValue({
      ok: true,
      grantId: "grant-1",
      execMode: "propose",
    });
    resolveGovernanceRuleMock.mockResolvedValue(undefined);

    const decision = await gateCapabilityExecution(BASE_INPUT);

    expect(decision.decision).toBe("propose");
  });

  it("secret grantable + auto rule → rule ignored, still propose (never mints secret decrypt)", async () => {
    findCapabilityGrantMock.mockResolvedValue({ ok: false, code: "no_grant" });
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
    findCapabilityGrantMock.mockResolvedValue({ ok: false, code: "no_grant" });
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
    findCapabilityGrantMock.mockResolvedValue({ ok: false, code: "no_grant" });
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
 * into an auto-run by an "auto" approval row — since D2 the only widening a
 * capability run has. `channelId` is passed so the
 * gate calls `resolveOriginTrust`, which the mock forces to "untrusted".
 */
describe("gateCapabilityExecution — untrusted origin (#4 provenance)", () => {
  beforeEach(() => {
    findCapabilityGrantMock.mockReset();
    findCapabilityGrantMock.mockResolvedValue(AUTO_GRANT);
    resolveGovernanceRuleMock.mockReset();
    resolveOriginTrustMock.mockReset();
  });

  const UNTRUSTED_INPUT = { ...BASE_INPUT, channelId: "chan-external-1" };

  it("untrusted origin + NO grant + auto rule → propose (rule can't widen an untrusted origin)", async () => {
    resolveOriginTrustMock.mockResolvedValue("untrusted");
    findCapabilityGrantMock.mockResolvedValue({ ok: false, code: "no_grant" });
    resolveGovernanceRuleMock.mockResolvedValue({
      verdict: "auto",
      matchedPattern: "tool-123",
    });

    const decision = await gateCapabilityExecution(UNTRUSTED_INPUT);

    expect(decision.decision).toBe("propose");
    // The rule shortcut is skipped entirely for an untrusted origin (rung 2.55
    // sits above the capability rule rung 2.8) — it is consulted only by the
    // "Never" check (0.2), which can only refuse.
    expect(resolveGovernanceRuleMock).toHaveBeenCalledTimes(1);
  });

  it("untrusted origin + an auto row and an auto grant → propose (nothing auto-runs an untrusted origin)", async () => {
    resolveOriginTrustMock.mockResolvedValue("untrusted");
    resolveGovernanceRuleMock.mockResolvedValue({
      verdict: "auto",
      matchedPattern: "tool-123",
    });

    const decision = await gateCapabilityExecution(UNTRUSTED_INPUT);

    expect(decision).toMatchObject({
      decision: "propose",
      reasonCode: "UNTRUSTED_ORIGIN",
    });
  });

  it("TRUSTED origin + an auto row → run (a trusted channel never tightens)", async () => {
    resolveOriginTrustMock.mockResolvedValue("trusted");
    resolveGovernanceRuleMock.mockResolvedValue({
      verdict: "auto",
      matchedPattern: "tool-123",
    });

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

  it("no row names CAPABILITY_PROPOSE", async () => {
    findCapabilityGrantMock.mockResolvedValue({ ok: false, code: "no_grant" });
    resolveGovernanceRuleMock.mockResolvedValue(undefined);

    const decision = await gateCapabilityExecution(BASE_INPUT);

    expect(decision.decision).toBe("propose");
    expect(decision.decision === "propose" ? decision.reasonCode : null).toBe(
      "CAPABILITY_PROPOSE"
    );
  });

  it("an UNTRUSTED origin names the FLOOR, not the generic cause", async () => {
    findCapabilityGrantMock.mockResolvedValue({ ok: false, code: "no_grant" });
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
    // A person who does not own the tool, inside a channel that may only
    // propose: the policy's rung 7 names CHANNEL_PROPOSE, which the gate
    // carries through.
    const decision = await gateCapabilityExecution({
      ...BASE_INPUT,
      actorUserId: "person-2",
      agentUserId: null,
      channelCapabilities: { canDraft: true, canPropose: true, canAct: false },
    });

    expect(decision.decision).toBe("propose");
    const code = decision.decision === "propose" ? decision.reasonCode : null;
    expect(
      code,
      "a propose decision must never reach review with no cause"
    ).toBe("CHANNEL_PROPOSE");
  });
});

/**
 * A person's "Never" (a founder decision, 0381): a `deny` rule naming this
 * capability refuses the agent's run, typed, before every other rung — a
 * declared read and an auto rule included (ranked: a MORE specific auto row
 * outranks a broad Never, `resolveGovernanceRule`).
 */
describe("gateCapabilityExecution — a deny rule refuses the run", () => {
  beforeEach(() => {
    findCapabilityGrantMock.mockReset();
    resolveGovernanceRuleMock.mockReset();
    resolveOriginTrustMock.mockReset();
    resolveOriginTrustMock.mockResolvedValue(undefined);
  });

  const DENIED = {
    decision: "deny",
    reasonCode: "DENIED_BY_RULE",
  };

  it("control: an auto row runs when no rule says never", async () => {
    resolveGovernanceRuleMock.mockResolvedValue({
      verdict: "auto",
      matchedPattern: "tool-123",
    });
    expect(await gateCapabilityExecution(BASE_INPUT)).toEqual({
      decision: "run",
    });
  });

  it("an auto grant + a deny rule → refused, typed", async () => {
    findCapabilityGrantMock.mockResolvedValue(AUTO_GRANT);
    resolveGovernanceRuleMock.mockResolvedValue({
      verdict: "deny",
      matchedPattern: "tool-123",
    });
    const decision = await gateCapabilityExecution(BASE_INPUT);
    expect(decision).toMatchObject(DENIED);
    expect(decision.decision === "deny" && decision.reason).toMatch(
      /^DENIED_BY_RULE:/
    );
    // The gate never looks a grant up.
    expect(findCapabilityGrantMock).not.toHaveBeenCalled();
  });

  it("a declared read is refused too", async () => {
    resolveGovernanceRuleMock.mockResolvedValue({
      verdict: "deny",
      matchedPattern: "tool-123",
    });
    expect(
      await gateCapabilityExecution({ ...BASE_INPUT, readOnly: true })
    ).toMatchObject(DENIED);
  });

  it("the lookup names the capability (verb name and row id)", async () => {
    resolveGovernanceRuleMock.mockResolvedValue({ verdict: "deny" });
    await gateCapabilityExecution({
      ...BASE_INPUT,
      tool: {
        id: "tool-123",
        approved: true,
        createdBy: "owner-1",
        name: "send_email",
      },
    });
    expect(resolveGovernanceRuleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentUserId: "agent-1",
        capabilityId: "tool-123",
        capabilityVerbName: "send_email",
      })
    );
  });

  it("the person's own run never consults the rules", async () => {
    resolveGovernanceRuleMock.mockResolvedValue({ verdict: "deny" });
    expect(
      await gateCapabilityExecution({
        ...BASE_INPUT,
        actorUserId: "owner-1",
        agentUserId: null,
      })
    ).toEqual({ decision: "run" });
    expect(resolveGovernanceRuleMock).not.toHaveBeenCalled();
  });

  it("an unapproved capability still meets the approval floor first", async () => {
    resolveGovernanceRuleMock.mockResolvedValue({ verdict: "deny" });
    const decision = await gateCapabilityExecution({
      ...BASE_INPUT,
      tool: { id: "tool-123", approved: false, createdBy: "owner-1" },
    });
    expect(decision.decision).toBe("deny");
    expect(decision).not.toHaveProperty("reasonCode");
  });
});

/**
 * One rule read per run: the "Never" refusal and the rule widening rank the
 * SAME stored rows, so the gate reads them once and derives both answers.
 * Every route that consults a rule is driven here, and each reads it once.
 */
describe("gateCapabilityExecution — one rule lookup per run", () => {
  beforeEach(() => {
    findCapabilityGrantMock.mockReset();
    resolveGovernanceRuleMock.mockReset();
    resolveOriginTrustMock.mockReset();
    resolveOriginTrustMock.mockResolvedValue(undefined);
  });

  const AUTO_RULE = { verdict: "auto", matchedPattern: "tool-123" };

  it("no grant + an auto rule: run, from one lookup", async () => {
    findCapabilityGrantMock.mockResolvedValue({ ok: false, code: "no_grant" });
    resolveGovernanceRuleMock.mockResolvedValue(AUTO_RULE);
    expect(await gateCapabilityExecution(BASE_INPUT)).toEqual({
      decision: "run",
    });
    expect(resolveGovernanceRuleMock).toHaveBeenCalledTimes(1);
  });

  it("a propose-mode grant + an auto rule: run, from one lookup", async () => {
    findCapabilityGrantMock.mockResolvedValue({
      ok: true,
      grantId: "grant-1",
      execMode: "propose",
    });
    resolveGovernanceRuleMock.mockResolvedValue(AUTO_RULE);
    expect(await gateCapabilityExecution(BASE_INPUT)).toEqual({
      decision: "run",
    });
    expect(resolveGovernanceRuleMock).toHaveBeenCalledTimes(1);
  });

  it("no grant + no rule: propose, from one lookup", async () => {
    findCapabilityGrantMock.mockResolvedValue({ ok: false, code: "no_grant" });
    resolveGovernanceRuleMock.mockResolvedValue(undefined);
    expect((await gateCapabilityExecution(BASE_INPUT)).decision).toBe(
      "propose"
    );
    expect(resolveGovernanceRuleMock).toHaveBeenCalledTimes(1);
  });

  it("a deny rule refuses from that same one lookup", async () => {
    findCapabilityGrantMock.mockResolvedValue({ ok: false, code: "no_grant" });
    resolveGovernanceRuleMock.mockResolvedValue({ verdict: "deny" });
    expect(await gateCapabilityExecution(BASE_INPUT)).toMatchObject({
      decision: "deny",
      reasonCode: "DENIED_BY_RULE",
    });
    expect(resolveGovernanceRuleMock).toHaveBeenCalledTimes(1);
  });
});
