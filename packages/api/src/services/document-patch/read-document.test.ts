/**
 * The agent-facing read projection: `format: readable` and `sections[]`.
 */

import { describe, it, expect } from "vitest";
import {
  MARKDOWN_READ_MAX_CHARS,
  listDocumentSections,
  projectAgentDocument,
  readableMarkdown,
  readsAsMarkdown,
  unparsedDiagnostics,
} from "./read-document.js";

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
