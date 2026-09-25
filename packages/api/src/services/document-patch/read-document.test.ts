/**
 * The agent-facing read projection: `format: readable` and `sections[]`.
 */

import { describe, it, expect } from "vitest";
import {
  listDocumentSections,
  projectAgentDocument,
  readableMarkdown,
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

  it("a check that could not run is null + a reason, never an empty list", () => {
    const out = projectAgentDocument(row, raw, "raw", {
      items: null,
      error: "catalog down",
    });
    expect(out.diagnostics).toBeNull();
    expect(out.diagnosticsError).toBe("catalog down");
  });
});
