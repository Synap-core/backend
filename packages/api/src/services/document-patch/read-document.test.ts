/**
 * The agent-facing read projection: `format: readable` and `sections[]`.
 */

import { describe, it, expect } from "vitest";
import {
  MARKDOWN_READ_MAX_CHARS,
  currentDiagnostics,
  listDocumentSections,
  projectAgentDocument,
  readableMarkdown,
  readOmitsStoredBody,
  readsAsMarkdown,
  readsAsPage,
  unparsedDiagnostics,
} from "./read-document.js";
import { DOCUMENT_DIAGNOSTICS_CHECKER } from "./document-diagnostics.js";

describe("readableMarkdown — embeds become their fallback", () => {
  it("uses the author's fallback prose, dropping the directive and its props", () => {
    const md = [
      "Before.",
      "",
      ':::synap-cell{cellKey="chart-bar"}',
      "```json",
      '{"profileSlug":"task"}',
      "```",
      "",
      "Tasks pile up in **Review**.",
      ":::",
      "",
      "After.",
    ].join("\n");
    expect(readableMarkdown(md)).toBe(
      "Before.\n\nTasks pile up in **Review**.\n\nAfter."
    );
  });

  it("with no fallback: the catalog's template for a cell, the noun for anything else", () => {
    const md = [
      ':::synap-cell{cellKey="chart-bar"}',
      "```json",
      '{"label":"Backlog"}',
      "```",
      ":::",
      "",
      ':::synap-entity{id="11111111-1111-4111-8111-111111111111"}',
      ":::",
    ].join("\n");
    const out = readableMarkdown(md);
    expect(out).not.toContain(":::");
    expect(out).toMatch(/^\*[^*]*Backlog\*/);
    expect(out).toMatch(/\*Entity\*$/);
  });

  it("leaves a document without embeds byte-identical (sections included)", () => {
    const md = '::::synap-section{id="a" owner="ai"}\n## A\n\nText.\n::::\n';
    expect(readableMarkdown(md)).toBe(md);
  });
});

describe("listDocumentSections", () => {
  it("lists each top-level section's id, owner, heading and author", () => {
    const md = [
      '::::synap-section{id="mine" owner="human"}',
      "## My notes",
      "::::",
      "",
      '::::synap-section{id="sum" owner="ai" author="agent-1"}',
      "## Summary",
      "::::",
      "",
      '::::synap-section{id="legacy"}',
      "## Old",
      "::::",
    ].join("\n");
    expect(listDocumentSections(md)).toEqual([
      { id: "mine", owner: "human", title: "My notes", author: null },
      { id: "sum", owner: "ai", title: "Summary", author: "agent-1" },
      // No owner ⇒ a person's: the one mistake the floor must never make.
      { id: "legacy", owner: "human", title: "Old", author: null },
    ]);
  });
});

describe("projectAgentDocument — every field a guarded edit needs arrives", () => {
  const row = {
    id: "d1",
    title: "Plan",
    type: "markdown",
    language: null,
    workspaceId: "ws-1",
    contentRevision: 7,
    currentVersion: 3,
    scope: {
      kind: "project",
      projectId: "22222222-2222-4222-8222-222222222222",
    } as const,
    refreshAutomationId: "55555555-5555-4555-8555-555555555555",
    updatedAt: "2026-09-25T00:00:00.000Z",
    createdAt: "2026-09-24T00:00:00.000Z",
  };
  const raw = '::::synap-section{id="a" owner="ai"}\n## A\n::::\n';

  it("carries revision, version, workspace, sections and diagnostics", () => {
    const out = projectAgentDocument(row, raw, "raw", { items: [] });
    expect(out).toMatchObject({
      revision: 7,
      version: 3,
      workspaceId: "ws-1",
      format: "raw",
      content: raw,
      sections: [{ id: "a", owner: "ai", title: "A", author: null }],
      diagnostics: [],
    });
    expect(out).not.toHaveProperty("diagnosticsError");
  });

  it("carries the living document's scope and refresher (0387)", () => {
    const out = projectAgentDocument(row, raw, "raw", { items: [] });
    expect(out.scope).toEqual({
      kind: "project",
      projectId: "22222222-2222-4222-8222-222222222222",
    });
    expect(out.refreshAutomationId).toBe(
      "55555555-5555-4555-8555-555555555555"
    );
    const bare = projectAgentDocument(
      { ...row, scope: null, refreshAutomationId: null },
      raw,
      "raw",
      { items: [] }
    );
    expect(bare.scope).toBeNull();
    expect(bare.refreshAutomationId).toBeNull();
  });

  it("a check that could not run is null + a reason, never an empty list", () => {
    const out = projectAgentDocument(row, raw, "raw", {
      items: null,
      error: "catalog down",
    });
    expect(out.diagnostics).toBeNull();
    expect(out.diagnosticsError).toBe("catalog down");
  });
});

