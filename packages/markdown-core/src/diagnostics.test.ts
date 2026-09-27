import { describe, expect, it } from "vitest";
import {
  DIAGNOSTIC_CODES,
  EMBED_DIAGNOSTIC_CODES,
  GRAMMAR_WIRE_CODE,
  LAYOUT_DIAGNOSTIC_CODES,
} from "./diagnostics.js";

describe("diagnostic code groups", () => {
  it("DIAGNOSTIC_CODES is exactly EMBED + LAYOUT, in that order — never a third list", () => {
    expect(DIAGNOSTIC_CODES).toEqual([
      ...EMBED_DIAGNOSTIC_CODES,
      ...LAYOUT_DIAGNOSTIC_CODES,
    ]);
  });

  it("non-vacuous: both groups actually hold codes", () => {
    expect(EMBED_DIAGNOSTIC_CODES.length).toBeGreaterThan(0);
    expect(LAYOUT_DIAGNOSTIC_CODES.length).toBeGreaterThan(0);
  });

  it("no code is in both groups, and every code is unique", () => {
    const embed = new Set<string>(EMBED_DIAGNOSTIC_CODES);
    for (const code of LAYOUT_DIAGNOSTIC_CODES) {
      expect(embed.has(code)).toBe(false);
    }
    expect(new Set(DIAGNOSTIC_CODES).size).toBe(DIAGNOSTIC_CODES.length);
  });

  it("known columns codes classify as LAYOUT, known embed codes classify as EMBED", () => {
    expect(LAYOUT_DIAGNOSTIC_CODES).toContain("invalid-width");
    expect(LAYOUT_DIAGNOSTIC_CODES).toContain("single-column");
    expect(EMBED_DIAGNOSTIC_CODES).toContain("unterminated-embed");
    expect(EMBED_DIAGNOSTIC_CODES).toContain("missing-ref");
  });
});

describe("GRAMMAR_WIRE_CODE", () => {
  it("has a wire entry for every diagnostic code — the TS `satisfies` floor mirrored at runtime", () => {
    const map: Record<string, string> = GRAMMAR_WIRE_CODE;
    for (const code of DIAGNOSTIC_CODES) {
      expect(Object.prototype.hasOwnProperty.call(map, code)).toBe(true);
      expect(typeof map[code]).toBe("string");
    }
  });

  it("every LAYOUT code renames onto bad_columns or bad_width, never an embed wire code", () => {
    const map: Record<string, string> = GRAMMAR_WIRE_CODE;
    for (const code of LAYOUT_DIAGNOSTIC_CODES) {
      expect(["bad_columns", "bad_width"]).toContain(map[code]);
    }
  });

  it("no EMBED code renames onto bad_columns or bad_width", () => {
    const map: Record<string, string> = GRAMMAR_WIRE_CODE;
    for (const code of EMBED_DIAGNOSTIC_CODES) {
      expect(map[code]).not.toBe("bad_columns");
      expect(map[code]).not.toBe("bad_width");
    }
  });
});
