import { describe, expect, it } from "vitest";
import {
  QUESTION_TITLE_SOFT_MAX,
  TITLE_HARD_MAX,
  TITLE_SOFT_MAX,
  isCleanTitle,
  lintTitle,
  titleTooLongReason,
  type TitleLintCode,
} from "./index.js";

const codes = (title: string | null | undefined, kind?: string) =>
  lintTitle(title, { kind }).map((i) => i.code);

/**
 * The plan's own "good" examples (pod doc 9992207a, section 3) plus clean
 * titles from the 240-entry sample. A rubric that flags these is too eager —
 * this is the false-positive half of the fixture set.
 */
const CLEAN: Array<[string, string | undefined]> = [
  ["Space skills are linked by the brief, not by a row", "knowledge"],
  [
    "Connection data lives in one package: @synap-core/integrations",
    "decision",
  ],
  ["Should Grida replace or complement the tldraw whiteboard?", "question"],
  ["Send signed agreement to Harbor Goods", "task"],
  ["Excalidraw evaluated as a Synap capability", "research"],
  ["Capture reads the URL but never feeds it to the structurer", "issue"],
  ["Farm-to-Client Market — idea brief", "note"],
  ["Frontend package consolidation: 4 layer packages", "session"],
  ["Deep-link open bounce needs the type known in three layers", "knowledge"],
  ["Orca sits beside Synap, not inside it", "knowledge"],
  ["S3 uploads over 10 MB go direct to storage", "knowledge"],
  ["The CP refuses an official publish from any other door", "knowledge"],
  ["iOS share sheet drops the page title", "knowledge"],
];

/**
 * One real or real-shaped defect per rubric line. Most are verbatim titles from
 * the founder's pod (2026-10-12 audit).
 */
const DEFECTS: Array<[string, TitleLintCode, string | undefined]> = [
  ["", "empty", undefined],
  ["   ", "empty", undefined],
  [
    "Capability templates: a code skill cannot reach a template-level vault he…",
    "truncated",
    "knowledge",
  ],
  [
    "Relay sessions filter cannot follow the working state...",
    "truncated",
    undefined,
  ],
  ["x".repeat(TITLE_SOFT_MAX + 1), "too_long", "knowledge"],
  ["Agent DELETE governance fix verified live", "status_word", "knowledge"],
  ["SHIPPED: proposals consolidation", "status_word", "knowledge"],
  ["Pod-experience campaign shipped", "status_word", "knowledge"],
  ["NEVER WRITE THE STATUS DIRECTLY", "shouting", "knowledge"],
  ["Capture room works 🎉", "emoji", "knowledge"],
  ["Use `moveStatus` for lifecycle moves", "machinery", "knowledge"],
  ["**Important** grants deny by default", "machinery", "knowledge"],
  ["See [[document:abc]] for the plan", "machinery", "knowledge"],
  ["Fix landed in 75dc8e8e for key state", "machinery", "knowledge"],
  ["create-session.ts refuses long titles", "machinery", "knowledge"],
  ["Guard lives at write-receipt.ts:139 in the hub", "machinery", "knowledge"],
  ["Docs at https://synap.live/docs explain lenses", "machinery", "knowledge"],
  ["Okay so the capture thing is broken again", "speech", "note"],
  ["I think the relay needs a back button", "speech", "note"],
  ["Could you add a filter to the board", "speech", "note"],
  ["https://example.com/article", "machinery", "note"],
  ["Untitled", "placeholder", "note"],
  ["Test", "placeholder", "note"],
  ["Billing", "too_short", "task"],
  ["Fix relay", "too_short", "task"],
  ["T1 grants deny by default", "plan_code", "knowledge"],
  ["W4: agency processes", "plan_code", "knowledge"],
  ["Wave A capture review", "plan_code", "knowledge"],
];

describe("lintTitle", () => {
  it.each(CLEAN)("passes a clean title: %s", (title, kind) => {
    expect(lintTitle(title, { kind })).toEqual([]);
  });

  it.each(DEFECTS)("flags %j as %s", (title, code, kind) => {
    expect(codes(title, kind)).toContain(code);
    expect(isCleanTitle(title, { kind })).toBe(false);
  });

  it("gives a question more room than a name", () => {
    const q = `Should ${"the relay ".repeat(9)}show it?`;
    expect(q.length).toBeGreaterThan(TITLE_SOFT_MAX);
    expect(q.length).toBeLessThanOrEqual(QUESTION_TITLE_SOFT_MAX);
    expect(codes(q, "question")).not.toContain("too_long");
    expect(codes(q, "knowledge")).toContain("too_long");
  });

  it("counts a date stamp and a kind prefix without failing the title", () => {
    const issues = lintTitle("Lesson: builder weekly report — week of 5 Oct", {
      kind: "knowledge",
    });
    expect(issues.map((i) => i.code).sort()).toEqual([
      "date_stamp",
      "kind_prefix",
    ]);
    expect(issues.every((i) => i.severity === "note")).toBe(true);
    expect(isCleanTitle("Lesson: grants deny by default")).toBe(true);
  });

  it("only applies the three-word floor to notes, items, tasks and sessions", () => {
    expect(codes("Billing", "knowledge")).not.toContain("too_short");
    expect(codes("Billing", "task")).toContain("too_short");
  });

  it("reports each code once, in rubric order, with a message for the writer", () => {
    const issues = lintTitle("T1 SHIPPED `x.ts` fix 1234abcd…", {
      kind: "knowledge",
    });
    const seen = issues.map((i) => i.code);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual([
      "truncated",
      "status_word",
      "machinery",
      "plan_code",
    ]);
    for (const i of issues) expect(i.message.length).toBeGreaterThan(10);
  });

  describe("a title cut from its source text", () => {
    const claim =
      "A pod-wide key_revoked with no keyIdPrefix means the pod lost its signing key, not that every agent key was revoked; check the pod first.";

    it("flags a mid-word cut with no ellipsis (the old 120-character cut)", () => {
      const cut = claim.slice(0, 60);
      expect(cut.endsWith(" ")).toBe(false);
      expect(codes(cut, "knowledge")).not.toContain("truncated");
      expect(
        lintTitle(cut, { kind: "knowledge", source: claim }).map((i) => i.code)
      ).toContain("truncated");
    });

    it("flags a long prefix cut on a word boundary", () => {
      const cut = claim.slice(0, claim.lastIndexOf(" ", 100));
      expect(cut.length).toBeGreaterThan(TITLE_SOFT_MAX);
      expect(lintTitle(cut, { source: claim }).map((i) => i.code)).toContain(
        "truncated"
      );
    });

    it("leaves a short handle that starts the claim alone", () => {
      expect(
        lintTitle("A pod-wide key_revoked with no keyIdPrefix", {
          kind: "knowledge",
          source: claim,
        })
      ).toEqual([]);
      expect(
        lintTitle(claim.split(";")[0] + ".", { source: claim }).map(
          (i) => i.code
        )
      ).not.toContain("truncated");
    });
  });

  it("names the hard cap and points the writer at the body", () => {
    expect(TITLE_HARD_MAX).toBe(200);
    expect(titleTooLongReason(230)).toMatch(/230 characters.*limit is 200/);
  });
});
