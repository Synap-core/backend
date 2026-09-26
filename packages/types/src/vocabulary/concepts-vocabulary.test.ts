/**
 * Concept-consolidation W1 — the vocabulary rows for the glossary's user words
 * (`synap-backend/skills/synap/concepts.md`). Step, Pack and the derived
 * template nouns are the words the glossary introduces; they must resolve
 * through the ONE door, never through a call-site map.
 *
 * The glossary ↔ vocabulary sameness check lives in the api tripwire
 * `concepts-one-definition.test.ts` (it reads the skills tree); this file pins
 * the resolvers themselves.
 */
import { describe, expect, it } from "vitest";
import {
  normalizeObjectKind,
  OBJECT_KINDS,
  resolveObjectIcon,
  resolveObjectLabel,
  resolveObjectNoun,
  resolveObjectNounPlural,
  resolveProposalKindLabel,
  resolveTemplateNoun,
  resolveToolKindLabel,
} from "./index.js";

describe("concept vocabulary — Step", () => {
  it("a track stage is called a Step, through every spelling that reaches it", () => {
    expect(resolveObjectNoun("stage")).toBe("Step");
    expect(resolveObjectNoun("step")).toBe("Step");
    expect(resolveObjectNoun("track_stage")).toBe("Step");
    expect(resolveObjectNounPlural("stage")).toBe("Steps");
    expect(normalizeObjectKind("stages")).toBe("stage");
    expect(normalizeObjectKind("steps")).toBe("stage");
  });

  it("a step reads as a segment of its track (same hue + icon family)", () => {
    expect(OBJECT_KINDS.stage?.color).toBe(OBJECT_KINDS.track?.color);
    expect(resolveObjectIcon("stage")).toBe(OBJECT_KINDS.track?.icon);
  });
});

describe("concept vocabulary — Pack", () => {
  it("the package layer's `suite` is a Pack to the user", () => {
    expect(resolveObjectLabel("pack")).toBe("Pack");
    expect(resolveObjectNoun("suite")).toBe("Pack");
    expect(resolveObjectNounPlural("suites")).toBe("Packs");
  });

  it("a pack is not a workspace (it never creates one — founder D8)", () => {
    expect(OBJECT_KINDS.pack?.category).not.toBe("workspace");
  });
});

describe("resolveTemplateNoun — derived from scope, never declared", () => {
  it("a project-scoped playbook is a Track template", () => {
    expect(resolveTemplateNoun("project")).toBe("Track template");
    expect(resolveTemplateNoun("project", { plural: true })).toBe(
      "Track templates"
    );
  });

  it("a session-scoped playbook is a Work template", () => {
    expect(resolveTemplateNoun("session")).toBe("Work template");
    expect(resolveTemplateNoun("session", { plural: true })).toBe(
      "Work templates"
    );
  });

  it("a missing scope reads as session, as the schema does (NULL = session)", () => {
    expect(resolveTemplateNoun(null)).toBe("Work template");
    expect(resolveTemplateNoun(undefined)).toBe("Work template");
  });
});

// ── W5 naming pass (founder D1/D2): the retired words resolve to the glossary's ──

describe("concept vocabulary — Template, Rule, Tools (W5)", () => {
  it("a playbook is a Template to the user", () => {
    expect(resolveObjectNoun("playbook")).toBe("Template");
    expect(resolveObjectNounPlural("playbooks")).toBe("Templates");
  });

  it("an automation is a Rule — through every spelling that reaches it", () => {
    expect(resolveObjectNoun("automation")).toBe("Rule");
    expect(resolveObjectNounPlural("automation")).toBe("Rules");
    // CP publish vocabulary aliases to the same kind.
    expect(resolveObjectNoun("workflow")).toBe("Rule");
  });

  it("skill, capability and tool are ONE user word, Tool", () => {
    for (const kind of ["skill", "capability", "tool"]) {
      expect(resolveObjectNoun(kind), kind).toBe("Tool");
      expect(resolveObjectNounPlural(kind), kind).toBe("Tools");
    }
  });

  it("the kind still shows on a tool's detail — and is never the umbrella word", () => {
    expect(resolveToolKindLabel("skill")).toBe("Skill");
    expect(resolveToolKindLabel("capability")).toBe("Action");
    expect(resolveToolKindLabel("tool")).toBe("Integration");
    const chips = ["skill", "capability", "tool"].map(resolveToolKindLabel);
    expect(new Set(chips).size).toBe(3);
    expect(chips).not.toContain("Tool");
    // Unknown kinds humanize, never leak.
    expect(resolveToolKindLabel("mcp_server")).toBe("Mcp server");
  });

  it("run chips say the user word", () => {
    expect(resolveProposalKindLabel("capability_run")).toBe("Run tool");
    expect(resolveProposalKindLabel("automation_run")).toBe("Run rule");
  });
});
