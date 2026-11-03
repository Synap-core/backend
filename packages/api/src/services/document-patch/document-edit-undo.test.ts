/**
 * Document edit Undo, the pure half (decision 6c5e9642): the record a write
 * stamps, and putting it back against the document as it is NOW.
 *
 * The edits are produced by the REAL renderer (`renderDocumentPatch`), so the
 * record is built from the exact text the door writes, never a hand-built
 * block. Rows chosen where the candidate rules disagree:
 *   - "restore the previous version" vs the right rule → a section edited
 *     since must be KEPT while its neighbour is put back;
 *   - "restore every recorded section" vs the right rule → the same row;
 *   - "a section the edit added stays" vs the right rule → it is removed;
 *   - a whole-body edit: nothing put back once anything changed since.
 */

import { describe, it, expect } from "vitest";
import { renderDocumentPatch, type DocumentPatchOp } from "./patch-ops.js";
import {
  buildDocumentEditRecord,
  documentEditUndoBlocker,
  planDocumentEditUndo,
} from "./document-edit-undo.js";

const DOC = "doc-1";
const AGENT = { isMachine: true, author: "agent-1" };
const NOW = "2026-11-03T10:00:00.000Z";

const ai = (id: string, body: string) =>
  [
    `::::synap-section{id="${id}" owner="ai"}`,
    `## ${id}`,
    "",
    body,
    "::::",
  ].join("\n");
const SECTIONED = [
  "# Plan",
  "",
  "We ship on Friday.",
  "",
  ai("a", "Alpha."),
  "",
  ai("b", "Beta."),
  "",
].join("\n");

function edit(content: string, ops: DocumentPatchOp[]) {
  const after = renderDocumentPatch(content, ops, {
    writer: AGENT,
    now: NOW,
  }).markdown;
  return {
    after,
    record: buildDocumentEditRecord({
      documentId: DOC,
      before: content,
      after,
      rename: null,
    }),
  };
}

describe("buildDocumentEditRecord", () => {
  it("records each changed section block before and after (an added one with an empty before)", () => {
    const { record } = edit(SECTIONED, [
      { op: "upsert_section", id: "a", title: "a", body: "Alpha, rewritten." },
      { op: "upsert_section", id: "c", title: "c", body: "Gamma." },
    ]);
    expect(record.granularity).toBe("sections");
    expect(record.changes.map((c) => c.sectionId)).toEqual(["a", "c"]);
    expect(record.changes[0]!.before).toBe(ai("a", "Alpha."));
    expect(record.changes[0]!.after).toContain("Alpha, rewritten.");
    expect(record.changes[1]!.before).toBe("");
  });

  it("text outside every section is recorded as the whole body", () => {
    const { after, record } = edit(SECTIONED, [
      { op: "replace_text", old: "on Friday", new: "on Monday" },
    ]);
    expect(record.granularity).toBe("body");
    expect(record.changes).toEqual([
      { sectionId: null, title: null, before: SECTIONED, after },
    ]);
  });

  it("falls back to the whole body when undoing section by section would not give back the exact text", () => {
    // No trailing newline: the appended section's removal cannot recreate it.
    const content = "# Plan\n\nWe ship on Friday.";
    const { record } = edit(content, [
      { op: "upsert_section", id: "c", title: "c", body: "Gamma." },
    ]);
    expect(record.granularity).toBe("body");
  });
});

