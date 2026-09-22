/**
 * `focus_sessions.current_stage` is documented as "seeded from the playbook's
 * first stage on instantiation". createFocusSession wired `playbookId` but
 * never seeded the stage, so a session started from a staged playbook was born
 * NULL-staged and every stage-aware surface read it as stageless — verified
 * live before the fix (origin "playbook", playbookId set, currentStage null).
 *
 * Service integration needs a DB; this pins the seeding rule itself.
 */
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { firstStageKey, readStages } from "../create-session.js";

describe("firstStageKey — playbook stage seeding", () => {
  it("seeds from the first stage's key", () => {
    expect(
      firstStageKey([
        { key: "brainstorming", name: "Brainstorming", category: "planned" },
        { key: "validating", name: "Validating", category: "planned" },
      ])
    ).toBe("brainstorming");
  });

  it("stays NULL for a stageless playbook (stages: []) — not a fabricated stage", () => {
    expect(firstStageKey([])).toBeNull();
  });

  it("stays NULL when the playbook has no stages at all", () => {
    expect(firstStageKey(undefined)).toBeNull();
    expect(firstStageKey(null)).toBeNull();
  });

  it("is defensive about JSONB shape — never returns a non-string key", () => {
    expect(firstStageKey("not-an-array")).toBeNull();
    expect(firstStageKey([null])).toBeNull();
    expect(firstStageKey([{ name: "no key here" }])).toBeNull();
    expect(firstStageKey([{ key: 42 }])).toBeNull();
    expect(firstStageKey([{ key: "" }])).toBeNull();
  });
});

/**
 * THE STAGE LIST ITSELF is copied onto the session at instantiate (0270).
 *
 * `currentStage` above says WHICH phase the session is in; `stages` says what
 * the phases ARE. Before 0270 only the playbook held the list, so a session
 * running no playbook could not have phases at all and the room fell back to a
 * flat deliverable list. Measured on the live pod the day this shipped: 10 of
 * 14 open sessions had no playbook.
 *
 * ── Why a copy and not a lookup ────────────────────────────────────────────
 * Same reason `criteria` and `expectedOutputs` are copied: editing a playbook
 * must not silently rewrite what an in-flight session says it is doing.
 *
 * NOTE this is the SESSION's answer, for display. The run's GATE still resolves
 * against `playbook_runs.definitionSnapshot.stages` first
 * (`services/playbooks/stage-gate.ts`) — that is what the run was started with,
 * and it is what a gate must judge against. The two are deliberately different
 * questions and must not be collapsed.
 */
describe("readStages — the session's own copy of the phases (0270)", () => {
  it("copies the playbook's stage list verbatim", () => {
    const stages = [
      { key: "gather", name: "Gather", category: "planned" },
      { key: "work", name: "Work", category: "started" },
    ];
    expect(readStages(stages)).toEqual(stages);
  });

  it("a stageless playbook seeds `[]`, never null — the column is NOT NULL", () => {
    // The migration declares `jsonb NOT NULL DEFAULT '[]'`. Returning null here
    // would make the insert fall back to the default by accident rather than by
    // intent, and the two are indistinguishable afterwards.
    expect(readStages([])).toEqual([]);
    expect(readStages(undefined)).toEqual([]);
    expect(readStages(null)).toEqual([]);
  });

  it("junk in the jsonb column is NO stages, and never throws", () => {
    // A jsonb column holds whatever was last written to it. A session being
    // born is not the place to discover that.
    for (const junk of ["not-an-array", 42, {}, true]) {
      expect(readStages(junk)).toEqual([]);
    }
  });

  it("does NOT deep-clone — the caller stores it, it does not mutate it", () => {
    // Stated because it is a real constraint and not an accident: this value
    // goes straight into an INSERT. If a caller ever starts editing it before
    // the write, this row is where that assumption gets revisited.
    const inner = { key: "gather", name: "Gather", category: "planned" };
    expect(readStages([inner])[0]).toBe(inner);
  });
});

describe("the insert actually USES it (reachability, not shape)", () => {
  it("createFocusSession seeds `stages` from the playbook", async () => {
    // The pure function above could be perfect while the INSERT ignored it —
    // the exact defect class where a projection is tested downstream of the
    // line that matters. There is no DB here, so the seam is pinned in source.
    const src = await readFile(
      new URL("../create-session.ts", import.meta.url),
      "utf8"
    );
    expect(src).toMatch(/stages: readStages\(playbook\?\.stages\)/);
    // Non-vacuity: the file really is the instantiate door.
    expect(src).toMatch(/currentStage: firstStageKey\(playbook\?\.stages\)/);
  });
});
