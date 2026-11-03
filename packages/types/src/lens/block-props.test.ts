/**
 * A work block's props, read ONE way by every client (`./block-props.ts`).
 * Each row names the former rule it rules out: the web's silent fallback on a
 * bad `empty` (author mode must break), the phone's broken block on it
 * (reader mode must fall back), the web's untrimmed section, the phone's
 * "unknown" for a page-only section.
 */
import { describe, expect, it } from "vitest";
import {
  LENS_SECTION_LIMIT_MAX,
  LENS_SECTION_LIMIT_MIN,
  STATUS_OF_ROUTE_KIND,
  readLensSectionBlock,
  readStatusMarkId,
} from "./block-props.js";
import { ATTENTION_CLASSES, LENS_CAPS } from "./sections.js";
import { STATUS_OF_ANSWER_TYPES } from "../units/status-of.js";
import { WIDGET_DEFINITIONS } from "../renderables/widgets.js";

const MODES = ["author", "reader"] as const;

describe("readLensSectionBlock: the section", () => {
  it("draws every attention class, with its own cap and empty answer", () => {
    for (const mode of MODES) {
      for (const section of ATTENTION_CLASSES) {
        expect(readLensSectionBlock({ section }, mode)).toEqual({
          ok: true,
          section,
          limit: LENS_CAPS[section],
          empty: section === "blocking" ? "reassure" : "omit",
          fellBack: [],
        });
      }
    }
  });

  it("trims the section (the phone did, the web did not)", () => {
    for (const mode of MODES) {
      expect(
        readLensSectionBlock({ section: " produced " }, mode)
      ).toMatchObject({ ok: true, section: "produced" });
    }
  });

  it("no section, a blank one or a non-string is no-section, in both modes", () => {
    for (const mode of MODES) {
      for (const props of [
        {},
        { section: "  " },
        { section: 3 },
        null,
        undefined,
      ]) {
        expect(readLensSectionBlock(props as never, mode)).toEqual({
          ok: false,
          problem: { why: "no-section" },
        });
      }
    }
  });

  it("a section of the PAGE is page-only, not unknown (the phone said unknown)", () => {
    for (const mode of MODES) {
      for (const section of ["doneWhen", "participants", "structure", "data"]) {
        expect(readLensSectionBlock({ section }, mode)).toEqual({
          ok: false,
          problem: { why: "page-only", section },
        });
      }
    }
  });

  it("any other section is unknown, in both modes (nothing is invented in its place)", () => {
    for (const mode of MODES) {
      expect(readLensSectionBlock({ section: "needs-you" }, mode)).toEqual({
        ok: false,
        problem: { why: "unknown-section", section: "needs-you" },
      });
    }
  });
});

describe("readLensSectionBlock: empty (Q1, author breaks, reader falls back)", () => {
  it("a bad empty is broken for the author (the web fell back silently)", () => {
    expect(
      readLensSectionBlock({ section: "produced", empty: "loud" }, "author")
    ).toEqual({ ok: false, problem: { why: "bad-empty", value: "loud" } });
    expect(
      readLensSectionBlock({ section: "produced", empty: 3 }, "author")
    ).toEqual({ ok: false, problem: { why: "bad-empty", value: 3 } });
  });

  it("a bad empty falls back for the reader, and says so (the phone broke the block)", () => {
    expect(
      readLensSectionBlock({ section: "blocking", empty: "loud" }, "reader")
    ).toEqual({
      ok: true,
      section: "blocking",
      limit: LENS_CAPS.blocking,
      empty: "reassure",
      fellBack: [{ why: "bad-empty", value: "loud" }],
    });
  });

  it("a legacy invite reads as explain, a padded answer reads, null is unset — both modes", () => {
    for (const mode of MODES) {
      expect(
        readLensSectionBlock({ section: "produced", empty: "invite" }, mode)
      ).toMatchObject({ ok: true, empty: "explain", fellBack: [] });
      expect(
        readLensSectionBlock({ section: "produced", empty: " reassure " }, mode)
      ).toMatchObject({ ok: true, empty: "reassure", fellBack: [] });
      expect(
        readLensSectionBlock({ section: "blocking", empty: null }, mode)
      ).toMatchObject({ ok: true, empty: "reassure", fellBack: [] });
    }
  });
});

