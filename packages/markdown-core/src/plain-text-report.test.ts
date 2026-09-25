/**
 * A REPORT PREVIEW IS THE REPORT'S PROSE.
 *
 * The workspace report is `::::synap-section` containers with `[[entity:…]]`
 * chips in their prose. `markdownToPlainText` dropped every directive, section
 * frames included, so a report preview was just its `# title`; and it printed
 * chips as raw markers. Driven from the assembler's own worked-example shape.
 */
import { describe, it, expect } from "vitest";
import { markdownToPlainText } from "./plain-text.js";

const REPORT = `# Workspace report — July 2026

::::synap-section{agent="analyst" round="analyze" confidence="0.8"}
## Most open tasks are stalled at review

The oldest is [[entity:3f2a91c4-7b10-4e55-9c02-8ad1f6e4b2d7|Migrate the billing worker]].
:::synap-cell{cellKey="chart-pie" cellProps='{"label":"Review is where tasks pile up"}'}
:::
::::
`;

describe("markdownToPlainText on a report", () => {
  const out = markdownToPlainText(REPORT);

  it("keeps the section heading and prose", () => {
    expect(out).toContain("Most open tasks are stalled at review");
    expect(out).toContain("The oldest is Migrate the billing worker.");
  });

  it("flattens chips to their label — no marker, no id", () => {
    expect(out).not.toContain("[[");
    expect(out).not.toContain("3f2a91c4");
  });

  it("still drops reference embeds inside the section", () => {
    expect(out).not.toContain("synap-cell");
    expect(out).not.toContain("Review is where tasks pile up");
  });

  it("firstBlockOnly on a report opening with its title yields the title", () => {
    expect(markdownToPlainText(REPORT, { firstBlockOnly: true })).toBe(
      "Workspace report — July 2026"
    );
  });
});