describe("planDocumentEditUndo", () => {
  it("an edit nobody touched since is put back byte for byte (rewritten section restored, added section removed)", () => {
    const { after, record } = edit(SECTIONED, [
      { op: "upsert_section", id: "a", title: "a", body: "Alpha, rewritten." },
      { op: "upsert_section", id: "c", title: "c", body: "Gamma." },
    ]);
    const plan = planDocumentEditUndo(
      { content: after, title: "Plan" },
      record
    );
    expect(plan.content).toBe(SECTIONED);
    expect(plan.restored).toBe(2);
    expect(plan.skipped).toEqual([]);
  });

  it("a section edited since is KEPT and named; the others are still put back", () => {
    const { after, record } = edit(SECTIONED, [
      { op: "upsert_section", id: "a", title: "a", body: "Alpha, rewritten." },
      { op: "upsert_section", id: "b", title: "b", body: "Beta, rewritten." },
    ]);
    const since = after.replace("Beta, rewritten.", "Beta, the person's.");
    const plan = planDocumentEditUndo(
      { content: since, title: "Plan" },
      record
    );
    expect(plan.restored).toBe(1);
    expect(plan.content).toContain("\nAlpha.\n");
    expect(plan.content).not.toContain("Alpha, rewritten.");
    expect(plan.content).toContain("Beta, the person's.");
    expect(plan.skipped).toEqual([
      {
        target: {
          kind: "document_section",
          documentId: DOC,
          sectionId: "b",
          title: "b",
        },
        reason: "edited_since",
        detail: 'section "b" was edited since',
      },
    ]);
  });

  it("a section removed since is named as no longer there", () => {
    const { after, record } = edit(SECTIONED, [
      { op: "upsert_section", id: "c", title: "c", body: "Gamma." },
    ]);
    const since = after.slice(0, after.indexOf('::::synap-section{id="c"'));
    const plan = planDocumentEditUndo(
      { content: since, title: "Plan" },
      record
    );
    expect(plan.restored).toBe(0);
    expect(plan.skipped[0]).toMatchObject({
      reason: "not_found",
      detail: 'section "c" is no longer in the document',
    });
  });

  it("a whole-body edit is put back only while the document is exactly as it left it", () => {
    const { after, record } = edit(SECTIONED, [
      { op: "replace_text", old: "on Friday", new: "on Monday" },
    ]);
    expect(
      planDocumentEditUndo({ content: after, title: "Plan" }, record).content
    ).toBe(SECTIONED);
    const since = `${after}A person's line.\n`;
    const plan = planDocumentEditUndo(
      { content: since, title: "Plan" },
      record
    );
    expect(plan.restored).toBe(0);
    expect(plan.content).toBe(since);
    expect(plan.skipped).toEqual([
      {
        target: {
          kind: "document_section",
          documentId: DOC,
          sectionId: null,
          title: null,
        },
        reason: "edited_since",
        detail: "the document was edited since",
      },
    ]);
  });

  it("a rename is put back while the name is still the one it set", () => {
    const record = buildDocumentEditRecord({
      documentId: DOC,
      before: SECTIONED,
      after: SECTIONED,
      rename: { before: "Plan", after: "Launch plan" },
    });
    expect(
      planDocumentEditUndo({ content: SECTIONED, title: "Launch plan" }, record)
    ).toMatchObject({
      rename: { before: "Launch plan", after: "Plan" },
      restored: 1,
      skipped: [],
    });
    const renamedSince = planDocumentEditUndo(
      { content: SECTIONED, title: "Someone's name" },
      record
    );
    expect(renamedSince.rename).toBeNull();
    expect(renamedSince.skipped).toEqual([
      {
        target: { kind: "document_title", documentId: DOC },
        reason: "edited_since",
        detail: "the document was renamed since",
      },
    ]);
  });
});

describe("documentEditUndoBlocker", () => {
  it("a patch of text and sections can be undone, nested or flat", () => {
    const ops = [{ op: "upsert_section", id: "a", title: "a", body: "x" }];
    expect(documentEditUndoBlocker({ ops })).toBeNull();
    expect(documentEditUndoBlocker({ data: { ops } })).toBeNull();
  });

  it("a scope or refresher change cannot (no record covers those fields)", () => {
    for (const op of [
      { op: "set_scope", scope: null },
      { op: "set_refresher", automationId: null },
    ]) {
      expect(
        documentEditUndoBlocker({
          data: { ops: [{ op: "append", body: "x" }, op] },
        })
      ).toMatch(/scope or its refresher/);
    }
  });

  it("the pre-patch full-replace format cannot (its branch records nothing)", () => {
    expect(documentEditUndoBlocker({ proposedContent: "new" })).toMatch(
      /older format/
    );
  });
});