describe("readLensSectionBlock: limit", () => {
  it("a number is clamped to the catalog's bounds and floored, never broken", () => {
    for (const mode of MODES) {
      const at = (limit: number) =>
        readLensSectionBlock({ section: "produced", limit }, mode);
      expect(at(40)).toMatchObject({ ok: true, limit: LENS_SECTION_LIMIT_MAX });
      expect(at(0)).toMatchObject({ ok: true, limit: LENS_SECTION_LIMIT_MIN });
      expect(at(-3)).toMatchObject({ ok: true, limit: LENS_SECTION_LIMIT_MIN });
      expect(at(2.7)).toMatchObject({ ok: true, limit: 2, fellBack: [] });
    }
  });

  it("the catalog's lens-section limit field is bounded by the same constants", () => {
    const field = WIDGET_DEFINITIONS.find(
      (w) => w.key === "lens-section"
    )?.configSchema?.find((f) => f.key === "limit");
    expect(field?.jsonSchema).toMatchObject({
      minimum: LENS_SECTION_LIMIT_MIN,
      maximum: LENS_SECTION_LIMIT_MAX,
    });
    expect(field?.constraints).toEqual({
      min: LENS_SECTION_LIMIT_MIN,
      max: LENS_SECTION_LIMIT_MAX,
    });
    // Every section's own cap is a limit an author could also have written.
    for (const cls of ATTENTION_CLASSES) {
      expect(LENS_CAPS[cls]).toBeGreaterThanOrEqual(LENS_SECTION_LIMIT_MIN);
      expect(LENS_CAPS[cls]).toBeLessThanOrEqual(LENS_SECTION_LIMIT_MAX);
    }
  });

  it("a limit that is not a finite number is broken for the author", () => {
    for (const limit of ["5", Number.NaN, Number.POSITIVE_INFINITY, {}]) {
      expect(
        readLensSectionBlock({ section: "produced", limit }, "author")
      ).toEqual({ ok: false, problem: { why: "bad-limit", value: limit } });
    }
  });

  it("and the class's own cap for the reader, listed in fellBack", () => {
    expect(
      readLensSectionBlock({ section: "proposed", limit: "5" }, "reader")
    ).toEqual({
      ok: true,
      section: "proposed",
      limit: LENS_CAPS.proposed,
      empty: "omit",
      fellBack: [{ why: "bad-limit", value: "5" }],
    });
  });

  it("null or absent is the class's own cap with no problem", () => {
    for (const mode of MODES) {
      expect(
        readLensSectionBlock({ section: "happened", limit: null }, mode)
      ).toMatchObject({ ok: true, limit: LENS_CAPS.happened, fellBack: [] });
    }
  });

  it("the reader collects every fallback; the author stops at the first problem", () => {
    const props = { section: "produced", empty: "loud", limit: "x" };
    expect(readLensSectionBlock(props, "reader")).toMatchObject({
      ok: true,
      fellBack: [
        { why: "bad-empty", value: "loud" },
        { why: "bad-limit", value: "x" },
      ],
    });
    expect(readLensSectionBlock(props, "author")).toEqual({
      ok: false,
      problem: { why: "bad-empty", value: "loud" },
    });
  });
});

describe("status-mark", () => {
  it("routes every statusOf answer type; a goal is a track in the route table", () => {
    expect(Object.keys(STATUS_OF_ROUTE_KIND).sort()).toEqual(
      [...STATUS_OF_ANSWER_TYPES].sort()
    );
    expect(STATUS_OF_ROUTE_KIND).toEqual({
      entity: "entity",
      goal: "track",
      session: "session",
      run: "run",
    });
  });

  it("reads a trimmed UUID id, else null", () => {
    const id = "6f1c1f9e-3b1a-4c55-9a6e-0f0e7c3d2b10";
    expect(readStatusMarkId({ id })).toBe(id);
    expect(readStatusMarkId({ id: `  ${id} ` })).toBe(id);
    expect(readStatusMarkId({ id: "not-a-uuid" })).toBeNull();
    expect(readStatusMarkId({ id: 42 })).toBeNull();
    expect(readStatusMarkId({})).toBeNull();
    expect(readStatusMarkId(null)).toBeNull();
  });
});
