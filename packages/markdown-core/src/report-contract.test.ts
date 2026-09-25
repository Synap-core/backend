import { describe, it, expect } from "vitest";
import { segmentSlides } from "./sections.js";

/**
 * CONTRACT TEST: the seeded assembler prompt ⇄ this segmenter.
 *
 * These two live in different repos with nothing binding them — the prompt is
 * `ensure-report-automation.ts` in `synap-backend`, the parser is here — so a
 * change to either can silently break the other. That already happened once:
 * the generator emitted no headings, the segmenter fell back to section
 * ATTRIBUTES, and every slide's largest text read "Analyze · analyst" while the
 * 12px row beneath repeated the same two facts.
 *
 * The fixture below MIRRORS the worked example in `ASSEMBLE_SYSTEM` (seed v12).
 * If you change that prompt's output shape, this test must change with it —
 * that is the point. It is the only place the two halves are checked together.
 */
const V12_BODY = `# Workspace report — July 2026

::::synap-section{agent="analyst" round="analyze" confidence="0.8"}
## Half the open tasks are blocked

Twelve open tasks, most untouched since the sprint opened. Notes are thin.
::::

::::synap-section{agent="analyst" round="relate" status="failed" confidence="0.2"}
## The patterns round did not produce material

This section is missing: the patterns round failed.
::::`;

/** A report generated BEFORE v12 — no `##` anywhere. Must still work. */
const PRE_V12_BODY = `# Workspace report — July 2026

::::synap-section{agent="analyst" round="analyze" confidence="0.8"}
Twelve open tasks, most untouched since the sprint opened.
::::`;

describe("report body → slide deck contract", () => {
  it("titles each slide with the CLAIM, never the pipeline round", () => {
    const slides = segmentSlides(V12_BODY);
    const titles = slides.map((s) => s.title);

    // The regression that shipped: a job-runner label as the slide headline.
    for (const t of titles) {
      expect(t).not.toMatch(/^Analyze\b/i);
      expect(t).not.toMatch(/·\s*analyst/i);
    }
    expect(titles).toContain("Half the open tasks are blocked");
    expect(titles).toContain("The patterns round did not produce material");
  });

  it("gives the title slide + one slide per section", () => {
    expect(segmentSlides(V12_BODY)).toHaveLength(3);
  });

  it("a FAILED section still becomes a slide — a missing round must be visible", () => {
    const failed = segmentSlides(V12_BODY).find(
      (s) => s.attributes?.status === "failed"
    );
    expect(failed).toBeDefined();
    expect(failed!.title).toBe("The patterns round did not produce material");
  });

  it("slide ids are stable and derived from the claim, not the position", () => {
    const ids = segmentSlides(V12_BODY).map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.some((id) => id.includes("blocked"))).toBe(true);
  });

  it("BACK-COMPAT: a pre-v12 report still segments and falls back to attributes", () => {
    const slides = segmentSlides(PRE_V12_BODY);
    expect(slides.length).toBeGreaterThan(1);
    // No claim heading exists, so the attribute label is the honest fallback.
    expect(slides[slides.length - 1].title).toMatch(/analy/i);
  });
});
