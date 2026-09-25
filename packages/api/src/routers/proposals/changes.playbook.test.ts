/**
 * The review card of a playbook create/update proposal shows WHAT is being
 * approved: its scope (session template vs project METHOD) and its stages
 * (name + goal) — not just the description.
 *
 * The defect: `description` is an entity-shape key, so the builder emitted one
 * row and the generic fallback (which would at least have dumped the rest) never
 * fired. Driven with the EXACT payload shape `playbooks.create` files
 * (`routers/playbooks.ts`, the `data:` of the create gate).
 */

import { describe, it, expect } from "vitest";
import { buildProposalChanges } from "./changes.js";

const createPayload = {
  name: "Business Model (GRP)",
  description: "Nine questions, six stages",
  goalTemplate: "Work out the business model of {{project}}",
  scope: "project",
  stages: [
    {
      key: "problem",
      name: "Problem",
      category: "planned",
      goal: "Name the pain",
    },
    {
      key: "segments",
      name: "Segments",
      category: "started",
      goal: "Who pays",
    },
    // A stage with no goal still renders a row, with an honest empty value.
    { key: "channels", name: "Channels", category: "started" },
  ],
};

describe("buildProposalChanges — playbook structure", () => {
  const changes = buildProposalChanges(createPayload, "create");
  const byPath = new Map(changes.map((c) => [c.path, c]));

  it("shows the scope as its own row, humanized through the vocabulary", () => {
    expect(byPath.get("scope")).toMatchObject({
      label: "Scope",
      operation: "create",
      after: "Project",
      valueType: "string",
    });
  });

  it("shows every stage by its OWN name with its goal", () => {
    expect(
      changes
        .filter((c) => c.path.startsWith("stages."))
        .map((c) => [c.path, c.label, c.after])
    ).toEqual([
      ["stages.problem", "Problem", "Name the pain"],
      ["stages.segments", "Segments", "Who pays"],
      ["stages.channels", "Channels", null],
    ]);
  });

  it("keeps the description row, and never dumps a raw stages/scope blob", () => {
    expect(byPath.get("description")).toMatchObject({
      after: "Nine questions, six stages",
    });
    expect(byPath.has("stages")).toBe(false);
  });

  it("an update that changes only the stages still shows them (fallback path)", () => {
    const upd = buildProposalChanges(
      { id: "pb-1", stages: createPayload.stages.slice(0, 1) },
      "update"
    );
    expect(upd.map((c) => [c.path, c.label, c.after])).toEqual([
      ["stages.problem", "Problem", "Name the pain"],
    ]);
  });

  it("an entity payload is unchanged (no stages, no scope)", () => {
    expect(
      buildProposalChanges(
        { title: "Acme", properties: { stage: "lead" } },
        "create"
      ).map((c) => c.path)
    ).toEqual(["title", "properties.stage"]);
  });
});
