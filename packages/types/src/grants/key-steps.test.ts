import { describe, expect, it } from "vitest";
import {
  EMPTY_KEY_DRAFT,
  KEY_DRAFT_SECTIONS,
  KEY_DRAFT_STEPS,
  KEY_TEMPLATES,
  describeKeyProblem,
  keyDraftFromTemplateAt,
  keyDraftStepOf,
  keyHoldersForScope,
  keyScope,
  keyStepStates,
  keyTemplate,
  setKeyScope,
  templatesForScope,
} from "./index.js";

describe("KEY_DRAFT_STEPS", () => {
  it("are four steps: where, what for, what it can do, name", () => {
    expect(KEY_DRAFT_STEPS.map((s) => s.label)).toEqual([
      "Where it acts",
      "What it is for",
      "What it can do",
      "Name it",
    ]);
  });

  // Rules out: a section no step holds (it would never be drawn).
  it("every section but the review bar sits in exactly one step", () => {
    for (const s of KEY_DRAFT_SECTIONS) {
      const holders = KEY_DRAFT_STEPS.filter((st) =>
        (st.parts as readonly string[]).includes(s.id)
      );
      expect(holders.length).toBe(s.id === "review" ? 0 : 1);
    }
    expect(keyDraftStepOf("review")).toBeNull();
  });

  it("a problem names the step that fixes it", () => {
    expect(describeKeyProblem({ code: "no-name" }).step).toBe("name");
    expect(describeKeyProblem({ code: "no-uses" }).step).toBe("access");
    expect(
      describeKeyProblem({
        code: "grant",
        problem: { code: "invalid-lifetime", days: 0 },
      }).step
    ).toBe("access");
  });
});

describe("where it acts", () => {
  it("reads the scope from the narrowing", () => {
    expect(keyScope({ permissions: [] })).toBe("pod");
    expect(keyScope({ permissions: [], workspaceIds: ["w"] })).toBe("space");
    expect(keyScope({ permissions: [], projectIds: ["p"] })).toBe("project");
  });

  // Rules out: a project-scoped key that would be refused on every event
  // (finding 8809cc21) — the scope itself turns Activity off.
  it("a project scope drops Activity; a space scope keeps it", () => {
    const poster = keyDraftFromTemplateAt(
      keyTemplate("dev-loop-poster")!,
      EMPTY_KEY_DRAFT
    );
    expect(setKeyScope(poster, "project", "p").grant).toMatchObject({
      permissions: [],
      projectIds: ["p"],
      workspaceIds: null,
    });
    expect(setKeyScope(poster, "space", "w").grant.permissions).toEqual([
      "event.create",
    ]);
  });

  it("offers the holders the scope allows", () => {
    expect(keyHoldersForScope("pod").map((h) => h.id)).toEqual([
      "person",
      "system",
    ]);
    expect(keyHoldersForScope("space").map((h) => h.id)).toEqual([
      "person",
      "service",
    ]);
    expect(keyHoldersForScope("project").map((h) => h.id)).toEqual(["person"]);
  });
});

describe("what it is for", () => {
  it("hides what cannot work at a project, and says why", () => {
    const { offered, hidden } = templatesForScope(KEY_TEMPLATES, "project");
    expect(offered.map((t) => t.id)).toEqual([
      "website-or-pod-app",
      "read-only",
    ]);
    expect(hidden.map((h) => h.why)).toEqual([
      "Dev loop poster needs the whole pod or a space.",
      "Full access needs the whole pod or a space.",
    ]);
    expect(templatesForScope(KEY_TEMPLATES, "pod").hidden).toEqual([]);
  });

  it("a template picked at a project keeps no Activity", () => {
    const at = setKeyScope(EMPTY_KEY_DRAFT, "project", "p");
    const d = keyDraftFromTemplateAt(keyTemplate("read-only")!, at);
    expect(d.grant.permissions.some((p) => p.startsWith("event"))).toBe(false);
    expect(d.grant.projectIds).toEqual(["p"]);
  });
});

describe("keyStepStates", () => {
  it("opens the first unanswered step and closes the answered ones", () => {
    const fresh = keyStepStates(EMPTY_KEY_DRAFT, {
      where: false,
      purpose: false,
    });
    expect(fresh.map((s) => [s.id, s.answered, s.open])).toEqual([
      ["where", false, true],
      ["purpose", false, false],
      ["access", false, false],
      ["name", false, false],
    ]);
    const poster = keyDraftFromTemplateAt(
      keyTemplate("dev-loop-poster")!,
      EMPTY_KEY_DRAFT
    );
    expect(
      keyStepStates(poster, { where: true, purpose: true }).every(
        (s) => s.answered && !s.open
      )
    ).toBe(true);
  });
});
