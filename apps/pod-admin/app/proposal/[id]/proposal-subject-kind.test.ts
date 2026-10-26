import { describe, expect, it } from "vitest";
import {
  proposalProfileSlug,
  proposalSubjectKind,
} from "./proposal-subject-kind";

describe("proposalSubjectKind — the kind a proposal is about", () => {
  it("names an entity by its profile slug, else its type", () => {
    expect(
      proposalSubjectKind({ targetType: "entity" }, { profileSlug: " task " })
    ).toBe("task");
    expect(
      proposalSubjectKind({ targetType: "entity" }, { type: "note" })
    ).toBe("note");
  });
  it("keeps the targetType when the payload names no kind, or the target is not an entity", () => {
    expect(proposalSubjectKind({ targetType: "entity" }, {})).toBe("entity");
    expect(proposalSubjectKind({ targetType: "entity" }, null)).toBe("entity");
    expect(
      proposalSubjectKind({ targetType: "view" }, { profileSlug: "task" })
    ).toBe("view");
  });
  it("reads no slug from a blank or non-string field", () => {
    expect(proposalProfileSlug({ profileSlug: "  ", type: 3 })).toBeNull();
  });
});
