/**
 * Layout A (founder, 2026-10-28): an object page with a rail — a session —
 * reads at a document's width in BOTH frames, with its body beside the rail
 * and the facts at the rail's foot. Widths are asserted as the classes they
 * produce: a width prop proven only by its signature is not proven
 * (`receiver-shell.test.ts`).
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  usePathname: () => "/sessions/s-1",
  useRouter: () => ({ replace() {}, push() {} }),
  useSearchParams: () => new URLSearchParams(),
}));

import { consoleWidth } from "./object-frame";
import { openWidth } from "../../../open/open-shell";
import { pageShellClass } from "../../../(admin)/components/page-header";
import { receiverWidthClass } from "../../receiver-shell";
import { ObjectPage } from "../object-page";

describe("a page with a rail reads wide in either frame", () => {
  it("the console column widens past the 1100px one", () => {
    expect(consoleWidth({ rail: "x" }, undefined)).toBe("wide");
    expect(pageShellClass("wide")).not.toBe(pageShellClass("console"));
    expect(pageShellClass("wide")).toContain("max-w-[1480px]");
  });

  it("the receiver card draws at a document's width", () => {
    const width = openWidth({ rail: "x" });
    expect(width).toBe("lg");
    expect(receiverWidthClass(width!)).toBe(receiverWidthClass("lg"));
  });

  it("a page without one keeps its frame's width", () => {
    expect(consoleWidth({}, undefined)).toBeUndefined();
    expect(consoleWidth({}, "personal")).toBe("personal");
    expect(openWidth({})).toBeUndefined();
  });
});

describe("ObjectPage's rail", () => {
  const header = { kind: "session", title: "Founder doors" };
  const facts = [{ label: "Started", value: "28 Oct" }];

  it("draws the rail beside the body, the facts at its foot", () => {
    const html = renderToStaticMarkup(
      <ObjectPage
        header={header}
        facts={facts}
        rail={<p>CRITERIA-HERE</p>}
        railLabel="Criteria, deliverables and facts"
      >
        <p>REPORT-HERE</p>
      </ObjectPage>
    );
    const aside = html.match(/<aside[^>]*>([\s\S]*)<\/aside>/);
    expect(aside?.[0]).toContain(
      'aria-label="Criteria, deliverables and facts"'
    );
    const rail = aside?.[1] ?? "";
    expect(rail).toContain("CRITERIA-HERE");
    expect(rail).toContain("Started");
    expect(rail.indexOf("CRITERIA-HERE")).toBeLessThan(rail.indexOf("Started"));
    // The body is not in the rail, and comes first (a phone reads it first).
    expect(rail).not.toContain("REPORT-HERE");
    expect(html.indexOf("REPORT-HERE")).toBeLessThan(html.indexOf("<aside"));
  });

  it("without a rail: no aside, the facts above the body as before", () => {
    const html = renderToStaticMarkup(
      <ObjectPage header={header} facts={facts}>
        <p>REPORT-HERE</p>
      </ObjectPage>
    );
    expect(html).not.toContain("<aside");
    expect(html.indexOf("Started")).toBeLessThan(html.indexOf("REPORT-HERE"));
  });
});
