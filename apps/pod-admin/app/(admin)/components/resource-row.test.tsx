/**
 * A state mark shows at every width (founder review, W4a, 21 Nov 2026): a
 * wrapping row used to hide its status pill below `sm`, so a phone saw
 * "Take back" with no "42 of 50 today". The pill now has a narrow twin on its
 * own line under the subline. Deleting that twin turns this test red.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Gauge } from "lucide-react";
import { ResourceRow } from "./resource-row";

const row = (wrap: boolean) =>
  renderToStaticMarkup(
    <ResourceRow
      Icon={Gauge}
      primary="50 writes a day"
      secondary="Scout · Whole pod"
      status={{ kind: "stale", label: "42 of 50 today" }}
      wrap={wrap}
      actions={<button type="button">Take back</button>}
    />
  );

/** The element whose class list holds `cls`, up to the next one. */
function blockWith(html: string, cls: string): string {
  const at = html.search(new RegExp(`class="[^"]*\\b${cls}\\b[^"]*"`));
  return at < 0 ? "" : html.slice(at, at + 1200);
}

describe("ResourceRow state mark", () => {
  it("keeps the mark below sm on a wrapping row, under the subline", () => {
    const html = row(true);
    const narrow = blockWith(html, "sm:hidden");
    expect(narrow).toContain("42 of 50 today");
    // The wide one stays beside the actions from sm up.
    expect(blockWith(html, "sm:block")).toContain("42 of 50 today");
    // Under the subline: inside the text column, after the secondary line.
    expect(html.indexOf("Scout · Whole pod")).toBeLessThan(
      html.indexOf("sm:hidden")
    );
  });

  it("draws one mark on a row that does not wrap", () => {
    const html = row(false);
    expect(html.split("42 of 50 today")).toHaveLength(2);
    expect(html).not.toContain("sm:hidden");
  });
});
