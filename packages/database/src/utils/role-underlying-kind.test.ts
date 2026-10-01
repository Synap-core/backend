import { describe, expect, it } from "vitest";
import {
  pickUnderlyingKind,
  promoteMultiKindRoleCreate,
  subjectHead,
} from "./role-underlying-kind.js";

const JEREMIE =
  "Lead: Jeremie Zarka — President, Elevate Labs (FinTech consulting)";

describe("subjectHead", () => {
  it("drops a role prefix and the aside after a dash", () => {
    expect(subjectHead(JEREMIE)).toBe("Jeremie Zarka");
  });

  it("keeps a hyphen inside a name", () => {
    expect(subjectHead("Jean-Luc Picard")).toBe("Jean-Luc Picard");
  });
});

describe("pickUnderlyingKind", () => {
  const lead = ["company", "person"] as const;

  it("a person-shaped lead is a person, even when company is listed first", () => {
    expect(pickUnderlyingKind(lead, JEREMIE)).toBe("person");
  });

  it("an organization-shaped lead is a company", () => {
    expect(pickUnderlyingKind(lead, "Elevate Labs")).toBe("company");
    expect(pickUnderlyingKind(lead, "Acme Consulting")).toBe("company");
  });

  it("a single applicable kind is that kind", () => {
    expect(pickUnderlyingKind(["person"], "Elevate Labs")).toBe("person");
  });

  it("no applicable kind cannot be invented", () => {
    expect(pickUnderlyingKind([], "Jeremie Zarka")).toBeNull();
    expect(pickUnderlyingKind(null, "Jeremie Zarka")).toBeNull();
  });

  it("a role that is neither person nor company keeps the author's first kind", () => {
    expect(pickUnderlyingKind(["task", "note"], "Q3 plan")).toBe("task");
  });
});

describe("promoteMultiKindRoleCreate", () => {
  it("moves the role's properties onto a facet and retargets the kind", () => {
    const draft = {
      profileSlug: "lead",
      properties: { segment: "FinTech", persona: "President" },
      facets: [] as Array<{
        profileSlug: string;
        properties?: Record<string, unknown>;
      }>,
    };
    expect(
      promoteMultiKindRoleCreate({
        roleSlug: "lead",
        applicableKinds: ["company", "person"],
        title: JEREMIE,
        draft,
      })
    ).toBe("person");
    expect(draft.profileSlug).toBe("person");
    expect(draft.properties).toEqual({});
    expect(draft.facets).toEqual([
      {
        profileSlug: "lead",
        properties: { segment: "FinTech", persona: "President" },
      },
    ]);
  });

  it("a single applicable kind is left for the repository adapter", () => {
    const draft = { profileSlug: "porteur", properties: { brings: "network" } };
    expect(
      promoteMultiKindRoleCreate({
        roleSlug: "porteur",
        applicableKinds: ["person"],
        title: "Ada",
        draft,
      })
    ).toBeNull();
    expect(draft).toEqual({
      profileSlug: "porteur",
      properties: { brings: "network" },
    });
  });

  it("does not add a second facet when the caller already named the role", () => {
    const draft = {
      profileSlug: "lead",
      properties: { notes: "from research" },
      facets: [{ profileSlug: "lead", properties: { notes: "kept" } }],
    };
    promoteMultiKindRoleCreate({
      roleSlug: "lead",
      applicableKinds: ["company", "person"],
      title: "Elevate Labs",
      draft,
    });
    expect(draft.profileSlug).toBe("company");
    expect(draft.facets).toEqual([
      { profileSlug: "lead", properties: { notes: "kept" } },
    ]);
  });
});
