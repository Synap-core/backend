/**
 * A list count sits in the heading, on the title's row. A sentence stays in
 * the hint, under the title. Reverting `count` back into `hint` puts the
 * number under the title again, and this test goes red.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SectionCard } from "./section-card";

function heading(html: string): string {
  const start = html.indexOf("<h3");
  const end = html.indexOf("</h3>");
  return html.slice(start, end);
}

describe("SectionCard count", () => {
  it("draws the tally in the heading, not under the title", () => {
    const html = renderToStaticMarkup(
      <SectionCard variant="flat" title="What it made" count={2}>
        <p>rows</p>
      </SectionCard>
    );
    expect(heading(html)).toContain("What it made");
    expect(heading(html)).toContain(">2<");
    expect(html).not.toMatch(/text-foreground\/65[^>]*>2</);
  });

  it("draws the same tally in a card heading", () => {
    const html = renderToStaticMarkup(
      <SectionCard title="Sub-sessions" count={3}>
        <p>rows</p>
      </SectionCard>
    );
    expect(heading(html)).toContain("Sub-sessions");
    expect(heading(html)).toContain(">3<");
  });

  it("keeps a sentence under the title, and hides a zero tally", () => {
    const html = renderToStaticMarkup(
      <SectionCard
        variant="flat"
        title="Deliverables"
        count={0}
        hint="Nothing delivered yet"
      >
        <p>rows</p>
      </SectionCard>
    );
    expect(heading(html)).not.toContain(">0<");
    expect(html).toContain("Nothing delivered yet");
    expect(html.indexOf("</h3>")).toBeLessThan(
      html.indexOf("Nothing delivered yet")
    );
  });
});
