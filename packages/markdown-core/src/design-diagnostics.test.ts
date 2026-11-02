/**
 * The design pass (generation contract rules 1, 5, 6, 13, 16): each code is
 * pinned by a document that breaks the rule AND its fixed twin that does not
 * (the negative control inside the test), through `collectDiagnostics` — the
 * door the backend write path reads.
 */

import { describe, expect, it } from "vitest";
import { collectDiagnostics, GRAMMAR_WIRE_CODE } from "./diagnostics.js";
import { DESIGN_DIAGNOSTIC_CODES } from "./design-diagnostics.js";

const ID = "8f14e45f-ceea-4e7d-9b2a-1c2d3e4f5a6b";

function codes(markdown: string): string[] {
  return collectDiagnostics(markdown).map((d) => d.code);
}

describe("empty-heading (rule 6)", () => {
  it("a heading with nothing before the next heading of its level", () => {
    const md = "## Needs you\n\n## Produced\n\nThe report shipped.";
    const found = collectDiagnostics(md).filter(
      (d) => d.code === "empty-heading"
    );
    expect(found.map((d) => d.line)).toEqual([1]);
    expect(found[0]!.message).toContain('"Needs you"');
    expect(found[0]!.severity).toBe("warning");
  });

  it("the last heading of the document with nothing under it", () => {
    expect(codes("Intro.\n\n## Happened")).toEqual(["empty-heading"]);
  });

  it("inside a section block, too", () => {
    const md = '::::synap-section{id="s" owner="ai"}\n## Status\n::::';
    expect(codes(md)).toEqual(["empty-heading"]);
  });

  it("control: content, a deeper heading or an embed fill a heading", () => {
    expect(codes("## A\n\nText.\n\n## B\n\n- one")).toEqual([]);
    expect(codes("## A\n\n### A.1\n\nText.")).toEqual([]);
    expect(
      codes(`## Board\n\n:::synap-view{viewId="${ID}"}\nThe board.\n:::`)
    ).toEqual([]);
  });

  it("an HTML comment is not content", () => {
    expect(codes("## A\n\n<!-- todo -->\n\n## B\n\nx")).toEqual([
      "empty-heading",
    ]);
  });
});

describe("bare-id (rule 5)", () => {
  it("a UUID in prose", () => {
    const found = collectDiagnostics(`Blocked by ${ID} since Monday.`);
    expect(found.map((d) => d.code)).toEqual(["bare-id"]);
    expect(found[0]!.message).toContain(ID);
  });

  it("control: the same id as a door, an embed reference or code", () => {
    expect(codes(`Blocked by [[entity:${ID}|the import]].`)).toEqual([]);
    expect(codes(`:::synap-entity{id="${ID}"}\nThe import.\n:::`)).toEqual([]);
    expect(codes(`Run \`get ${ID}\`.`)).toEqual([]);
  });
});

describe("raw-html (rules 1, 16)", () => {
  it("hand-typed HTML in the body", () => {
    expect(codes('<div style="color:red">Late</div>')).toEqual(["raw-html"]);
  });

  it("control: a comment, or HTML inside a cell's props, is not body markup", () => {
    expect(codes("<!-- a note -->\n\nText.")).toEqual([]);
    expect(
      codes(
        ':::synap-cell{cellKey="html-embed"}\n```json\n{"html":"<div>x</div>"}\n```\nA chart.\n:::'
      )
    ).toEqual([]);
  });
});

describe("banned-phrase (rule 13)", () => {
  it("names the phrase, as info", () => {
    const found = collectDiagnostics("Oops, the import stopped.");
    expect(found.map((d) => [d.code, d.severity])).toEqual([
      ["banned-phrase", "info"],
    ]);
  });

  it("control: plain words pass", () => {
    expect(codes("The import stopped at row 40.")).toEqual([]);
  });
});

describe("wire codes", () => {
  it("every design code renames onto its own wire code, never an embed or layout one", () => {
    const map: Record<string, string> = GRAMMAR_WIRE_CODE;
    for (const code of DESIGN_DIAGNOSTIC_CODES) {
      expect(map[code]).toBe(code.replace(/-/g, "_"));
    }
  });
});
