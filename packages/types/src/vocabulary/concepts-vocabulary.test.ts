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

  it("a step reads as a segment of its goal (same hue + icon family)", () => {
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
  it("a project-scoped playbook is a Goal template", () => {
    expect(resolveTemplateNoun("project")).toBe("Goal template");
    expect(resolveTemplateNoun("project", { plural: true })).toBe(
      "Goal templates"
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

  it("an automation is an Automation — through every spelling that reaches it (D2)", () => {
    expect(resolveObjectNoun("automation")).toBe("Automation");
    expect(resolveObjectNounPlural("automation")).toBe("Automations");
    expect(resolveObjectNounPlural("automations")).toBe("Automations");
    // CP publish vocabulary aliases to the same kind.
    expect(resolveObjectNoun("workflow")).toBe("Automation");
  });

  it("a skill rule is a Rule, and never the word of an automation (D2)", () => {
    expect(resolveObjectNoun("rule")).toBe("Rule");
    expect(resolveObjectNounPlural("rule")).toBe("Rules");
    expect(resolveObjectNoun("rule")).not.toBe(resolveObjectNoun("automation"));
    expect(resolveObjectNoun("rule", "fr")).toBe("Règle");
    expect(resolveObjectNoun("automation", "fr")).toBe("Automatisation");
  });

  it("a governance rule is an Approval — never 'Trust rules', never 'Rules'", () => {
    expect(resolveObjectNounPlural("governance_rule")).toBe("Approvals");
    expect(resolveObjectNounPlural("governance_rules")).toBe("Approvals");
    expect(resolveObjectNoun("governance_rule")).toBe("Approval");
    // The three words stay apart: Approvals, Rules (skill rules), Automations.
    expect(resolveObjectNounPlural("governance_rule")).not.toBe(
      resolveObjectNounPlural("automation")
    );
    expect(resolveObjectNounPlural("governance_rule")).not.toBe(
      resolveObjectNounPlural("rule")
    );
  });

  it("skill, capability and tool are ONE user word, Tool", () => {
    for (const kind of ["skill", "capability", "tool"]) {
      expect(resolveObjectNoun(kind), kind).toBe("Tool");
      expect(resolveObjectNounPlural(kind), kind).toBe("Tools");
    }
  });

  it("the kind still shows on a tool's detail — and is never the umbrella word", () => {
    expect(resolveToolKindLabel("skill")).toBe("Skill");
    // "Action" names a capability's verb only (decision 79f5b7a2), never the
    // capability itself.
    expect(resolveToolKindLabel("capability")).toBe("Capability");
    expect(resolveToolKindLabel("tool")).toBe("Integration");
    const chips = ["skill", "capability", "tool"].map(resolveToolKindLabel);
    expect(new Set(chips).size).toBe(3);
    expect(chips).not.toContain("Tool");
    expect(chips).not.toContain("Action");
    // Unknown kinds humanize, never leak.
    expect(resolveToolKindLabel("mcp_server")).toBe("Mcp server");
  });

  it("one verb of a capability is an Action, through the noun door", () => {
    expect(resolveObjectNoun("verb")).toBe("Action");
    expect(resolveObjectNounPlural("verb")).toBe("Actions");
    expect(resolveObjectNoun("verb", "fr")).toBe("Action");
    expect(resolveObjectNounPlural("verb", "fr")).toBe("Actions");
    // The capability keeps its own word: a verb is never its kind chip.
    expect(resolveToolKindLabel("capability")).not.toBe(
      resolveObjectNoun("verb")
    );
  });

  it("run chips say the user word", () => {
    expect(resolveProposalKindLabel("capability_run")).toBe("Run tool");
    expect(resolveProposalKindLabel("automation_run")).toBe("Run automation");
  });
});

// ── N1 (founder, 2026-09-27): the user word for a workspace is "Space" ──

describe("concept vocabulary — Space (N1)", () => {
  it("a workspace is a Space to the user, through every spelling that reaches it", () => {
    expect(resolveObjectNoun("workspace")).toBe("Space");
    expect(resolveObjectLabel("workspace")).toBe("Space");
    expect(resolveObjectNounPlural("workspace")).toBe("Spaces");
    expect(resolveObjectNounPlural("workspaces")).toBe("Spaces");
  });

  it("the kind TOKEN is unchanged — only the word moved", () => {
    expect(normalizeObjectKind("workspaces")).toBe("workspace");
    expect(OBJECT_KINDS.workspace?.kind).toBe("workspace");
  });
});

// ── D3 (founder, 2026-10-31, decision 985a59a8): one noun per object of making ──

describe("concept vocabulary — nouns of making and connecting (D3)", () => {
  it("a made UI block is a Card, never a Cell or a Widget (N1)", () => {
    expect(resolveObjectNoun("cell")).toBe("Card");
    expect(resolveObjectNounPlural("cell")).toBe("Cards");
    expect(resolveObjectNoun("cell", "fr")).toBe("Carte");
  });

  it("a card bound to a kind's slot is a Display (N2)", () => {
    expect(resolveObjectNoun("renderer")).toBe("Display");
    expect(resolveObjectNounPlural("renderer")).toBe("Displays");
    expect(resolveObjectNoun("renderer", "fr")).toBe("Affichage");
  });

  it("App is what you open in Synap; the outside software is a Connected app (N4)", () => {
    expect(resolveObjectNoun("app")).toBe("App");
    expect(resolveObjectNounPlural("app")).toBe("Apps");
    expect(resolveObjectNoun("application")).toBe("Connected app");
    expect(resolveObjectNounPlural("application")).toBe("Connected apps");
    expect(resolveObjectNoun("application", "fr")).toBe("App connectée");
    expect(resolveObjectNoun("app")).not.toBe(resolveObjectNoun("application"));
  });

  it("a space is a Space and never an App (N3)", () => {
    expect(resolveObjectNoun("workspace")).toBe("Space");
    expect(resolveObjectNoun("workspace")).not.toBe(resolveObjectNoun("app"));
  });

  it("Template is the family noun, qualified by scope, a space template included (N6)", () => {
    expect(resolveObjectNoun("playbook")).toBe("Template");
    expect(resolveTemplateNoun("space")).toBe("Space template");
    expect(resolveTemplateNoun("space", { plural: true })).toBe(
      "Space templates"
    );
    expect(resolveTemplateNoun("space", { locale: "fr" })).toBe(
      "Modèle d’espace"
    );
    expect(resolveTemplateNoun("space", { plural: true, locale: "fr" })).toBe(
      "Modèles d’espace"
    );
    // The two existing scopes keep their words.
    expect(resolveTemplateNoun("session")).toBe("Work template");
    expect(resolveTemplateNoun("project")).toBe("Goal template");
  });

  it("an account link is an Account, through every spelling (N8)", () => {
    expect(resolveObjectNoun("connection")).toBe("Account");
    expect(resolveObjectNounPlural("connection")).toBe("Accounts");
    expect(resolveObjectNounPlural("connections")).toBe("Accounts");
    expect(resolveObjectNoun("connection", "fr")).toBe("Compte");
  });

  it("a profile is a Kind (N10)", () => {
    expect(resolveObjectNoun("profile")).toBe("Kind");
    expect(resolveObjectNounPlural("profile")).toBe("Kinds");
    expect(resolveObjectNounPlural("profiles")).toBe("Kinds");
    expect(resolveObjectNoun("profile", "fr")).toBe("Type");
  });

  it("Room is the conversation only; the intake review is a Review (DP8)", () => {
    expect(resolveObjectNoun("room")).toBe("Room");
    expect(resolveObjectNoun("review")).toBe("Review");
    expect(resolveObjectNounPlural("review")).toBe("Reviews");
    expect(resolveObjectNoun("room")).not.toBe(resolveObjectNoun("review"));
  });

  it("Tool still names capabilities and skills only (N7)", () => {
    for (const kind of ["skill", "capability", "tool"]) {
      expect(resolveObjectNoun(kind), kind).toBe("Tool");
    }
    for (const kind of ["app", "application", "connection", "renderer"]) {
      expect(resolveObjectNoun(kind), kind).not.toBe("Tool");
    }
  });
});
