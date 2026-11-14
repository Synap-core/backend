import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stripComments } from "../../../../../scripts/strip-comments.mjs";

vi.mock("../../../lib/trpc", () => ({
  trpc: { useUtils: () => ({ client: {} }) },
}));

import { HtmlPagesPanel } from "./DocumentUpdateChanges";

const HEAD = "<!doctype html><html><head><style>:root{--a:1}</style></head>";
const BEFORE = `${HEAD}<body><h1>OLD-HEADLINE</h1><p>shared</p></body></html>`;
const AFTER = `${HEAD}<body><h1>NEW-HEADLINE</h1><p>shared</p></body></html>`;

const draw = (
  pages: { before: string | null; after: string },
  defaultReading?: "result" | "side" | "lines"
) =>
  renderToStaticMarkup(
    <HtmlPagesPanel
      pages={pages}
      workspaceId={null}
      defaultReading={defaultReading}
    />
  );

/** The reading switch, by its label: the preview door has Page / Source tabs of its own. */
const READING_SWITCH = 'aria-label="Read this change as"';

const frames = (html: string) => html.match(/<iframe\b[^>]*>/g) ?? [];
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

describe("HtmlPagesPanel — the readings of an HTML page's update", () => {
  it("Result: the new page, in one script-only frame", () => {
    const html = draw({ before: BEFORE, after: AFTER });
    expect(frames(html)).toHaveLength(1);
    expect(frames(html)[0]).toContain('sandbox="allow-scripts"');
    expect(html).toContain("NEW-HEADLINE");
    expect(html).not.toContain("OLD-HEADLINE");
  });

  it("Before | After: both pages rendered, each under its name", () => {
    const html = draw({ before: BEFORE, after: AFTER }, "side");
    expect(frames(html)).toHaveLength(2);
    for (const f of frames(html)) {
      expect(f).toContain('sandbox="allow-scripts"');
    }
    // Before first, After second, each name a heading over its frame.
    const heads = [...html.matchAll(/<h4[^>]*>([^<]+)<\/h4>/g)].map(
      (m) => m[1]
    );
    expect(heads).toEqual(["Before", "After"]);
    // Each page is where its name says. An index of -1 (a page missing) must
    // not pass for "before comes first", so each position is required.
    const oldAt = html.indexOf("OLD-HEADLINE");
    const newAt = html.indexOf("NEW-HEADLINE");
    expect(oldAt).toBeGreaterThan(-1);
    expect(newAt).toBeGreaterThan(-1);
    expect(oldAt).toBeLessThan(newAt);
    expect(html.match(/OLD-HEADLINE/g)).toHaveLength(1);
    expect(html.match(/NEW-HEADLINE/g)).toHaveLength(1);
  });

  it("Before | After keeps each page whole (the head the cut preview never had)", () => {
    const html = draw({ before: BEFORE, after: AFTER }, "side");
    expect(html.match(/:root\{--a:1\}/g)).toHaveLength(2);
  });

  it("Lines: the source of both whole pages, line by line, no frame", () => {
    const html = draw({ before: BEFORE, after: AFTER }, "lines");
    expect(frames(html)).toHaveLength(0);
    const out = text(html);
    expect(out).toContain("OLD-HEADLINE");
    expect(out).toContain("NEW-HEADLINE");
  });

  it("an unknown old page: the result alone, no tabs, and the reason", () => {
    const html = draw({ before: null, after: AFTER }, "side");
    // Asked for a reading it cannot give, it falls back to the result.
    expect(frames(html)).toHaveLength(1);
    expect(html).toContain("NEW-HEADLINE");
    expect(html).not.toContain(READING_SWITCH);
    expect(text(html)).toContain("only the result is shown");
  });

  it("an unchanged page is said to be unchanged, drawn once", () => {
    const html = draw({ before: AFTER, after: AFTER }, "lines");
    expect(frames(html)).toHaveLength(1);
    expect(text(html)).toContain("The page is the same before and after.");
    expect(html).not.toContain(READING_SWITCH);
  });

  it("with two pages the three readings are on offer as tabs", () => {
    const html = draw({ before: BEFORE, after: AFTER });
    expect(html).toContain(READING_SWITCH);
    const out = text(html);
    expect(out).toContain("Result");
    expect(out).toContain("Before | After");
    expect(out).toContain("Lines");
  });
});

describe("an unapproved page reads nothing of the viewer's pod", () => {
  // Whether a frame mounts the data bridge is not visible in static markup, so
  // this reads the source (comments stripped): every page this panel draws is a
  // proposal's, which nobody has approved, and a page the agent wrote must not
  // be answered with the viewer's own reads. `HtmlPagePreview` is the door that
  // cannot be given a bridge; a direct frame here would need one decided.
  const SOURCE = stripComments(
    readFileSync(
      fileURLToPath(new URL("./DocumentUpdateChanges.tsx", import.meta.url)),
      "utf8"
    ),
    "ts"
  );

  it("draws its three pages (Result, Before, After) through the preview door", () => {
    // An empty scan cannot pass.
    expect(SOURCE.match(/<HtmlPagePreview\b/g)).toHaveLength(3);
  });

  it("never mounts a frame of its own", () => {
    expect(SOURCE).not.toMatch(
      /\b(?:HtmlFrame|SandboxedFrame|HtmlPageBody|HtmlPageSection)\b/
    );
  });
});
