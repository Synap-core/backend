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
