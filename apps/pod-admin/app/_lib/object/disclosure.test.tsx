/**
 * Finding 47ff4216: the "Advanced" disclosure's chevron pointed LEFT while
 * the section was collapsed (HeroUI's own icon). Pinned on the real panel:
 * the left-pointing path is gone, a right-pointing chevron turns down open.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AdvancedPanel } from "./advanced-panel";
import { DISCLOSURE_INDICATOR_PROPS } from "./disclosure";

/** HeroUI's `ChevronIcon` path: a chevron pointing left. */
const LEFT_CHEVRON = "M15.5 19l-7-7 7-7";

describe("an object page's Advanced disclosure", () => {
  it("never draws HeroUI's left-pointing chevron", () => {
    const html = renderToStaticMarkup(
      <AdvancedPanel ids={[{ label: "Tool id", value: "x" }]} />
    );
    expect(html).toContain("Advanced");
    expect(html).not.toContain(LEFT_CHEVRON);
    expect(html).toContain("lucide-chevron-right");
    // The slot's own "-rotate-90 when open" is replaced, not left to fight.
    const slot = html.match(/<span[^>]*data-slot="indicator"[^>]*>/)?.[0];
    expect(slot, "the indicator slot is drawn").toBeTruthy();
    expect(slot).toContain("data-[open=true]:rotate-90");
    expect(slot).not.toContain("-rotate-90");
  });

  it("turns down when open, never up", () => {
    const cls = DISCLOSURE_INDICATOR_PROPS.classNames.indicator;
    expect(cls).toContain("data-[open=true]:rotate-90");
    expect(cls).not.toContain("-rotate-90");
  });
});
