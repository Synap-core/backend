import { describe, it, expect } from "vitest";
import {
  CAPTURE_RESULT_LIMITS,
  CaptureResultPartSchema,
  readCapturePart,
} from "./index.js";

const base = {
  tempId: "t1",
  profileSlug: "task",
  title: "T",
  why: null,
  updatesExisting: false,
  dismissed: false,
};
const part = (row: Record<string, unknown>) => ({
  kind: "capture_result",
  v: 1,
  sessionId: "11111111-1111-4111-8111-111111111111",
  round: 1,
  rows: [row],
  truncated: false,
  notice: null,
});

describe("capture_result row properties/content", () => {
  it("round-trips with properties + content", () => {
    const p = part({
      ...base,
      properties: { a: "x", n: 1, arr: [1, 2], o: { k: true }, z: null },
      content: "body",
    });
    const parsed = readCapturePart({ capturePart: p });
    expect(parsed).toEqual(p);
  });

  it("round-trips without them, and an OLD-shape part still parses", () => {
    const old = part(base); // exactly the pre-change row
    const parsed = readCapturePart({ capturePart: old });
    expect(parsed).toEqual(old);
    expect(
      parsed?.kind === "capture_result" && "properties" in parsed.rows[0]
    ).toBe(false);
  });

  it("ignores unknown future fields (file convention: non-strict z.object)", () => {
    const parsed = CaptureResultPartSchema.safeParse(
      part({ ...base, futureField: 1 })
    );
    expect(parsed.success).toBe(true);
  });

  it("rejects out-of-bound properties/content", () => {
    const L = CAPTURE_RESULT_LIMITS;
    const bad = (row: Record<string, unknown>) =>
      CaptureResultPartSchema.safeParse(part({ ...base, ...row })).success;
    expect(bad({ content: "c".repeat(L.contentMaxChars + 1) })).toBe(false);
    expect(
      bad({
        properties: Object.fromEntries(
          Array.from({ length: L.propertiesMaxKeys + 1 }, (_, i) => [
            `k${i}`,
            1,
          ])
        ),
      })
    ).toBe(false);
    expect(bad({ properties: { s: "x".repeat(501) } })).toBe(false);
    expect(bad({ properties: { a: ["x".repeat(501)] } })).toBe(false);
  });

  it("round-trips part relations + row action/existingEntityId; absent still parses", () => {
    const id = "22222222-2222-4222-8222-222222222222";
    const p = {
      ...part({ ...base, action: "update", existingEntityId: id }),
      relations: [
        { sourceTempId: "t1", targetTempId: "t2", relationType: "owns" },
      ],
    };
    expect(readCapturePart({ capturePart: p })).toEqual(p);
    const old = part(base);
    expect(readCapturePart({ capturePart: old })).toEqual(old);
  });

  it("rejects a bad action, a non-uuid target and more than the relation cap", () => {
    const L = CAPTURE_RESULT_LIMITS;
    const ok = (x: unknown) => CaptureResultPartSchema.safeParse(x).success;
    expect(ok(part({ ...base, action: "merge" }))).toBe(false);
    expect(ok(part({ ...base, existingEntityId: "nope" }))).toBe(false);
    const rel = { sourceTempId: "a", targetTempId: "b", relationType: "r" };
    expect(
      ok({ ...part(base), relations: Array(L.relationsMax + 1).fill(rel) })
    ).toBe(false);
    expect(
      ok({ ...part(base), relations: Array(L.relationsMax).fill(rel) })
    ).toBe(true);
  });
});

describe("capture_result part-level project + placement", () => {
  const project = {
    id: "7c1e2b3a-4d5f-4a6b-8c7d-9e0f1a2b3c4d",
    reason: "about the product",
    confidence: 0.8,
    outcome: "selected",
  };
  const placement = {
    workspaceId: "w-ambient",
    workspaceName: "Builder",
    deterministic: false,
    suggestion: {
      workspaceId: "w-brand",
      workspaceName: "Brand",
      reason: null,
      alternatives: [
        { workspaceId: "w-brand", workspaceName: "Brand", weight: 0.7 },
      ],
    },
  };

  it("round-trips the values through the reader — not stripped", () => {
    const p = { ...part(base), project, placement };
    expect(readCapturePart({ capturePart: p })).toEqual(p);
  });

  it("an OLD part without either field still parses, and gains neither", () => {
    const parsed = readCapturePart({ capturePart: part(base) });
    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty("project");
    expect(parsed).not.toHaveProperty("placement");
  });

  it("refuses an outcome outside the CaptureProjectOutcome vocabulary", () => {
    const ok = (x: unknown) => CaptureResultPartSchema.safeParse(x).success;
    expect(
      ok({ ...part(base), project: { ...project, outcome: "maybe" } })
    ).toBe(false);
    expect(ok({ ...part(base), project: null, placement: null })).toBe(true);
  });
});

describe("capture_result row signals (D10 + label)", () => {
  it("round-trips description, roles, confidence and label", () => {
    const p = part({
      ...base,
      description: "A post about sovereign data",
      roles: ["client", "investor"],
      confidence: 0.8,
      label: "likely",
    });
    expect(readCapturePart({ capturePart: p })).toEqual(p);
  });

  it("refuses out-of-bound signals (the reader drops the part, never a field)", () => {
    const L = CAPTURE_RESULT_LIMITS;
    const ok = (row: Record<string, unknown>) =>
      CaptureResultPartSchema.safeParse(part({ ...base, ...row })).success;
    expect(ok({ description: "d".repeat(L.descriptionMaxChars + 1) })).toBe(
      false
    );
    expect(
      ok({ roles: Array.from({ length: L.rolesMax + 1 }, (_, i) => `r${i}`) })
    ).toBe(false);
    expect(ok({ confidence: 1.5 })).toBe(false);
    expect(ok({ label: "maybe" })).toBe(false);
  });
});

describe("capture_result suggestions (D6)", () => {
  const withSuggestions = (suggestions: unknown) => ({
    ...part(base),
    suggestions,
  });
  it("round-trips ranked next steps; absent and [] are different facts", () => {
    const p = withSuggestions([
      {
        kind: "playbook",
        id: "pb-1",
        title: "Produce",
        forTempId: "t1",
        reason: "a post",
      },
      { kind: "rule", id: "r-1", title: "Tag", forTempId: null },
    ]);
    expect(readCapturePart({ capturePart: p })).toEqual(p);
    const none = readCapturePart({ capturePart: withSuggestions([]) });
    expect(none?.kind === "capture_result" && none.suggestions).toEqual([]);
    const absent = readCapturePart({ capturePart: part(base) });
    expect(absent && "suggestions" in absent).toBe(false);
  });

  it("refuses more than six, or an unknown kind", () => {
    const step = { kind: "playbook", id: "p", title: "T", forTempId: null };
    const ok = (s: unknown) =>
      CaptureResultPartSchema.safeParse(withSuggestions(s)).success;
    expect(ok(Array(7).fill(step))).toBe(false);
    expect(ok([{ ...step, kind: "agent" }])).toBe(false);
  });
});

describe("capture_result row candidate (D9)", () => {
  it("round-trips the top duplicate; refuses a score outside 0..1", () => {
    const candidate = { entityId: "e-1", title: "Alice Martin", score: 0.82 };
    const p = part({ ...base, candidate });
    expect(readCapturePart({ capturePart: p })).toEqual(p);
    expect(
      CaptureResultPartSchema.safeParse(
        part({ ...base, candidate: { ...candidate, score: 2 } })
      ).success
    ).toBe(false);
  });
});