describe("readsAsMarkdown — a read never parses a file or an oversized document", () => {
  // 3 Nov 2026: reading a 126 MB video (type `file`) parsed its bytes as
  // markdown for 60-110 s per read, and the pod answered nothing else.
  it("parses a markdown or text document up to the cap", () => {
    expect(readsAsMarkdown({ type: "markdown" }, "# Plan")).toBe(true);
    expect(
      readsAsMarkdown({ type: "markdown", mimeType: "text/markdown" }, "# A")
    ).toBe(true);
    expect(readsAsMarkdown({ type: "text", mimeType: null }, "notes")).toBe(
      true
    );
    expect(
      readsAsMarkdown({ type: "markdown" }, "x".repeat(MARKDOWN_READ_MAX_CHARS))
    ).toBe(true);
  });

  it("never parses a stored file, whatever its size", () => {
    expect(
      readsAsMarkdown({ type: "file", mimeType: "video/mp4" }, "\u0000ftyp")
    ).toBe(false);
    expect(readsAsMarkdown({ type: "pdf" }, "%PDF-1.7")).toBe(false);
  });

  it("never parses a text row holding audio (output.wav stored as text)", () => {
    expect(
      readsAsMarkdown({ type: "text", mimeType: "audio/wav" }, "RIFF")
    ).toBe(false);
  });

  it("never parses a document longer than the cap", () => {
    expect(
      readsAsMarkdown(
        { type: "markdown" },
        "x".repeat(MARKDOWN_READ_MAX_CHARS + 1)
      )
    ).toBe(false);
  });
});

describe("projectAgentDocument — a file reads as stored, unparsed", () => {
  const file = {
    id: "v1",
    title: "free-take-v1-draft.mp4",
    type: "file",
    mimeType: "video/mp4",
    language: null,
    workspaceId: "ws-1",
    contentRevision: 1,
    currentVersion: 1,
    scope: null,
    refreshAutomationId: null,
    updatedAt: "2026-10-31T00:00:00.000Z",
    createdAt: "2026-10-31T00:00:00.000Z",
  };
  // Text the parse would change: a section and an embed with a fallback.
  const raw = [
    '::::synap-section{id="a" owner="ai"}',
    "## A",
    ':::synap-cell{cellKey="chart-bar"}',
    "Fallback.",
    ":::",
    "::::",
  ].join("\n");

  it("returns the content as stored even when `readable` is asked, with no sections", () => {
    const out = projectAgentDocument(
      file,
      raw,
      "readable",
      unparsedDiagnostics(file, raw)
    );
    expect(out.content).toBe(raw);
    expect(out.sections).toEqual([]);
  });

  it("says its diagnostics were not checked, and why", () => {
    const out = projectAgentDocument(
      file,
      raw,
      "raw",
      unparsedDiagnostics(file, raw)
    );
    expect(out.diagnostics).toBeNull();
    expect(out.diagnosticsError).toBe(
      "Not checked: a video/mp4 document is not markdown."
    );
  });

  it("a markdown document still gets its readable form and sections", () => {
    const md = { ...file, type: "markdown", mimeType: null };
    const out = projectAgentDocument(md, raw, "readable", { items: [] });
    expect(out.content).not.toBe(raw);
    expect(out.sections.map((s) => s.id)).toEqual(["a"]);
  });
});

