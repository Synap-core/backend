/**
 * `buildTrackSnapshot` — what a track PINS from its method.
 *
 * The HEADLINE is deep-copy independence (moved here from the proto-track's
 * `buildProjectStageSettings`). Odoo ships a documented bug where duplicating a
 * project from a template leaves the copy's stages SHARED with the template's,
 * so editing one silently edits the other. A spread (`[...playbook.stages]`)
 * reproduces it exactly: the array is new, every stage OBJECT is the same
 * reference. `structuredClone` makes the snapshot a snapshot.
 */
import { describe, expect, it } from "vitest";
import type { PlaybookStage } from "@synap/playbooks";
import type { Playbook } from "@synap/database/schema";
import { buildTrackSnapshot } from "../tracks-service.js";

function method(): Playbook {
  return {
    id: "00000000-0000-4000-8000-0000000000a1",
    version: 3,
    goalTemplate: "Run the method",
    expectedOutputs: [{ kind: "document", label: "Plan" }],
    criteria: [],
    stages: [
      {
        key: "discovery",
        name: "Discovery",
        category: "planned",
        expectedOutputs: [{ kind: "document", label: "Brief" }],
      },
      { key: "build", name: "Build", category: "started" },
    ],
  } as unknown as Playbook;
}

describe("buildTrackSnapshot — DEEP COPY independence", () => {
  it("mutating the track's pinned stages does NOT touch the method's", () => {
    const playbook = method();
    const pinned = buildTrackSnapshot(playbook).stages as PlaybookStage[];
    pinned[1]!.name = "Build (renamed on the track)";
    pinned[0]!.expectedOutputs![0]!.label = "Brief (track-local)";
    pinned.push({ key: "extra", name: "Extra", category: "started" });

    const source = playbook.stages as PlaybookStage[];
    expect(source).toHaveLength(2);
    expect(source[1]!.name).toBe("Build");
    expect(source[0]!.expectedOutputs![0]!.label).toBe("Brief");
  });

  it("shares no object reference with the source (a spread would fail this)", () => {
    const playbook = method();
    const source = playbook.stages as PlaybookStage[];
    const pinned = buildTrackSnapshot(playbook).stages as PlaybookStage[];
    expect(pinned).not.toBe(source);
    source.forEach((stage, i) => expect(pinned[i]).not.toBe(stage));
    expect(pinned[0]!.expectedOutputs).not.toBe(source[0]!.expectedOutputs);
  });

  it("pins the method version and the rest of the definition", () => {
    const snap = buildTrackSnapshot(method());
    expect(snap.version).toBe(3);
    expect(snap.goalTemplate).toBe("Run the method");
    expect(snap.expectedOutputs).toEqual([{ kind: "document", label: "Plan" }]);
  });

  it("tolerates a stageless method", () => {
    expect(
      buildTrackSnapshot({ ...method(), stages: null } as unknown as Playbook)
        .stages
    ).toEqual([]);
  });
});
