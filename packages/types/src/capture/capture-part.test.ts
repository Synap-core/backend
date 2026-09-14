import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CAPTURE_PART_LIMITS,
  CaptureClarificationPartSchema,
  readCapturePart,
} from "./index.js";

/**
 * The GOLDEN fixture is shared: `@synap-core/capture-pipeline` parses the SAME
 * file against its structural mirror. Placeholders (`@@…@@`) expand to strings
 * that sit exactly one past a bound, so every invalid row fails on the bound it
 * names — never on something incidental.
 */
const fixture = JSON.parse(
  readFileSync(join(__dirname, "__fixtures__/capture-part.golden.json"), "utf8")
) as {
  valid: Array<{ name: string; part: unknown }>;
  invalid: Array<{ name: string; part: unknown }>;
};

const PLACEHOLDERS: Record<string, unknown> = {
  "@@Q501@@": "q".repeat(CAPTURE_PART_LIMITS.questionMaxChars + 1),
  "@@CHIPS9@@": Array.from(
    { length: CAPTURE_PART_LIMITS.chipsMax + 1 },
    () => ({
      label: "c",
      value: "c",
      action: "confirm",
    })
  ),
  "@@L81@@": "l".repeat(CAPTURE_PART_LIMITS.chipLabelMaxChars + 1),
  "@@T2001@@": "t".repeat(CAPTURE_PART_LIMITS.answerTextMaxChars + 1),
  "@@B8193@@": "b".repeat(CAPTURE_PART_LIMITS.formValuesMaxBytes + 1),
  // 4101 chars but 8194 bytes (with `{"a":""}`): only a BYTE count rejects it.
  "@@EA4093@@": "é".repeat(4093),
  "@@D141@@": "d".repeat(CAPTURE_PART_LIMITS.chipDescriptionMaxChars + 1),
  "@@W201@@": "w".repeat(CAPTURE_PART_LIMITS.whyMaxChars + 1),
  "@@V501@@": "v".repeat(501),
  "@@I65@@": "i".repeat(65),
  "@@E201@@": "e".repeat(201),
  "@@P201@@": "p".repeat(201),
  "@@K201@@": "k".repeat(201),
  "@@FL201@@": "f".repeat(201),
  "@@Y65@@": "y".repeat(65),
};

describe("golden fixture placeholders", () => {
  it("every placeholder the fixture declares expands here (none silently stays a short string)", () => {
    const declared = Object.keys(
      (
        JSON.parse(
          readFileSync(
            join(__dirname, "__fixtures__/capture-part.golden.json"),
            "utf8"
          )
        ) as { placeholders: Record<string, string> }
      ).placeholders
    );
    expect(declared.length).toBeGreaterThanOrEqual(12);
    expect(declared.filter((k) => !(k in PLACEHOLDERS))).toEqual([]);
  });
});

function expand(v: unknown): unknown {
  if (typeof v === "string" && v in PLACEHOLDERS) return PLACEHOLDERS[v];
  if (Array.isArray(v)) return v.map(expand);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, expand(x)])
    );
  return v;
}

describe("capture clarification part — golden fixture", () => {
  it("covers every variant (non-vacuity)", () => {
    const shapes = fixture.valid.map((r) => {
      const p = r.part as {
        kind: string;
        status?: string;
        answer?: { type: string };
      };
      return p.kind === "capture_question"
        ? `q:${p.status}`
        : `a:${p.answer!.type}`;
    });
    expect(new Set(shapes)).toEqual(
      new Set([
        "q:open",
        "q:answered",
        "q:superseded",
        "q:skipped",
        "a:chip",
        "a:text",
        "a:form",
        "a:skip",
      ])
    );
    expect(fixture.invalid.length).toBeGreaterThanOrEqual(10);
  });

  it.each(fixture.valid.map((r) => [r.name, r.part] as const))(
    "valid: %s",
    (_name, part) => {
      expect(
        CaptureClarificationPartSchema.safeParse(expand(part)).success
      ).toBe(true);
      expect(readCapturePart({ capturePart: expand(part) })).not.toBeNull();
    }
  );

  it.each(fixture.invalid.map((r) => [r.name, r.part] as const))(
    "invalid: %s",
    (_name, part) => {
      expect(
        CaptureClarificationPartSchema.safeParse(expand(part)).success
      ).toBe(false);
      expect(readCapturePart({ capturePart: expand(part) })).toBeNull();
    }
  );

  it("each bound sits exactly at its limit (the at-limit value passes)", () => {
    const base = expand(fixture.valid[0]!.part) as Record<string, unknown>;
    expect(
      CaptureClarificationPartSchema.safeParse({
        ...base,
        question: "q".repeat(CAPTURE_PART_LIMITS.questionMaxChars),
        chips: Array.from({ length: CAPTURE_PART_LIMITS.chipsMax }, () => ({
          label: "l".repeat(CAPTURE_PART_LIMITS.chipLabelMaxChars),
          value: "c",
          action: "confirm",
        })),
      }).success
    ).toBe(true);
  });

  it("reads nothing from metadata without a part", () => {
    expect(readCapturePart(null)).toBeNull();
    expect(readCapturePart({ agentState: {} })).toBeNull();
  });
});