describe("readOmitsStoredBody — a read never downloads stored bytes that are not text", () => {
  // 3 Nov 2026: every read of a stored video (46-126 MB) downloaded it whole
  // and decoded it as UTF-8 before anything looked at its type.
  const stored = (type: string, mimeType: string | null) => ({
    type,
    mimeType,
    storageKey: "k/blob",
  });

  it("leaves a video, an audio, an image, a zip in storage", () => {
    expect(readOmitsStoredBody(stored("file", "video/mp4"))).toBe(true);
    expect(readOmitsStoredBody(stored("file", "Video/MP4"))).toBe(true);
    expect(readOmitsStoredBody(stored("text", "audio/wav"))).toBe(true);
    expect(readOmitsStoredBody(stored("file", "image/png"))).toBe(true);
    expect(readOmitsStoredBody(stored("file", "application/zip"))).toBe(true);
    expect(
      readOmitsStoredBody(stored("file", "application/octet-stream"))
    ).toBe(true);
  });

  it("leaves a `file` with no stated type in storage (an upload of bytes)", () => {
    expect(readOmitsStoredBody(stored("file", null))).toBe(true);
  });

  it("reads every text body as today", () => {
    expect(readOmitsStoredBody(stored("markdown", "text/markdown"))).toBe(
      false
    );
    expect(readOmitsStoredBody(stored("markdown", null))).toBe(false);
    expect(readOmitsStoredBody(stored("file", "text/csv"))).toBe(false);
    expect(readOmitsStoredBody(stored("code", "application/json"))).toBe(false);
    expect(readOmitsStoredBody(stored("html", "text/html"))).toBe(false);
    expect(readOmitsStoredBody(stored("whiteboard", null))).toBe(false);
  });

  it("reads a PDF and a DOCX (the IS extracts their text from the body)", () => {
    expect(readOmitsStoredBody(stored("pdf", "application/pdf"))).toBe(false);
    expect(
      readOmitsStoredBody(
        stored(
          "docx",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        )
      )
    ).toBe(false);
  });

  it("an external reference or an inline body has nothing stored to omit", () => {
    expect(
      readOmitsStoredBody({
        type: "file",
        mimeType: "video/mp4",
        storageKey: null,
      })
    ).toBe(false);
  });
});

describe("projectAgentDocument — a body left in storage says so", () => {
  const video = {
    id: "v1",
    title: "free-take-v1-draft.mp4",
    type: "file",
    mimeType: "video/mp4",
    language: null,
    workspaceId: "ws-1",
    contentRevision: 1,
    currentVersion: 1,
    scope: null,
    refreshAutomationId: null,
    updatedAt: "2026-10-31T00:00:00.000Z",
    createdAt: "2026-10-31T00:00:00.000Z",
  };

  it("names the omission and the file door, never an empty document", () => {
    const out = projectAgentDocument(
      video,
      "",
      "raw",
      unparsedDiagnostics(video, ""),
      { fileUrlPath: "/api/hub/files/e1/url" }
    );
    expect(out.content).toBe("");
    expect(out.contentOmitted).toBe("binary");
    expect(out.fileUrlPath).toBe("/api/hub/files/e1/url");
  });

  it("a read that omitted nothing carries neither field", () => {
    const md = { ...video, type: "markdown", mimeType: null };
    const out = projectAgentDocument(md, "# A", "raw", { items: [] });
    expect(out).not.toHaveProperty("contentOmitted");
    expect(out).not.toHaveProperty("fileUrlPath");
  });
});

