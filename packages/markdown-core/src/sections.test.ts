import { describe, expect, it } from "vitest";
import { listSections, segmentSlides } from "./sections.js";

describe("segmentSlides — tier 1 (synap-section)", () => {
  const doc = `# Workspace report — July 2026

::::synap-section{agent="analyst" round="analyze" confidence="0.8"}
The workspace grew 12% month over month.
::::

::::synap-section{agent="strategist" round="relate" confidence="0.6"}
This connects to the Q3 roadmap.
::::
`;

  it("produces a title slide + one slide per section", () => {
    const slides = segmentSlides(doc);
    expect(slides).toHaveLength(3);

    expect(slides[0].id).toBe("title");
    expect(slides[0].title).toBe("Workspace report — July 2026");
    expect(slides[0].index).toBe(0);
    expect(slides[0].content).toContain("# Workspace report");

    expect(slides[1].title).toBe("Analyze · analyst");
    expect(slides[1].attributes?.round).toBe("analyze");
    expect(slides[1].attributes?.confidence).toBe("0.8");
    expect(slides[1].content.trim()).toBe(
      "The workspace grew 12% month over month."
    );
    expect(slides[1].index).toBe(1);

    expect(slides[2].title).toBe("Relate · strategist");
    expect(slides[2].content.trim()).toBe("This connects to the Q3 roadmap.");
    expect(slides[2].index).toBe(2);
  });

  it("prefers an authored id attribute for the slide id", () => {
    const withId = `::::synap-section{id="exec-summary" round="analyze"}
Body.
::::
`;
    const [slide] = segmentSlides(withId);
    expect(slide.id).toBe("exec-summary");
  });

  it("dedupes ids when two sections share the same round+agent", () => {
    const dup = `::::synap-section{agent="analyst" round="analyze"}
First.
::::

::::synap-section{agent="analyst" round="analyze"}
Second.
::::
`;
    const slides = segmentSlides(dup);
    expect(slides.map((s) => s.id)).toEqual([
      "analyze-analyst",
      "analyze-analyst-2",
    ]);
  });

  it("a slide id is stable across edits to OTHER slides", () => {
    const before = `::::synap-section{id="keep" round="analyze"}
A.
::::

::::synap-section{round="relate"}
B.
::::
`;
    const after = `::::synap-section{id="keep" round="analyze"}
A.
::::

::::synap-section{round="relate"}
B, but edited with more text now.
::::

::::synap-section{round="decide"}
C, a whole new slide inserted after.
::::
`;
    const idBefore = segmentSlides(before)[0].id;
    const idAfter = segmentSlides(after)[0].id;
    expect(idBefore).toBe(idAfter);
    expect(idBefore).toBe("keep");
  });
});

describe("segmentSlides — tier 1 title precedence (heading over attributes)", () => {
  it("titles a slide from the section's own ## claim, not from round · agent", () => {
    // Seed v12 of the report automation makes the assembler open every section
    // with a one-line claim. Without this the deck's headline was
    // "Analyze · analyst" — the same two facts the 12px attribution row beneath
    // it already prints, in two sizes, 12px apart.
    const doc = `::::synap-section{agent="analyst" round="analyze"}
## Half the open tasks are blocked

Twelve of twenty-three are waiting on review.
::::
`;
    const [slide] = segmentSlides(doc);
    expect(slide.title).toBe("Half the open tasks are blocked");
    expect(slide.id).toBe("half-the-open-tasks-are-blocked");
    // The heading stays in the body — segmentation slices, it never rewrites.
    expect(slide.content).toContain("## Half the open tasks are blocked");
    // Attributes still ride along for the attribution row.
    expect(slide.attributes?.round).toBe("analyze");
  });

  it("falls back to the attribute label for a report generated before v12", () => {
    // BACK-COMPAT: every report already sitting in a pod was written by a seed
    // that emitted no headings. Those must keep their old titles rather than
    // degrade to "Section N".
    const legacy = `::::synap-section{agent="strategist" round="relate"}
This connects to the Q3 roadmap.
::::
`;
    const [slide] = segmentSlides(legacy);
    expect(slide.title).toBe("Relate · strategist");
    expect(slide.id).toBe("relate-strategist");
  });

  it("an authored id attribute still outranks the heading", () => {
    const doc = `::::synap-section{id="exec-summary" round="analyze"}
## Revenue concentration is the risk
::::
`;
    const [slide] = segmentSlides(doc);
    expect(slide.id).toBe("exec-summary");
    expect(slide.title).toBe("Revenue concentration is the risk");
  });

  it("dedupes ids when two sections carry the same heading", () => {
    const doc = `::::synap-section{round="analyze"}
## Open questions
A.
::::

::::synap-section{round="relate"}
## Open questions
B.
::::
`;
    const slides = segmentSlides(doc);
    expect(slides.map((s) => s.id)).toEqual([
      "open-questions",
      "open-questions-2",
    ]);
    expect(slides.map((s) => s.title)).toEqual([
      "Open questions",
      "Open questions",
    ]);
  });

  it("mixes: a headed section and a headless one in the same deck", () => {
    const doc = `# Workspace report

::::synap-section{agent="analyst" round="analyze"}
## Notes are thin
Only three this month.
::::

::::synap-section{agent="strategist" round="relate"}
No heading here.
::::
`;
    const slides = segmentSlides(doc);
    expect(slides.map((s) => s.title)).toEqual([
      "Workspace report",
      "Notes are thin",
      "Relate · strategist",
    ]);
  });

  it("an empty heading does not shadow the attribute label", () => {
    // `## ` with nothing after it parses as a heading whose text is "". Taking
    // it would title the slide with the empty string — worse than the fallback.
    const doc = `::::synap-section{agent="analyst" round="analyze"}
##

Body.
::::
`;
    const [slide] = segmentSlides(doc);
    expect(slide.title).toBe("Analyze · analyst");
    expect(slide.id).toBe("analyze-analyst");
  });

  it("leaves tier 2 and tier 3 heading titles untouched", () => {
    // The tier-1 change must not leak: these tiers already read heading text
    // and their behaviour is pinned above, so this asserts only that adding a
    // section-less document still routes past tier 1.
    expect(segmentSlides("# A\n\n## B\n\nBody.\n").map((s) => s.title)).toEqual(
      ["A", "B"]
    );
    expect(
      segmentSlides("Plain.\n\n---\n\nMore plain.\n").map((s) => s.title)
    ).toEqual(["Slide 1", "Slide 2"]);
  });
});

