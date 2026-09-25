/**
 * The document patch door's PURE half: ops + floors, driven with real markdown
 * through the real section scanner and the real markdown-core parser.
 *
 * Each floor is asserted on the input that DISCRIMINATES it — the edit a
 * weaker rule would let through — not on an input every rule refuses.
 */

import { describe, it, expect } from "vitest";
import {
  DocumentPatchOpsSchema,
  previewPatch,
  removedEmbeds,
  renderDocumentPatch,
  type PatchWriter,
} from "./patch-ops.js";

const AGENT: PatchWriter = { isMachine: true, author: "agent-1" };
const PERSON: PatchWriter = { isMachine: false, author: "user-1" };
const NOW = "2026-09-25T00:00:00.000Z";

const human = (id: string, body: string) =>
  [
    `::::synap-section{id="${id}" owner="human"}`,
    `## ${id}`,
    "",
    body,
    "::::",
  ].join("\n");
const ai = (id: string, body: string) =>
  [
    `::::synap-section{id="${id}" owner="ai"}`,
    `## ${id}`,
    "",
    body,
    "::::",
  ].join("\n");

const CHART = [
  ':::synap-cell{cellKey="chart-bar"}',
  "```json",
  '{"profileSlug":"task"}',
  "```",
  "",
  "Tasks pile up in Review.",
  ":::",
].join("\n");

const DOC = [
  "# Weekly report",
  "",
  "Intro paragraph about the week.",
  "",
  human("mine", "What I think: ship on Friday."),
  "",
  ai("summary", "The AI summary says ship Thursday."),
  "",
  CHART,
  "",
].join("\n");

const render = (content: string, ops: unknown, writer = AGENT, extra = {}) =>
  renderDocumentPatch(content, DocumentPatchOpsSchema.parse(ops), {
    writer,
    now: NOW,
    ...extra,
  });

describe("replace_text — exact once", () => {
  it("replaces the one occurrence", () => {
    const out = render(DOC, [
      { op: "replace_text", old: "Intro paragraph", new: "Opening" },
    ]);
    expect(out.markdown).toContain("Opening about the week.");
    expect(out.markdown.replace("Opening", "Intro paragraph")).toBe(DOC);
  });

  it("refuses zero matches, telling the writer to re-read", () => {
    expect(() =>
      render(DOC, [{ op: "replace_text", old: "not in the doc", new: "x" }])
    ).toThrow(/not found.*get_document/);
  });

  it("refuses two matches with the count (never picks one)", () => {
    // "ship" appears in the human section AND the AI section: 2 matches.
    expect(() =>
      render(DOC, [{ op: "replace_text", old: "ship", new: "launch" }], PERSON)
    ).toThrow(/matches 2 times/);
  });

  it('counts overlapping occurrences ("aa" in "aaa" is ambiguous)', () => {
    expect(() =>
      render("aaa\n", [{ op: "replace_text", old: "aa", new: "b" }], PERSON)
    ).toThrow(/matches 2 times/);
  });
});

