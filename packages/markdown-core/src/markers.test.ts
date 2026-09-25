import { describe, it, expect } from "vitest";
import {
  flattenInlineMarkers,
  splitInlineMarkers,
  sanitizeMarkerLabel,
  formatMarker,
  parseInlinePatterns,
  resolvePatternMarkers,
  isMarkerHref,
} from "./markers.js";
import { markdownToPlainText } from "./plain-text.js";

describe("splitInlineMarkers", () => {
  it("interleaves prose and a reference marker, in order", () => {
    const segs = splitInlineMarkers(
      "Oldest is [[entity:e9|Migrate billing]] today."
    );
    expect(segs.map((s) => s.type)).toEqual(["text", "marker", "text"]);
    const marker = segs[1] as Extract<
      (typeof segs)[number],
      { type: "marker" }
    >;
    expect(marker.pattern).toEqual({
      kind: "entity",
      id: "e9",
      label: "Migrate billing",
    });
  });

  it("a marker naming no known kind keeps a null pattern (so it stays raw)", () => {
    const [seg] = splitInlineMarkers("[[bogus:x|Y]]");
    expect(seg).toMatchObject({
      type: "marker",
      raw: "[[bogus:x|Y]]",
      pattern: null,
    });
  });

  it("plain text is one text segment; empty is none", () => {
    expect(splitInlineMarkers("no markers")).toEqual([
      { type: "text", value: "no markers" },
    ]);
    expect(splitInlineMarkers("")).toEqual([]);
  });
});

describe("flattenInlineMarkers", () => {
  it("references read as their label, unknown markers stay raw", () => {
    expect(
      flattenInlineMarkers(
        "See [[entity:e9|Migrate billing]] and [[bogus:x|Y]]."
      )
    ).toBe("See Migrate billing and [[bogus:x|Y]].");
  });
});

describe("the ONE escape rule", () => {
  it("strips both brackets, keeps pipes, collapses whitespace", () => {
    expect(sanitizeMarkerLabel("[DRAFT] Q3\n plan | v2")).toBe(
      "DRAFT Q3 plan | v2"
    );
    expect(sanitizeMarkerLabel("  [[]]  ")).toBe("");
  });

  it("formatMarker round-trips any label through the grammar, and cannot be injected", () => {
    const label = "Weird [label] with | pipe and [[entity:x|y]]";
    const marker = formatMarker("automation", "a-1", label);
    const parsed = parseInlinePatterns(`see ${marker} now`).patterns;
    expect(parsed).toEqual([
      { kind: "automation", id: "a-1", label: sanitizeMarkerLabel(label) },
    ]);
    // The link text the renderer builds is balanced.
    expect(resolvePatternMarkers(marker)).toBe(
      `[${sanitizeMarkerLabel(label)}](automation://a-1)`
    );
  });

  it("the id cannot carry a delimiter", () => {
    expect(formatMarker("entity", "a|b]c:d", "L")).toBe("[[entity:abcd|L]]");
  });
});

// W5f F3: `[[view:ID]]` is TAUGHT (synap_create_document's description, the
// inline-patterns skill) yet the grammar required a label, so it rendered raw,
// uuid included. The label is optional; an unlabeled reference never reads as
// its id — the renderer resolves the name, plain text reads the kind's noun.
describe("label-less markers", () => {
  const ID = "05bb6692-1c2d-4e5f-8a9b-0c1d2e3f4a5b";

  it("parse as a reference with an EMPTY label, never the id", () => {
    expect(parseInlinePatterns(`see [[view:${ID}]] now`).patterns).toEqual([
      { kind: "view", id: ID, label: "" },
    ]);
    expect(parseInlinePatterns(`[[widget:stat-card]]`).patterns).toEqual([
      { kind: "widget", cellKey: "stat-card", label: "" },
    ]);
  });

  it("become an empty-text chip link the renderer names, and a labelled one is unchanged", () => {
    expect(resolvePatternMarkers(`see [[view:${ID}]].`)).toBe(
      `see [](view://${ID}).`
    );
    expect(resolvePatternMarkers(`[[entity:e1|Alice]]`)).toBe(
      `[Alice](entity://e1)`
    );
    expect(resolvePatternMarkers(`[[run:r1]]`)).toBe(`[Run](run://r1)`);
  });

  it("flatten to the caller's noun (default: the kind word), never the id", () => {
    const text = `See [[view:${ID}]] and [[entity:e1|Alice]].`;
    expect(flattenInlineMarkers(text)).toBe("See view and Alice.");
    expect(flattenInlineMarkers(text, (k) => (k === "view" ? "View" : k))).toBe(
      "See View and Alice."
    );
    expect(flattenInlineMarkers(text)).not.toContain(ID);
  });

  it("plain text threads the caller's noun", () => {
    expect(
      markdownToPlainText(`Open [[view:${ID}]].`, { nounFor: () => "View" })
    ).toBe("Open View.");
  });

  it("commands without a label are not swallowed by the reference pass", () => {
    expect(resolvePatternMarkers("[[open:side]]")).toBe("[[open:side]]");
  });
});

describe("isMarkerHref", () => {
  it("keeps every href resolvePatternMarkers emits", () => {
    const text =
      "[[view:v1]] [[entity:e1|A]] [[run:r1]] [[open:side|view:v1]] [[company:c1|Acme]]";
    const hrefs = [
      ...resolvePatternMarkers(text).matchAll(/\]\(([^)]*)\)/g),
    ].map((m) => m[1]!);
    expect(hrefs).toHaveLength(5);
    for (const href of hrefs) expect(isMarkerHref(href), href).toBe(true);
  });

  it("refuses script-capable and ordinary URLs", () => {
    for (const url of [
      "javascript://%0aalert(1)",
      "data://x",
      "vbscript://x",
      "view://",
      "https:x",
      "/path",
    ]) {
      expect(isMarkerHref(url), url).toBe(false);
    }
  });
});
