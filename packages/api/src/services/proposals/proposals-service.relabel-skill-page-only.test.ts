/**
 * A revise cannot make a code skill batchable by relabelling it.
 *
 * The hole (backend review F1): an agent files a skill create with code, then
 * revises `{kind: "instruction"}`. The page-only rule read the label, so the
 * proposal fell into every "Approve all", and approving it turned the code on
 * unseen. Two locks, each tested alone: the revise core refuses a change of a
 * skill's `kind`, and the page-only rule reads what the skill carries
 * (`skillRequestExecutes`), so a relabelled payload stays page-only anyway.
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
  it("is refused by the revise core", () => {
    expect(() =>
      computeRevisedEnvelope({
        envelope: codeSkillCreate(),
        patch: { kind: "inner", fields: { kind: "instruction" } },
      })
    ).toThrow(/cannot change a skill's `kind`/);
    expect(() =>
      computeRevisedEnvelope({
        envelope: codeSkillCreate(),
        patch: {
          kind: "envelope",
          fields: { data: { ...codeSkillCreate().data, kind: "instruction" } },
        },
      })
    ).toThrow(/cannot change a skill's `kind`/);
  });

  it("a revise that echoes the same kind, or fixes the code, passes", () => {
    const { merged } = computeRevisedEnvelope({
      envelope: codeSkillCreate(),
      patch: { kind: "inner", fields: { kind: "code", code: "return 2;" } },
    });
    expect((merged.data as Record<string, unknown>).code).toBe("return 2;");
  });

  it("a payload relabelled anyway is still decided on its page, as code", () => {
    // The relabel as it would read had it landed (an older row, another door).
    const relabelled = {
      ...codeSkillCreate(),
      data: { ...codeSkillCreate().data, kind: "instruction" },
    };
    expect(
      proposalPageOnlyReason({
        targetType: "skill",
        proposalType: "create",
        data: relabelled,
      })
    ).toBe("executable_skill");
  });
});
