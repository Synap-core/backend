/**
 * The shared "Start from…" rules (relay new-work + browser Home picker +
 * AddTrackPicker). Fixture rows are chosen where candidate rules DISAGREE:
 * an archived project-scoped row (relay dropped archived at the read, the
 * browser in the rule), a NULL scope (reads as session), and the same list
 * with and without a track group.
 */
import { describe, expect, it } from "vitest";
import {
  isTrackTemplate,
  readSeedableStages,
  templateUsedByLine,
  trackTemplatesOf,
  workTemplatesOf,
} from "./templates.js";

const row = (id: string, scope?: string | null, status = "active") => ({
  id,
  scope,
  status,
});

const ROWS = [
  row("method", "project"),
  row("retired-method", "project", "archived"),
  row("work", "session"),
  row("legacy", null),
  row("retired-work", "session", "archived"),
];

describe("trackTemplatesOf", () => {
  it("offers only startable project-scoped templates", () => {
    expect(trackTemplatesOf(ROWS).map((r) => r.id)).toEqual(["method"]);
  });
  it("a NULL scope is a work template, never a track template", () => {
    expect(isTrackTemplate(row("x", null))).toBe(false);
    expect(isTrackTemplate(row("x", undefined))).toBe(false);
  });
});

describe("workTemplatesOf", () => {
  it("beside a track group, each template is listed ONCE", () => {
    const work = workTemplatesOf(ROWS, { tracksOffered: true }).map(
      (r) => r.id
    );
    const tracks = trackTemplatesOf(ROWS).map((r) => r.id);
    expect(work).toEqual(["work", "legacy"]);
    expect(work.filter((id) => tracks.includes(id))).toEqual([]);
  });
  it("with no track group, every startable template stays — archived never", () => {
    expect(
      workTemplatesOf(ROWS, { tracksOffered: false }).map((r) => r.id)
    ).toEqual(["method", "work", "legacy"]);
  });
});

describe("templateUsedByLine", () => {
  it("says the count through the vocabulary", () => {
    expect(templateUsedByLine(1)).toBe("Used by 1 project");
    expect(templateUsedByLine(3)).toBe("Used by 3 projects");
  });
  it("absent or zero says nothing — absent is not 0", () => {
    expect(templateUsedByLine(undefined)).toBeNull();
    expect(templateUsedByLine(null)).toBeNull();
    expect(templateUsedByLine(0)).toBeNull();
  });
});

describe("readSeedableStages", () => {
  it("keeps whole stages, drops malformed ones, first key wins", () => {
    const stages = readSeedableStages({
      stages: [
        { key: "a", name: "Frame", category: "plan", goal: "why" },
        { key: "a", name: "Dup", category: "plan" },
        { key: "b", name: "", category: "plan" },
        { key: "c", name: "No category" },
        { key: " ", name: "Blank key", category: "plan" },
        { key: "d", name: "Ship", category: "execute" },
      ],
    });
    expect(stages.map((s) => s.key)).toEqual(["a", "d"]);
    expect(stages[0]).toMatchObject({ goal: "why" });
  });
  it("no stages ⇒ nothing to seed", () => {
    expect(readSeedableStages(null)).toEqual([]);
    expect(readSeedableStages({ stages: "x" })).toEqual([]);
  });
});
