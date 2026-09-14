import { describe, it, expect } from "vitest";
import {
  DIRECT_PROPOSAL_DOORS,
  HUMAN_GATE_EVENT_KEYS,
  decideAgentPolicy,
  nonWidenableFloorFor,
} from "./index.js";

/**
 * A cleanup pack NEVER auto-applies — no governance rule or "always approve"
 * may widen `pod_hygiene/cleanup_pack`.
 *
 * Packs are filed directly by the pod-hygiene cron and never reach
 * `decideAgentPolicy`, so no rule matches one at runtime today. The point this
 * floors is RULE CREATION: `governanceRules.create` refuses any action key
 * `nonWidenableFloorFor` names, and the proposal's rule action key is
 * `${targetType}.${proposalType}`.
 *
 * NOT covered: the relay/browser menu hides "this action" only when the
 * proposal's stored `governanceReason` is non-widenable, and a pack is filed
 * with none — that half needs the pack door to stamp one (see door-g report).
 */

const PACK_KEY = "pod_hygiene.cleanup_pack";

describe("cleanup pack — non-widenable (human gate)", () => {
  it("the pack is a declared direct door, and its key is in the gate list", () => {
    expect(Object.keys(DIRECT_PROPOSAL_DOORS)).toContain(
      "pod_hygiene/cleanup_pack"
    );
    expect(HUMAN_GATE_EVENT_KEYS).toContain(PACK_KEY);
  });

  it("nonWidenableFloorFor names a floor, so governanceRules.create refuses the rule", () => {
    expect(nonWidenableFloorFor(PACK_KEY)).toBe("HUMAN_GATE");
  });

  it("every widening lever at once still proposes", () => {
    const verdict = decideAgentPolicy({
      subjectType: "pod_hygiene",
      action: "cleanup_pack",
      isAgentOwnedWorkspace: true,
      writesRequireProposal: false,
      autoApproveFor: ["*"],
      governanceRuleVerdict: "auto",
      allowDestructiveAutoApprove: true,
    });
    expect(verdict).toMatchObject({
      verdict: "propose",
      reasonCode: "HUMAN_GATE",
    });
  });

  it("does not over-reach: other pod_hygiene keys stay widenable", () => {
    expect(nonWidenableFloorFor("pod_hygiene.cleanup_item")).toBeNull();
  });
});
