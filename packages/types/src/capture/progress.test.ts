import { describe, it, expect } from "vitest";
import {
  STRUCTURE_PROGRESS_LIMITS,
  decodeStructureProgressFrame,
} from "./index.js";

/**
 * Every row names the WRONG rule it rules out: a decoder implementing that
 * rule would produce a different result on exactly that row.
 */

const stage = {
  v: 1,
  seq: 3,
  kind: "stage",
  stage: "placing",
  attempt: 1,
  at: "2026-09-14T10:00:00.000Z",
};
const entity = (i: number) => ({ title: `Entity ${i}`, profileSlug: "task" });
const draft = (entities: unknown[]) => ({
  v: 1,
  seq: 4,
  kind: "draft",
  attempt: 2,
  rev: 1,
  entities,
});
const done = { v: 1, seq: 9, kind: "done", outcome: "follow_up" };

describe("decodeStructureProgressFrame — accepts the v1 union", () => {
  it("decodes each kind and strips unknown fields (wrong rule: pass input through)", () => {
    expect(decodeStructureProgressFrame({ ...stage, extra: "x" })).toEqual(
      stage
    );
    expect(decodeStructureProgressFrame(draft([entity(1)]))).toEqual(
      draft([entity(1)])
    );
    expect(decodeStructureProgressFrame(done)).toEqual(done);
  });

  it("accepts every stage in the union, including asking", () => {
    for (const s of [
      "reading",
      "understanding",
      "placing",
      "matching",
      "asking",
    ]) {
      expect(
        decodeStructureProgressFrame({ ...stage, stage: s })
      ).not.toBeNull();
    }
  });

  it("accepts an empty draft — a new attempt resets the snapshot (wrong rule: require ≥1 entity)", () => {
    expect(decodeStructureProgressFrame(draft([]))).toEqual(draft([]));
  });

  it("accepts seq 0 and rev 0 (wrong rule: treat 0 as missing)", () => {
    expect(decodeStructureProgressFrame({ ...done, seq: 0 })).not.toBeNull();
    expect(
      decodeStructureProgressFrame({ ...draft([]), rev: 0 })
    ).not.toBeNull();
  });
});

describe("decodeStructureProgressFrame — bounds are APPLIED", () => {
  it("caps entities at 12, keeping the first 12 in order (wrong rule: no cap)", () => {
    const decoded = decodeStructureProgressFrame(
      draft(Array.from({ length: 13 }, (_, i) => entity(i)))
    );
    expect(STRUCTURE_PROGRESS_LIMITS.draftEntitiesMax).toBe(12);
    expect(decoded?.kind).toBe("draft");
    if (decoded?.kind !== "draft") return;
    expect(decoded.entities).toHaveLength(12);
    expect(decoded.entities[11]).toEqual(entity(11));
  });

  it("keeps exactly 12 untouched (wrong rule: off-by-one cap at 11)", () => {
    const decoded = decodeStructureProgressFrame(
      draft(Array.from({ length: 12 }, (_, i) => entity(i)))
    );
    expect(decoded?.kind === "draft" && decoded.entities).toHaveLength(12);
  });

  it("truncates an 81-char title to 80 (wrong rule: no truncation)", () => {
    const decoded = decodeStructureProgressFrame(
      draft([{ title: "t".repeat(81), profileSlug: "note" }])
    );
    expect(decoded?.kind === "draft" && decoded.entities[0].title).toBe(
      "t".repeat(80)
    );
  });

  it("truncates by code point (wrong rule: String.slice leaves a lone surrogate)", () => {
    const title = "a".repeat(79) + "😀😀";
    const decoded = decodeStructureProgressFrame(
      draft([{ title, profileSlug: "note" }])
    );
    expect(decoded?.kind === "draft" && decoded.entities[0].title).toBe(
      "a".repeat(79) + "😀"
    );
  });
});

describe("decodeStructureProgressFrame — rejects what it does not understand", () => {
  const rejected: Array<[string, unknown]> = [
    ["v:2 (wrong rule: accept any version)", { ...done, v: 2 }],
    ['v:"1" (wrong rule: loose equality)', { ...done, v: "1" }],
    ["missing v", { seq: 1, kind: "done", outcome: "plan" }],
    [
      "unknown kind (wrong rule: accept any kind)",
      { ...done, kind: "summary" },
    ],
    [
      "stage not in the union (wrong rule: accept any string stage)",
      { ...stage, stage: "thinking" },
    ],
    [
      "unknown outcome (wrong rule: accept any string outcome)",
      { ...done, outcome: "success" },
    ],
    [
      "draft entity with empty title (wrong rule: accept any string title)",
      draft([{ title: "", profileSlug: "task" }]),
    ],
    [
      "draft entity with whitespace title (wrong rule: length>0 without trim)",
      draft([{ title: "   ", profileSlug: "task" }]),
    ],
    ["draft entity without profileSlug", draft([{ title: "A" }])],
    [
      "draft with a malformed member past the cap (wrong rule: validate after capping)",
      draft([
        ...Array.from({ length: 12 }, (_, i) => entity(i)),
        { title: "" },
      ]),
    ],
    ["draft entities not an array", { ...draft([]), entities: {} }],
    ["negative seq", { ...done, seq: -1 }],
    ["fractional seq (wrong rule: typeof number only)", { ...done, seq: 1.5 }],
    [
      "stage attempt 0 (wrong rule: attempts start at 0)",
      { ...stage, attempt: 0 },
    ],
    ["stage without at", { ...stage, at: undefined }],
    ["draft without rev", { ...draft([]), rev: undefined }],
    ["an array", [done]],
    ["null", null],
    ["a JSON string (wrong rule: parse strings)", JSON.stringify(done)],
  ];

  it.each(rejected)("rejects %s", (_name, input) => {
    expect(decodeStructureProgressFrame(input)).toBeNull();
  });
});