describe("the human-section floor", () => {
  it("an agent may not replace_text inside a person's section", () => {
    expect(() =>
      render(DOC, [
        { op: "replace_text", old: "ship on Friday", new: "ship Monday" },
      ])
    ).toThrow(/changes or removes section "mine", which belongs to a person/);
  });

  it("…while a person may, and an agent may edit its own section", () => {
    expect(
      render(
        DOC,
        [{ op: "replace_text", old: "ship on Friday", new: "ship Monday" }],
        PERSON
      ).markdown
    ).toContain("ship Monday");
    expect(
      render(DOC, [
        { op: "replace_text", old: "ship Thursday", new: "ship Wednesday" },
      ]).markdown
    ).toContain("ship Wednesday");
  });

  it("an agent may not upsert over a person's section — and is told what to do instead", () => {
    expect(() =>
      render(DOC, [
        {
          op: "upsert_section",
          id: "mine",
          title: "Mine",
          body: "overwritten",
        },
      ])
    ).toThrow(/belongs to a person.*Write a new section instead/);
  });

  it("an agent replace_all that touches a person's section is refused…", () => {
    const rewritten = DOC.replace("ship on Friday", "ship whenever");
    expect(() =>
      render(DOC, [{ op: "replace_all", content: rewritten }])
    ).toThrow(/section "mine".*belongs to a person/);
  });

  it("…and one that drops it is refused too", () => {
    const dropped = DOC.replace(
      human("mine", "What I think: ship on Friday."),
      ""
    );
    expect(() =>
      render(DOC, [{ op: "replace_all", content: dropped }])
    ).toThrow(/section "mine"/);
  });

  it("…but a replace_all that keeps it byte-for-byte passes", () => {
    const rewritten = DOC.replace(
      "Intro paragraph about the week.",
      "A new intro."
    );
    expect(
      render(DOC, [{ op: "replace_all", content: rewritten }]).markdown
    ).toBe(rewritten);
  });

  it("an agent cannot MINT a person's section (append a forged owner=human block)", () => {
    expect(() =>
      render(DOC, [
        { op: "append", body: human("forged", "The person said yes.") },
      ])
    ).toThrow(/adds section "forged" as a person's section/);
  });

  it("an agent's new section is stamped owner=ai with its author", () => {
    const out = render(DOC, [
      { op: "upsert_section", id: "risks", title: "Risks", body: "None yet." },
    ]);
    expect(out.markdown).toContain(
      `::::synap-section{id="risks" owner="ai" author="agent-1" writtenAt="${NOW}"}`
    );
    expect(out.replacedSections).toEqual([]);
  });
});

describe("the embed floor (Notion MCP #171)", () => {
  it("refuses an edit that removes an embed", () => {
    expect(() =>
      render(DOC, [{ op: "replace_text", old: CHART, new: "" }], PERSON)
    ).toThrow(
      /removes an embed \(synap-cell\{cellKey=chart-bar\}\).*allow_removing_embeds/
    );
  });

  it("allows it when the writer says so", () => {
    const out = render(
      DOC,
      [{ op: "replace_text", old: CHART, new: "" }],
      PERSON,
      {
        allowRemovingEmbeds: true,
      }
    );
    expect(out.markdown).not.toContain("synap-cell");
  });

  it("changing an embed's props or fallback is not a removal", () => {
    const out = render(DOC, [
      {
        op: "replace_text",
        old: "Tasks pile up in Review.",
        new: "Review is the bottleneck.",
      },
    ]);
    expect(out.markdown).toContain("Review is the bottleneck.");
  });

  it("moving an embed keeps it (identity = directive + references, counted)", () => {
    expect(removedEmbeds(`${CHART}\n\ntext\n`, `text\n\n${CHART}\n`)).toEqual(
      []
    );
    expect(removedEmbeds(`${CHART}\n\n${CHART}\n`, `${CHART}\n`)).toEqual([
      "synap-cell{cellKey=chart-bar}",
    ]);
  });
});

describe("well-formedness", () => {
  it("refuses a patch that leaves a section unclosed", () => {
    expect(() =>
      render(
        DOC,
        [
          {
            op: "replace_text",
            old: "ship Thursday.\n::::",
            new: "ship Thursday.",
          },
        ],
        PERSON
      )
    ).toThrow(/would leave the document broken.*never closed/);
  });

  it("refuses a machine writer on a document whose sections cannot be located", () => {
    const broken = '::::synap-section{id="a" owner="ai"}\n## A\n\nno closer\n';
    expect(() => render(broken, [{ op: "append", body: "more" }])).toThrow(
      /cannot be located/
    );
  });

  it("the op schema refuses a bad section id and an empty replace_text", () => {
    expect(
      DocumentPatchOpsSchema.safeParse([
        { op: "upsert_section", id: "Bad Id", title: "t", body: "" },
      ]).success
    ).toBe(false);
    expect(
      DocumentPatchOpsSchema.safeParse([
        { op: "replace_text", old: "", new: "x" },
      ]).success
    ).toBe(false);
    expect(DocumentPatchOpsSchema.safeParse([]).success).toBe(false);
  });
});

describe("ops compose in order", () => {
  it("a later op sees an earlier op's result", () => {
    const out = render(
      "one\n",
      [
        { op: "append", body: "two" },
        { op: "replace_text", old: "two", new: "three" },
      ],
      PERSON
    );
    expect(out.markdown).toBe("one\n\nthree\n");
  });
});

describe("previewPatch — what the reviewer sees, per section", () => {
  it("names the section a patch changed, with before and after", () => {
    const after = DOC.replace("ship Thursday", "ship Wednesday");
    expect(previewPatch(DOC, after)).toEqual([
      {
        sectionId: "summary",
        title: "summary",
        before: ai("summary", "The AI summary says ship Thursday."),
        after: ai("summary", "The AI summary says ship Wednesday."),
      },
    ]);
  });

  it("reports text outside sections as one hunk (only the changed lines)", () => {
    const after = DOC.replace(
      "Intro paragraph about the week.",
      "A new intro."
    );
    expect(previewPatch(DOC, after)).toEqual([
      {
        sectionId: null,
        title: null,
        before: "Intro paragraph about the week.",
        after: "A new intro.",
      },
    ]);
  });

  it("a new section previews from empty, a removed one to empty", () => {
    const added = `${DOC}\n${ai("risks", "None.")}\n`;
    expect(previewPatch(DOC, added)).toEqual([
      {
        sectionId: "risks",
        title: "risks",
        before: "",
        after: ai("risks", "None."),
      },
    ]);
    expect(previewPatch(added, DOC)).toEqual([
      {
        sectionId: "risks",
        title: "risks",
        before: ai("risks", "None."),
        after: "",
      },
    ]);
  });

  it("no change, no preview", () => {
    expect(previewPatch(DOC, DOC)).toEqual([]);
  });
});