describe("segmentSlides — body vs content (a deck must not print its title twice)", () => {
  it("drops the leading claim heading from body, keeps it in content", () => {
    const doc = `::::synap-section{agent="analyst" round="analyze"}
## Half the open tasks are blocked

Twelve of twenty-three are waiting on review.
::::
`;
    const [slide] = segmentSlides(doc);
    expect(slide.content).toContain("## Half the open tasks are blocked");
    expect(slide.body).not.toContain("## Half the open tasks are blocked");
    expect(slide.body.trim()).toBe(
      "Twelve of twenty-three are waiting on review."
    );
  });

  it("keeps a heading that is NOT the first node — removing it would hole the prose", () => {
    const doc = `::::synap-section{round="analyze"}
A lead-in paragraph.

## The claim arrives late

And then the evidence.
::::
`;
    const [slide] = segmentSlides(doc);
    expect(slide.title).toBe("The claim arrives late");
    expect(slide.body).toContain("A lead-in paragraph.");
    expect(slide.body).toContain("## The claim arrives late");
  });

  it("body === content for a headless section (nothing was promoted)", () => {
    const doc = `::::synap-section{agent="strategist" round="relate"}
This connects to the Q3 roadmap.
::::
`;
    const [slide] = segmentSlides(doc);
    expect(slide.body).toBe(slide.content);
  });

  it("strips the heading in tier 2 as well", () => {
    const slides = segmentSlides("# A\n\n## B\n\nBody.\n");
    expect(slides[1].content).toContain("## B");
    expect(slides[1].body.trim()).toBe("Body.");
  });
});

describe("segmentSlides — isTitleSlide", () => {
  it("marks the preamble slide of a generated report", () => {
    const doc = `# Workspace report — July 2026

::::synap-section{round="analyze"}
## A claim
Body.
::::
`;
    const slides = segmentSlides(doc);
    expect(slides[0].isTitleSlide).toBe(true);
    expect(slides[1].isTitleSlide).toBeFalsy();
  });

  it("marks NO slide when the document opens straight into a section", () => {
    // The case that used to leave the document title nowhere on screen: the
    // renderer keyed "this is the title slide" off `index === 0`, suppressed its
    // running head, and slide 0 was a section claim.
    const doc = `::::synap-section{round="analyze"}
## A claim
Body.
::::
`;
    expect(segmentSlides(doc).some((s) => s.isTitleSlide)).toBe(false);
  });

  it("marks a tier-2 leading `#` but not a leading `##`", () => {
    expect(segmentSlides("# A\n\n## B\n\nBody.\n")[0].isTitleSlide).toBe(true);
    expect(segmentSlides("# A\n\n## B\n\nBody.\n")[1].isTitleSlide).toBeFalsy();
    expect(
      segmentSlides("## Only a section\n\nBody.\n")[0].isTitleSlide
    ).toBeFalsy();
  });

  it("marks the tier-4 whole-document slide", () => {
    expect(segmentSlides("Just a paragraph.")[0].isTitleSlide).toBe(true);
  });
});

