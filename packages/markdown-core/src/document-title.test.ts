import { describe, expect, it } from "vitest";
import {
  bodyWithoutTitleHeading,
  isSameTitle,
  leadingHeading,
  resolveDocumentTitle,
} from "./sections.js";

// Founder 2026-10-19: a document's NAME is its one title; a body that opens
// with a heading equal to it never prints it twice. Each row below names the
// wrong rule it rules out.

describe("resolveDocumentTitle — the producer", () => {
  it("drops a leading heading equal to the given name, keeps the rest byte for byte", () => {
    expect(
      resolveDocumentTitle({
        title: "Launch plan",
        content: "# Launch plan\n\nShip on Friday.\n\n## Risks\n\n- none\n",
      })
    ).toEqual({
      title: "Launch plan",
      content: "Ship on Friday.\n\n## Risks\n\n- none\n",
    });
  });

  it("matches through case, whitespace and markdown marks (not a raw string compare)", () => {
    expect(
      resolveDocumentTitle({
        title: "Pinned surfaces",
        content: "#   **Pinned**   Surfaces\n\nA pin.",
      }).content
    ).toBe("A pin.");
    expect(isSameTitle("`Q3` *plan*", "q3 plan")).toBe(true);
  });

  it("never touches a heading that DIFFERS from the name", () => {
    const content = "# Pinned surfaces\n\nA pin is a profile.\n";
    expect(
      resolveDocumentTitle({ title: "Pinned surfaces — spec", content })
    ).toEqual({ title: "Pinned surfaces — spec", content });
  });

  it("never renames: with a name given, the body's heading cannot change it", () => {
    expect(
      resolveDocumentTitle({ title: "Notes", content: "# Minutes\n\nx" }).title
    ).toBe("Notes");
  });

  it("takes the name from a leading `# ` when none is given, and drops it from the body", () => {
    expect(
      resolveDocumentTitle({
        title: "  ",
        content: "\n\n# Weekly review\nDone.",
      })
    ).toEqual({ title: "Weekly review", content: "Done." });
    expect(
      resolveDocumentTitle({ content: "# Weekly review\n\nDone." }).title
    ).toBe("Weekly review");
  });

  it("derives a name only from a `# ` (a `## ` is a section, not the document's name)", () => {
    const content = "## Risks\n\n- none";
    expect(resolveDocumentTitle({ content })).toEqual({ title: null, content });
  });

  it("drops an equal leading heading of any depth (an agent's `## Name` is still the name twice)", () => {
    expect(
      bodyWithoutTitleHeading("## Launch plan\n\nBody", "Launch plan")
    ).toBe("Body");
  });

  it("reads a setext heading as a heading", () => {
    expect(
      bodyWithoutTitleHeading("Launch plan\n===\n\nBody", "Launch plan")
    ).toBe("Body");
  });

  it("a body that is only the heading stores as empty", () => {
    expect(
      resolveDocumentTitle({ title: "Draft", content: "# Draft\n" }).content
    ).toBe("");
  });
});

describe("bodyWithoutTitleHeading — the reader", () => {
  it("only a heading the body OPENS with: one after a paragraph is content", () => {
    const md = "Intro first.\n\n# Launch plan\n\nBody";
    expect(bodyWithoutTitleHeading(md, "Launch plan")).toBe(md);
  });

  it("a `#` inside a code fence is not a heading", () => {
    const md = "```md\n# Launch plan\n```\n\nBody";
    expect(bodyWithoutTitleHeading(md, "Launch plan")).toBe(md);
    expect(leadingHeading(md)).toBeNull();
  });

  it("a `#` inside an embed is not the body's heading", () => {
    const md = ':::synap-cell{key="kanban"}\n# Launch plan\n:::\n';
    expect(bodyWithoutTitleHeading(md, "Launch plan")).toBe(md);
  });

  it("no name → the body, unchanged (same string)", () => {
    const md = "# Launch plan\n\nBody";
    expect(bodyWithoutTitleHeading(md, "")).toBe(md);
    expect(bodyWithoutTitleHeading(md, null)).toBe(md);
    expect(bodyWithoutTitleHeading("", "Launch plan")).toBe("");
  });

  it("a heading directly followed by prose ends at its own line", () => {
    expect(
      bodyWithoutTitleHeading("# Launch plan\nShip it.", "Launch plan")
    ).toBe("Ship it.");
  });
});