describe("currentDiagnostics — a stored HTML page is checked as a page (frame policy R3)", () => {
  const CDN_PAGE =
    '<!doctype html><html><head><script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script></head><body><canvas></canvas></body></html>';
  /** A same-revision stamp from the current checker, judged as markdown. */
  const markdownStamp = {
    diagnostics: {
      revision: 3,
      checker: DOCUMENT_DIAGNOSTICS_CHECKER,
      checkedAt: "2026-11-01T00:00:00.000Z",
      items: [
        {
          code: "raw_html",
          severity: "warning",
          message: "Raw HTML in the body.",
          fix: "x",
        },
      ],
    },
  };

  it("a page that loads code from a CDN reads network_code, naming the host, and no stamp is served", async () => {
    const out = await currentDiagnostics({
      documentId: "doc-1",
      workspaceId: null,
      type: "html",
      metadata: markdownStamp,
      revision: 3,
      content: CDN_PAGE,
      readerUserId: "user-1",
    });
    expect(out.items?.map((d) => d.code)).toEqual(["network_code"]);
    expect(out.items?.[0]?.severity).toBe("error");
    expect(out.items?.[0]?.message).toContain("cdn.jsdelivr.net");
    expect(out.items?.[0]?.fix).toBeTruthy();
  });

  it("a self-contained page has nothing to say (never markdown's raw_html)", async () => {
    const out = await currentDiagnostics({
      documentId: "doc-1",
      workspaceId: null,
      type: "html",
      metadata: null,
      revision: 1,
      content:
        "<!doctype html><style>p{color:red}</style><p>Hi</p><script>window.synap.query('views.list')</script>",
      readerUserId: "user-1",
    });
    expect(out).toEqual({ items: [] });
  });
});

describe("readsAsPage — a stored HTML page gets its page check, never a parse", () => {
  it("checks an html page up to the cap", () => {
    expect(readsAsPage({ type: "html" }, "<p>Hi</p>")).toBe(true);
    expect(
      readsAsPage({ type: "html" }, "x".repeat(MARKDOWN_READ_MAX_CHARS))
    ).toBe(true);
  });

  it("never a page longer than the cap, and never another type", () => {
    expect(
      readsAsPage({ type: "html" }, "x".repeat(MARKDOWN_READ_MAX_CHARS + 1))
    ).toBe(false);
    expect(readsAsPage({ type: "file", mimeType: "text/html" }, "<p>")).toBe(
      false
    );
    expect(readsAsPage({ type: "markdown" }, "# A")).toBe(false);
  });
});

describe("currentDiagnostics — a parse that does not finish is 'not checked', and never holds the event loop", () => {
  // Seconds of parse (thousands of embeds and sections, under the read cap):
  // the CPU pool's worker runs it and is stopped at the deadline.
  const heavy = (() => {
    let s = "# Heavy\n\n";
    while (s.length < 600_000)
      s +=
        '## Part\n\nSome **bold** prose.\n\n:::synap-entity{id="11111111-1111-4111-8111-111111111111"}\nFallback.\n:::\n\n- a\n- b\n\n';
    return s;
  })();

  it("past the deadline: { items: null, error } naming why, while a timer kept firing", async () => {
    expect(heavy.length).toBeLessThan(MARKDOWN_READ_MAX_CHARS);
    const before = process.env.SYNAP_CPU_TASK_DEADLINE_MS;
    process.env.SYNAP_CPU_TASK_DEADLINE_MS = "200";
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    try {
      const out = await currentDiagnostics({
        documentId: "doc-1",
        workspaceId: null,
        type: "markdown",
        metadata: null,
        revision: 1,
        content: heavy,
        readerUserId: "user-1",
      });
      expect(out).toEqual({
        items: null,
        error:
          "Diagnostics could not run: the markdown parse for diagnostics ran past its deadline and was stopped (200 ms deadline)",
      });
      expect(ticks).toBeGreaterThanOrEqual(10);
    } finally {
      clearInterval(timer);
      if (before === undefined) delete process.env.SYNAP_CPU_TASK_DEADLINE_MS;
      else process.env.SYNAP_CPU_TASK_DEADLINE_MS = before;
    }
  });
});
