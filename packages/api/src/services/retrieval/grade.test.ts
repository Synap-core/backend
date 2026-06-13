import { describe, it, expect } from "vitest";
import { gradeResults, rekey } from "./grade.js";
import type { QueryUnderstanding } from "./understand-query.js";

const u = (over: Partial<QueryUnderstanding> = {}): QueryUnderstanding => ({
  profileTypes: [],
  propertyHints: [],
  temporal: false,
  confidence: 0,
  ...over,
});

describe("gradeResults", () => {
  it("empty results → verdict empty, correction rekey", () => {
    const g = gradeResults(u({ profileTypes: ["person"] }), []);
    expect(g.verdict).toBe("empty");
    expect(g.correction).toBe("rekey");
  });

  it("inferred type present in top-3 → confident", () => {
    const g = gradeResults(u({ profileTypes: ["person"] }), [
      "person",
      "note",
      "task",
    ]);
    expect(g.verdict).toBe("confident");
    expect(g.correction).toBe("none");
  });

  it("inferred type absent from top-3 → ambiguous (no re-run)", () => {
    const g = gradeResults(u({ profileTypes: ["decision"] }), [
      "note",
      "task",
      "event",
    ]);
    expect(g.verdict).toBe("ambiguous");
    expect(g.correction).toBe("none");
  });

  it("no inferred type + results present → confident", () => {
    const g = gradeResults(u(), ["note", "task"]);
    expect(g.verdict).toBe("confident");
  });
});

describe("rekey", () => {
  it("strips question words + stopwords to content keywords", () => {
    expect(rekey("who is the VP of Product")).toBe("vp product");
  });

  it("keeps distinctive terms", () => {
    expect(rekey("what did we decide about Northwind")).toBe(
      "decide northwind"
    );
  });

  it("returns empty when nothing distinctive remains", () => {
    expect(rekey("who is it")).toBe("");
  });
});
