/**
 * Project ↔ playbook stage binding — the pure half of
 * `projects.instantiateFromPlaybook`.
 *
 * The HEADLINE test here is deep-copy independence. Odoo ships a documented bug
 * where duplicating a project from a template leaves the copy's stages SHARED
 * with the template's, so editing one silently edits the other. A spread
 * (`[...playbook.stages]`) reproduces it exactly: the array is new, every stage
 * OBJECT is the same reference. `structuredClone` is what makes the copy a
 * snapshot, and this file is what stops a future "simplification" back to a
 * spread from passing.
 *
 * No DB — these are pure functions over the jsonb shapes.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLAYBOOK_STAGE_CATEGORY,
  type PlaybookStage,
} from "@synap/playbooks";
import {
  buildProjectStageSettings,
  readProjectStages,
  resolveProjectPhaseCategory,
} from "./projects.js";

const PLAYBOOK_ID = "00000000-0000-4000-8000-0000000000a1";

function templateStages(): PlaybookStage[] {
  return [
    {
      key: "discovery",
      name: "Discovery",
      category: "planned",
      expectedOutputs: [{ kind: "document", label: "Brief" }],
    },
    { key: "build", name: "Build", category: "started" },
    { key: "handover", name: "Handover", category: "completed" },
  ];
}

function playbookRow() {
  return { id: PLAYBOOK_ID, version: 3, stages: templateStages() };
}

describe("buildProjectStageSettings — DEEP COPY independence", () => {
  it("mutating the project's copied stages does NOT touch the playbook's", () => {
    const playbook = playbookRow();
    const settings = buildProjectStageSettings(null, playbook);
    const copied = readProjectStages(settings);

    // Every level: the array, a stage object, and a NESTED object inside it.
    copied[1].name = "Build (renamed on the project)";
    copied[0].expectedOutputs![0].label = "Brief (project-local)";
    copied.push({ key: "extra", name: "Extra", category: "started" });

    const source = playbook.stages as PlaybookStage[];
    expect(source).toHaveLength(3);
    expect(source[1].name).toBe("Build");
    expect(source[0].expectedOutputs![0].label).toBe("Brief");
  });

  it("mutating the playbook's stages does NOT touch the project's copy", () => {
    const playbook = playbookRow();
    const settings = buildProjectStageSettings(null, playbook);

    const source = playbook.stages as PlaybookStage[];
    source[1].name = "Build (renamed on the template)";
    source.length = 1;

    const copied = readProjectStages(settings);
    expect(copied).toHaveLength(3);
    expect(copied[1].name).toBe("Build");
  });

  it("shares no object reference with the source (a spread would fail this)", () => {
    const playbook = playbookRow();
    const source = playbook.stages as PlaybookStage[];
    const copied = readProjectStages(buildProjectStageSettings(null, playbook));

    expect(copied).not.toBe(source);
    for (let i = 0; i < source.length; i++) {
      expect(copied[i]).not.toBe(source[i]);
    }
    expect(copied[0].expectedOutputs).not.toBe(source[0].expectedOutputs);
  });

  it("MERGES into existing settings — other keys survive", () => {
    const settings = buildProjectStageSettings(
      { agentPreferences: { tone: "brief" }, stages: ["stale"] },
      playbookRow()
    );
    expect(settings.agentPreferences).toEqual({ tone: "brief" });
    expect(readProjectStages(settings).map((s) => s.key)).toEqual([
      "discovery",
      "build",
      "handover",
    ]);
  });

  it("records the source playbook id and version as lineage", () => {
    const settings = buildProjectStageSettings(null, playbookRow());
    expect(settings.sourcePlaybookId).toBe(PLAYBOOK_ID);
    expect(settings.sourcePlaybookVersion).toBe(3);
  });

  it("tolerates a non-object settings value and a stageless playbook", () => {
    expect(
      readProjectStages(
        buildProjectStageSettings("junk", {
          id: PLAYBOOK_ID,
          version: 1,
          stages: null,
        })
      )
    ).toEqual([]);
  });
});

describe("resolveProjectPhaseCategory", () => {
  it("resolves a bound project's phase to its stage's declared category", () => {
    const settings = buildProjectStageSettings(null, playbookRow());
    expect(resolveProjectPhaseCategory("handover", settings)).toBe("completed");
    expect(resolveProjectPhaseCategory("discovery", settings)).toBe("planned");
  });

  it("a LEGACY category-less stage falls to the ONE shared default", () => {
    const settings = buildProjectStageSettings(null, {
      id: PLAYBOOK_ID,
      version: 1,
      // Stored before `category` existed — must still resolve, via the shared
      // resolver, never a locally invented answer.
      stages: [{ key: "kickoff", name: "Kickoff" }],
    });
    expect(resolveProjectPhaseCategory("kickoff", settings)).toBe(
      DEFAULT_PLAYBOOK_STAGE_CATEGORY
    );
  });

  it("an UNBOUND project (free-text phase, no copied stages) uses the same default", () => {
    expect(resolveProjectPhaseCategory("whatever we call it", null)).toBe(
      DEFAULT_PLAYBOOK_STAGE_CATEGORY
    );
    expect(resolveProjectPhaseCategory(null, null)).toBe(
      DEFAULT_PLAYBOOK_STAGE_CATEGORY
    );
  });

  it("a phase that matches no copied stage uses the same default", () => {
    const settings = buildProjectStageSettings(null, playbookRow());
    expect(resolveProjectPhaseCategory("not-a-stage", settings)).toBe(
      DEFAULT_PLAYBOOK_STAGE_CATEGORY
    );
  });
});
