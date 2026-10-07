import { describe, it, expect } from "vitest";
import { CAPTURE_RESULT_LIMITS } from "@synap-core/types/capture";
import { projectCaptureResultRows } from "../capture-result-part.js";

const L = CAPTURE_RESULT_LIMITS;
const project = (p: Record<string, unknown>) =>
  projectCaptureResultRows({
    proposals: [{ tempId: "t1", profileSlug: "x", title: "T", ...p }],
    matchedTempIds: new Set(),
    dismissedTempIds: new Set(),
  });

describe("result row properties/content bounds", () => {
  it("projects scalars, small arrays/objects and content", () => {
    const { rows, truncated } = project({
      properties: { a: "s", n: 3, b: true, z: null, arr: [1], o: { k: 1 } },
      content: "body",
    });
    expect(rows[0].properties).toEqual({
      a: "s",
      n: 3,
      b: true,
      z: null,
      arr: [1],
      o: { k: 1 },
    });
    expect(rows[0].content).toBe("body");
    expect(truncated).toBe(false);
  });

  it("caps keys at 16 and reports truncated", () => {
    const properties = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`k${i}`, i])
    );
    const { rows, truncated } = project({ properties });
    expect(Object.keys(rows[0].properties!)).toHaveLength(L.propertiesMaxKeys);
    expect(truncated).toBe(true);
  });

  it("truncates long strings, DROPS (not cuts) oversized structures", () => {
    const { rows, truncated } = project({
      properties: {
        s: "x".repeat(600),
        big: ["y".repeat(600)],
        ok: [1],
      },
    });
    expect(rows[0].properties!.s).toHaveLength(L.propertyValueMaxChars);
    expect(rows[0].properties).not.toHaveProperty("big");
    expect(rows[0].properties!.ok).toEqual([1]);
    expect(truncated).toBe(true);
  });

  it("truncates content to 2048 and reports it", () => {
    const { rows, truncated } = project({ content: "c".repeat(3000) });
    expect(rows[0].content).toHaveLength(L.contentMaxChars);
    expect(truncated).toBe(true);
  });

  it("never persists secret-keyed properties", () => {
    const { rows } = project({
      properties: {
        apiKey: "1",
        api_key: "2",
        "API-KEY": "3",
        password: "4",
        authToken: "5",
        clientSecret: "6",
        name: "kept",
      },
    });
    expect(rows[0].properties).toEqual({ name: "kept" });
  });

  it("drops properties/content (keeps the row) past the row byte cap", () => {
    // 16 x 500-char values = 8000+ bytes > 6144
    const properties = Object.fromEntries(
      Array.from({ length: 16 }, (_, i) => [`k${i}`, "v".repeat(500)])
    );
    const { rows, truncated } = project({ properties, content: "c" });
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("T");
    expect(rows[0]).not.toHaveProperty("properties");
    expect(rows[0]).not.toHaveProperty("content");
    expect(truncated).toBe(true);
  });
});

describe("result relations", () => {
  const proj = (relations: unknown[], n = 2) =>
    projectCaptureResultRows({
      proposals: Array.from({ length: n }, (_, i) => ({
        tempId: `t${i}`,
        profileSlug: "x",
        title: "T",
      })),
      relations: relations as never,
      matchedTempIds: new Set(),
      dismissedTempIds: new Set(),
    });
  const e = (s: string, t: string) => ({
    sourceTempId: s,
    targetTempId: t,
    relationType: "r",
  });

  it("keeps edges between existing rows, prunes dangling ones", () => {
    const out = proj([e("t0", "t1"), e("t0", "ghost"), e("ghost", "t1")]);
    expect(out.relations).toEqual([e("t0", "t1")]);
  });

  it("omits the key when there are none", () => {
    expect(proj([e("t0", "ghost")])).not.toHaveProperty("relations");
    expect(proj([])).not.toHaveProperty("relations");
  });

  it("caps at relationsMax and reports truncated", () => {
    const out = proj(Array(L.relationsMax + 5).fill(e("t0", "t1")));
    expect(out.relations).toHaveLength(L.relationsMax);
    expect(out.truncated).toBe(true);
  });
});
