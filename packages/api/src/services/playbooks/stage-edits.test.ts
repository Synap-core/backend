/**
 * One stage edited by key against the stored list, and the fingerprint that
 * says a stage list was read whole (tickets 8493079e, 2771d2bc).
 */
import { describe, it, expect } from "vitest";
import { applyStageEdits, stagesRevision } from "./stage-edits.js";

const STORED = [
  { key: "shape", name: "Shape", category: "planned", description: "d1" },
  { key: "build", name: "Build", category: "started" },
  { key: "ship", name: "Ship", category: "completed" },
];

describe("applyStageEdits", () => {
  it("adds after a key, updates one stage, removes one: the rest kept as stored", () => {
    const out = applyStageEdits(STORED, [
      {
        op: "add",
        stage: { key: "review", name: "Review", category: "started" },
        after: "build",
      },
      {
        op: "update",
        key: "shape",
        fields: { name: "Shaped", description: null },
      },
      { op: "remove", key: "ship" },
    ]);
    expect(out).toEqual({
      ok: true,
      stages: [
        { key: "shape", name: "Shaped", category: "planned" },
        { key: "build", name: "Build", category: "started" },
        { key: "review", name: "Review", category: "started" },
      ],
    });
  });

  it("appends an add with no `after`", () => {
    const out = applyStageEdits(STORED, [
      {
        op: "add",
        stage: { key: "learn", name: "Learn", category: "completed" },
      },
    ]);
    expect(out.ok && out.stages.map((s) => s.key)).toEqual([
      "shape",
      "build",
      "ship",
      "learn",
    ]);
  });

  it("refuses an unknown key, naming the keys there are", () => {
    const out = applyStageEdits(STORED, [{ op: "remove", key: "nope" }]);
    expect(out).toEqual({
      ok: false,
      error: expect.stringContaining("its keys: shape, build, ship"),
    });
  });

  it("refuses a duplicate add, a rename, an unknown op and an empty list", () => {
    expect(
      applyStageEdits(STORED, [
        { op: "add", stage: { key: "build", name: "B", category: "started" } },
      ]).ok
    ).toBe(false);
    expect(
      applyStageEdits(STORED, [
        { op: "update", key: "build", fields: { key: "make" } },
      ]).ok
    ).toBe(false);
    expect(applyStageEdits(STORED, [{ op: "replace", key: "build" }]).ok).toBe(
      false
    );
    expect(applyStageEdits(STORED, []).ok).toBe(false);
  });

  it("never half-applies: a later refusal leaves nothing changed", () => {
    const before = JSON.stringify(STORED);
    const out = applyStageEdits(STORED, [
      { op: "remove", key: "ship" },
      { op: "remove", key: "nope" },
    ]);
    expect(out.ok).toBe(false);
    expect(JSON.stringify(STORED)).toBe(before);
  });
});

describe("stagesRevision", () => {
  it("is stable for one list and changes with any stage", () => {
    expect(stagesRevision(STORED)).toBe(stagesRevision([...STORED]));
    expect(stagesRevision(STORED)).not.toBe(stagesRevision(STORED.slice(0, 2)));
    expect(stagesRevision(null)).toBe(stagesRevision([]));
  });
});
