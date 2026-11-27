import { describe, expect, it } from "vitest";
import { buildProposalChanges } from "./changes.js";

/**
 * An HTML page's review card says what the page reads, when approving also
 * places it as a cell, and, for a publish, which reads are frozen onto the
 * public web (surfaces review D2 / S2, security M2, 27 Nov 2026).
 *
 * Rows, each ruling out a wrong outcome:
 *  - a page that declares reads: one "What this page reads" row with each
 *    read as words, no raw `reads` blob (rules out "the reviewer sees JSON or
 *    nothing");
 *  - a page that declares nothing: the row says it can read anything the
 *    viewer sees (rules out "undeclared reads as harmless");
 *  - `placeAs`: an "Also placed as a cell" row, no raw blob;
 *  - an html surface create: its `spec.reads` named the same way;
 *  - a publish carrying `pageReads`: the frozen reads, the withheld reads with
 *    their reason, or "holds no data" for an undeclared page;
 *  - a markdown document: no page rows (rules out "every document gets them").
 */

const byPath = (changes: ReturnType<typeof buildProposalChanges>) =>
  new Map(changes.map((c) => [c.path, c]));

describe("buildProposalChanges — an HTML page's reads", () => {
  it("a page that declares reads: the reads as words, no raw blob", () => {
    const rows = byPath(
      buildProposalChanges(
        {
          title: "Pipeline page",
          type: "html",
          content: "<p>hi</p>",
          reads: [
            { op: "entities.list", params: { profileSlug: "deal" } },
            { op: "lifecycle.board" },
          ],
        },
        "create"
      )
    );
    expect(rows.get("reads")).toMatchObject({
      label: "What this page reads",
      after: ["entities.list (profileSlug: deal)", "lifecycle.board"],
    });
    expect([...rows.keys()].filter((p) => p === "reads")).toHaveLength(1);
  });

  it("a page that declares nothing: it can read anything you can see", () => {
    const rows = byPath(
      buildProposalChanges(
        { title: "Page", type: "html", content: "<p/>" },
        "create"
      )
    );
    expect(String(rows.get("reads")?.after)).toContain(
      "can read anything you can see"
    );
  });

  it("placeAs: approving also places it as a cell", () => {
    const rows = byPath(
      buildProposalChanges(
        {
          title: "Page",
          type: "html",
          content: "<p/>",
          reads: [],
          placeAs: { cellId: "c1", workspaceId: "w" },
        },
        "create"
      )
    );
    expect(rows.get("placeAs")).toMatchObject({
      label: "Also placed as a cell",
    });
    expect(typeof rows.get("placeAs")?.after).toBe("string");
  });

  it("an html surface create names its spec.reads", () => {
    const rows = byPath(
      buildProposalChanges(
        {
          name: "Radar",
          body: "html",
          spec: {
            content: "<p/>",
            reads: [{ op: "views.get", params: { id: "*" } }],
          },
        },
        "create"
      )
    );
    expect(rows.get("reads")?.after).toEqual(["views.get (id: *)"]);
  });

  it("a markdown document: no page rows", () => {
    const rows = byPath(
      buildProposalChanges(
        { title: "Notes", type: "markdown", content: "hi" },
        "create"
      )
    );
    expect(rows.has("reads")).toBe(false);
  });
});

describe("buildProposalChanges — a publish freezes reads onto the public web", () => {
  it("the frozen reads and the withheld ones, no raw pageReads blob", () => {
    const rows = byPath(
      buildProposalChanges(
        {
          op: "publish",
          audience: "public",
          resourceType: "document",
          pageReads: {
            public: ["entities.list (profileSlug: deal)"],
            withheld: ["sessions.list: not a read a published page may carry"],
            undeclared: false,
          },
        },
        "create"
      )
    );
    expect(rows.get("pageReads.public")).toMatchObject({
      label: "Frozen onto the public page",
      after: ["entities.list (profileSlug: deal)"],
    });
    expect(rows.get("pageReads.withheld")?.after).toEqual([
      "sessions.list: not a read a published page may carry",
    ]);
    expect(rows.has("pageReads")).toBe(false);
  });

  it("an undeclared page: its public copy holds no data", () => {
    const rows = byPath(
      buildProposalChanges(
        {
          op: "publish",
          audience: "public",
          pageReads: { public: [], withheld: [], undeclared: true },
        },
        "create"
      )
    );
    expect(String(rows.get("pageReads.public")?.after)).toContain(
      "holds no data"
    );
  });
});
