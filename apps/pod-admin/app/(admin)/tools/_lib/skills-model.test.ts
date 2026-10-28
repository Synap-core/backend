import { describe, expect, it } from "vitest";
import { skillLists, skillRow, type SkillListRow } from "./skills-model";

function skill(over: Partial<SkillListRow> = {}): SkillListRow {
  return {
    id: "s1",
    name: "Dogfood journal",
    slug: "rules/dogfood-journal",
    kind: "instruction",
    workspaceId: null,
    body: "# Dogfood journal\n\nFile what you hit.",
    approved: false,
    createdAt: "2026-10-28T00:16:00.000Z",
    ...over,
  };
}

describe("skillRow — how a skill that is off is turned on", () => {
  it("an instruction skill is turned on here, drawn whole (its instructions)", () => {
    const row = skillRow(skill());
    expect(row.turnOn).toBe("here");
    expect(row.slug).toBe("rules/dogfood-journal");
    const instructions = row.record?.fields.find(
      (f) => f.key === "instructions"
    );
    // Whole, never excerpted: the full prose reaches the confirmation.
    expect(instructions?.after).toMatchObject({
      text: "# Dogfood journal\n\nFile what you hit.",
    });
  });
  it("a code skill is turned on where its reach is shown, never from this list (wrong rule: every off skill gets the button)", () => {
    const row = skillRow(skill({ kind: "code", body: null }));
    expect(row.turnOn).toBe("elsewhere");
    expect(row.record).toBeNull();
  });
  it("a skill already on offers nothing to turn on", () => {
    const row = skillRow(skill({ approved: true }));
    expect(row.turnOn).toBeNull();
    expect(row.record).toBeNull();
  });
  it("a skill with no space is the whole pod's only when scoped so (wrong rule: no space = whole pod)", () => {
    expect(skillRow(skill({ scope: "user" })).scope).toBe("user");
    expect(skillRow(skill({ scope: "pod" })).scope).toBe("pod");
    expect(skillRow(skill({ workspaceId: "w1", scope: null })).scope).toBe(
      "workspace"
    );
  });
  it("instructions kept in a document say where they are", () => {
    const row = skillRow(skill({ body: null, bodyDocumentId: "d1" }));
    expect(row.turnOn).toBe("here");
    expect(row.bodyDocumentId).toBe("d1");
  });
});

describe("skillLists — waiting first, the longest wait on top", () => {
  it("orders the waiting oldest first (wrong rule: the pod's newest-first order)", () => {
    const { waiting } = skillLists(
      [
        skill({ id: "new", createdAt: "2026-10-28T09:00:00.000Z" }),
        skill({ id: "old", createdAt: "2026-10-20T09:00:00.000Z" }),
      ],
      []
    );
    expect(waiting.map((s) => s.id)).toEqual(["old", "new"]);
  });
  it("a skill turned on between the two reads is drawn once, as on", () => {
    const lists = skillLists(
      [skill({ id: "moved" })],
      [skill({ id: "moved", approved: true })]
    );
    expect(lists.waiting).toEqual([]);
    expect(lists.on.map((s) => s.id)).toEqual(["moved"]);
  });
});