describe("segmentSlides — hazard: unterminated directive inside a section", () => {
  it("does not lose content and does not cut a slide boundary through the open container", () => {
    const hazard = `# Report

::::synap-section{round="analyze"}
Before the cell.

:::synap-cell{cellKey="chart"}
Cell body that never closes.

::::synap-section{round="relate"}
This text is INSIDE the unterminated cell's parent per remark-directive's
grammar (an unterminated container runs to the end of its parent), so it
ends up nested inside the FIRST section's content, not as a second
top-level section.
::::
`;

    const slides = segmentSlides(hazard);

    // Only a title slide + ONE section slide exist at the top level — the
    // second "::::synap-section" never closed the first cell, so it was
    // consumed as a child of the open cell/section, not a sibling.
    expect(slides).toHaveLength(2);
    expect(slides[0].id).toBe("title");
    expect(slides[1].attributes?.round).toBe("analyze");

    // Nothing is silently dropped: every substring of the source appears
    // somewhere in the combined slide content.
    const combined = slides.map((s) => s.content).join("\n");
    expect(combined).toContain("Before the cell.");
    expect(combined).toContain("Cell body that never closes.");
    expect(combined).toContain("nested inside the FIRST section's content");

    // No slide's content is truncated mid-directive: the unterminated
    // `:::synap-cell` opener must not appear without also carrying the text
    // that follows it in the source (proving no boundary was cut through
    // the open container).
    const cellSlide = slides.find((s) => s.content.includes(":::synap-cell"));
    expect(cellSlide?.content).toContain(
      "nested inside the FIRST section's content"
    );
  });
});

describe("segmentSlides — tier 2 (headings)", () => {
  it("splits a heading-only document, one slide per top-level heading", () => {
    const doc = `# Weekly Sync

Some intro text.

## Decisions

We decided X.

## Risks

Watch out for Y.
`;
    const slides = segmentSlides(doc);
    expect(slides).toHaveLength(3);
    expect(slides.map((s) => s.title)).toEqual([
      "Weekly Sync",
      "Decisions",
      "Risks",
    ]);
    expect(slides.map((s) => s.id)).toEqual([
      "weekly-sync",
      "decisions",
      "risks",
    ]);
    expect(slides[1].content).toContain("We decided X.");
    expect(slides[1].content).not.toContain("Watch out for Y.");
  });

  it("dedupes ids for repeated heading text", () => {
    const doc = `# Update

## Notes

First.

## Notes

Second.
`;
    const slides = segmentSlides(doc);
    expect(slides.map((s) => s.id)).toEqual(["update", "notes", "notes-2"]);
  });
});

describe("segmentSlides — tier 3 (thematic breaks)", () => {
  it("splits on --- when there are no headings and no sections", () => {
    const doc = `First slide of plain prose.

---

Second slide of plain prose.

---

Third slide.
`;
    const slides = segmentSlides(doc);
    expect(slides).toHaveLength(3);
    expect(slides[0].content.trim()).toBe("First slide of plain prose.");
    expect(slides[1].content.trim()).toBe("Second slide of plain prose.");
    expect(slides[2].content.trim()).toBe("Third slide.");
    expect(slides.map((s) => s.id)).toEqual(["slide-1", "slide-2", "slide-3"]);
  });

  it("headings win over thematic breaks when both are present (fallback, not override)", () => {
    const doc = `# Title

## Section A

Body A.

---

More of section A after a manual break.

## Section B

Body B.
`;
    const slides = segmentSlides(doc);
    // Tier 2 fires first because top-level headings exist; the `---` is
    // just part of Section A's body, not a boundary.
    expect(slides.map((s) => s.title)).toEqual([
      "Title",
      "Section A",
      "Section B",
    ]);
    expect(slides[1].content).toContain(
      "More of section A after a manual break."
    );
  });
});

describe("segmentSlides — edge cases", () => {
  it("returns an empty array for an empty document", () => {
    expect(segmentSlides("")).toEqual([]);
  });

  it("returns an empty array for a whitespace-only document", () => {
    expect(segmentSlides("   \n\n\t \n")).toEqual([]);
  });

  it("falls back to a single slide for plain prose with no boundaries", () => {
    const slides = segmentSlides("Just a paragraph, nothing else.");
    expect(slides).toHaveLength(1);
    expect(slides[0].content).toContain("Just a paragraph, nothing else.");
  });
});

describe("listSections — pinned pre-existing behavior", () => {
  const doc = `# Workspace report — July 2026

::::synap-section{agent="analyst" round="analyze" confidence="0.8"}
The workspace grew 12% month over month.
::::

::::synap-section{agent="strategist" round="relate" confidence="0.6"}
This connects to the Q3 roadmap.
::::
`;

  it("returns exactly the section bodies, dropping the leading title, with no id/index", () => {
    const sections = listSections(doc);
    expect(sections).toEqual([
      {
        attributes: { agent: "analyst", round: "analyze", confidence: "0.8" },
        content: "The workspace grew 12% month over month.",
      },
      {
        attributes: { agent: "strategist", round: "relate", confidence: "0.6" },
        content: "This connects to the Q3 roadmap.",
      },
    ]);
    // No id/index leaked onto ReportSection.
    for (const section of sections) {
      expect(section).not.toHaveProperty("id");
      expect(section).not.toHaveProperty("index");
    }
  });

  it("returns an empty array when there are no top-level sections", () => {
    expect(listSections("# Just a heading\n\nAnd body text.")).toEqual([]);
  });
});
