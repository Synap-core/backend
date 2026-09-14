/**
 * D3 preflight — a playbook names the draft skills it depends on BEFORE it runs.
 *
 * The goal fixture is the live "Research a Question" goal (pod, 2026-09-14),
 * verbatim in the parts that name skills. Each skill row is there to rule out a
 * specific wrong rule — see the comment on it.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../links/links-service.js", () => ({
  getLinksFor: async () => [
    {
      linkType: "grants",
      fromType: "playbook",
      toType: "skill",
      toId: "s-granted",
    },
  ],
  resolveGrantedCapabilities: async () => [{ kind: "skill", id: "s-granted" }],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: {
      select: () => ({
        from: () => ({ where: async () => SKILLS }),
      }),
    },
  };
});

const GOAL =
  "Investigate the question {question} and record the WHOLE investigation, not just the answer. " +
  "Steps: (1) Use the source-triage skill to gather sources widely via web search, classify each by type and credibility. " +
  "(3) Use the evidence-synthesis skill to weigh the supporting vs contradicting sources. " +
  "(4) Use the concept-cartography skill to place the findings onto the knowledge map. " +
  "(5) Create the `research` entity that `investigates` the question.";

const SKILLS = [
  // draft + named → reported
  { id: "s-triage", name: "source-triage", approved: false },
  { id: "s-evidence", name: "evidence-synthesis", approved: false },
  // enabled + named → NOT reported (rules out "every named skill")
  { id: "s-carto", name: "concept-cartography", approved: true },
  // draft, one-word name that appears in prose → NOT reported (rules out bare word matching)
  { id: "s-research", name: "research", approved: false },
  // draft, name only a PREFIX-extension of a mention → NOT reported (rules out substring matching)
  { id: "s-triage-v2", name: "source-triage-v2", approved: false },
  // draft twin of an enabled row with the same name → NOT reported (the execute door picks the enabled one)
  { id: "s-carto-draft", name: "concept-cartography", approved: false },
  // draft, never named, but GRANTED by id → reported (rules out prose-only)
  { id: "s-granted", name: "planner", approved: false },
];

const {
  selectUnenabledPlaybookSkills,
  goalMentionsSkill,
  findUnenabledPlaybookSkills,
} = await import("./playbook-skill-preflight.js");

describe("playbook skill preflight", () => {
  it("names exactly the draft skills the goal uses or the playbook grants", () => {
    const out = selectUnenabledPlaybookSkills({
      goalTemplate: GOAL,
      grantedSkillIds: new Set(["s-granted"]),
      visibleSkills: SKILLS,
    });
    expect(out.map((s) => s.name)).toEqual([
      "evidence-synthesis",
      "planner",
      "source-triage",
    ]);
  });

  it("token matching holds at sentence punctuation and not inside longer identifiers", () => {
    expect(goalMentionsSkill("then use source-triage.", "source-triage")).toBe(
      true
    );
    expect(goalMentionsSkill("(source-triage)", "source-triage")).toBe(true);
    expect(goalMentionsSkill("use my-source-triage", "source-triage")).toBe(
      false
    );
    expect(goalMentionsSkill("use source-triage.v2", "source-triage")).toBe(
      false
    );
  });

  it("the async door reads grants + visible skills and returns the same verdict", async () => {
    const out = await findUnenabledPlaybookSkills({
      playbook: { id: "pb-1", goalTemplate: GOAL },
      userId: "u-1",
      workspaceId: "ws-1",
    });
    expect(out.map((s) => s.id)).toEqual([
      "s-evidence",
      "s-granted",
      "s-triage",
    ]);
  });
});
