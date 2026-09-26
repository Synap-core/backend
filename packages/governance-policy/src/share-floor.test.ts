/**
 * SHARING FLOOR (Sites W2 S3) — an agent's share is ALWAYS a proposal.
 *
 * `share.create` is the ONE gate door every owner share door files under
 * (tRPC `shares.share`, Hub REST `POST /shares`, the `relations.exposeToAnchor`
 * alias). It sits in ADMIN_ACTIONS_LIVE (rung 2), so every widening rung below
 * it — a rung-2.8 `governance_rules` row, a rung-3 agent-owned workspace, a
 * rung-4 `autoApproveFor` entry, rung 8's DEFAULT_AUTO_APPROVE — is unreachable.
 *
 * Each case below is an input under which a NON-floored key executes (the
 * control column proves it), so each one rules out "the floor is missing".
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
      autoApproveFor: ["*.*", "share.*", "share.create", "entity.*"],
    },
  ],
  [
    "agent-owned workspace (rung 3)",
    { subjectType: "", action: "", isAgentOwnedWorkspace: true },
  ],
];

describe("share.create — the owner share door, floored for agents", () => {
  it("is a real gate door and a LIVE admin floor", () => {
    expect(Object.keys(GATE_WRITE_DOORS)).toContain("share/create");
    expect(ADMIN_ACTIONS_LIVE as readonly string[]).toContain("share.create");
  });

  it("is non-widenable: no governance rule can resolve it", () => {
    expect(nonWidenableFloorFor("share.create")).toBe("ADMIN");
  });

  it.each(WIDENERS)("proposes when %s", (_label, base) => {
    const shared = decideAgentPolicy({
      ...base,
      subjectType: "share",
      action: "create",
    });
    expect(shared).toMatchObject({ verdict: "propose", reasonCode: "ADMIN" });
    // CONTROL — the same widener really does execute an ordinary write, so the
    // row above is the floor at work, not an input that widens nothing.
    const control = decideAgentPolicy({
      ...base,
      subjectType: "entity",
      action: "update",
    });
    expect(control.verdict).toBe("execute");
  });

  it("proposes with no rule at all (rung 9 would too, but the reason names the floor)", () => {
    expect(
      decideAgentPolicy({ subjectType: "share", action: "create" })
    ).toMatchObject({ verdict: "propose", reasonCode: "ADMIN" });
  });
});
