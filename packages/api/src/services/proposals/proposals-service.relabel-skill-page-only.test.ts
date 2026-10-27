/**
 * A revise cannot make a code skill batchable by relabelling it.
 *
 * The hole (backend review F1): an agent files a skill create with code, then
 * revises `{kind: "instruction"}`. The page-only rule read the label, so the
 * proposal fell into every "Approve all", and approving it turned the code on
 * unseen. The rule now reads what the skill carries (`skillRequestExecutes`).
 * Driven through the shared revise core every revise door uses, then the one
 * page-only rule every approve door reads.
 */
import { describe, expect, it } from "vitest";
import { proposalPageOnlyReason } from "@synap-core/types/proposals";
import { computeRevisedEnvelope } from "./proposals-service.js";

const codeSkillCreate = () => ({
  requestId: "req-skill",
  targetType: "skill",
  changeType: "create",
  data: { name: "scrape_leads", kind: "code", code: "return 1;" },
});

describe("revise {kind: instruction} on a code skill create", () => {
  it("is still decided on its page, as code", () => {
    const { merged } = computeRevisedEnvelope({
      envelope: codeSkillCreate(),
      patch: { kind: "inner", fields: { kind: "instruction" } },
    });
    expect((merged.data as Record<string, unknown>).kind).toBe("instruction");
    expect(
      proposalPageOnlyReason({
        targetType: "skill",
        proposalType: "create",
        data: merged,
      })
    ).toBe("executable_skill");
  });

  it("emptying its code too still leaves a skill create on its page", () => {
    const { merged } = computeRevisedEnvelope({
      envelope: codeSkillCreate(),
      patch: { kind: "inner", fields: { kind: "instruction", code: "" } },
    });
    expect(
      proposalPageOnlyReason({
        targetType: "skill",
        proposalType: "create",
        data: merged,
      })
    ).toBe("acts_on_its_own");
  });
});
