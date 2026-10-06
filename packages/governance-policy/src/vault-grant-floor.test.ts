/**
 * VAULT GRANT FLOOR (2026-10-06 centralisation audit) — an agent's vault grant
 * is ALWAYS a proposal.
 *
 * `vault.grant` is the gate door of POST /vault/secrets/:id/grant. The owner
 * check there passes for an agent key as its linked human, so the floor is the
 * only thing that keeps an agent from handing itself redeem access to its
 * human's secrets. It sits in ADMIN_ACTIONS_LIVE (rung 2): no rule, agent-owned
 * workspace or autoApproveFor entry below it can widen it.
 *
 * Each case pairs the floored door with a CONTROL write the same widener really
 * does execute, so a green row is the floor at work, not an inert input.
 */
import { describe, it, expect } from "vitest";
import {
  ADMIN_ACTIONS_LIVE,
  GATE_WRITE_DOORS,
  decideAgentPolicy,
  nonWidenableFloorFor,
} from "./index.js";

const WIDENERS: Array<[string, Parameters<typeof decideAgentPolicy>[0]]> = [
  [
    "a rung-2.8 rule says auto",
    { subjectType: "", action: "", governanceRuleVerdict: "auto" },
  ],
  [
    "autoApproveFor names it (rung 4)",
    {
      subjectType: "",
      action: "",
      autoApproveFor: ["*.*", "vault.*", "vault.grant", "entity.*"],
    },
  ],
  [
    "agent-owned workspace (rung 3)",
    { subjectType: "", action: "", isAgentOwnedWorkspace: true },
  ],
];

describe("vault.grant — floored for agents", () => {
  it("is a real gate door and a LIVE admin floor", () => {
    expect(Object.keys(GATE_WRITE_DOORS)).toContain("vault/grant");
    expect(ADMIN_ACTIONS_LIVE as readonly string[]).toContain("vault.grant");
  });

  it("is non-widenable: no governance rule can resolve it", () => {
    expect(nonWidenableFloorFor("vault.grant")).toBe("ADMIN");
  });

  it.each(WIDENERS)("proposes when %s", (_label, base) => {
    expect(
      decideAgentPolicy({ ...base, subjectType: "vault", action: "grant" })
    ).toMatchObject({ verdict: "propose", reasonCode: "ADMIN" });
    const control = decideAgentPolicy({
      ...base,
      subjectType: "entity",
      action: "update",
    });
    expect(control.verdict).toBe("execute");
  });
});
