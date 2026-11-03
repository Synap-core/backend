/**
 * DOCUMENT EDIT UNDO — the pure half: what an applied document patch changed,
 * recorded so it can be put back, and the putting back.
 *
 * Founder decision 6c5e9642: "Undo removes what one run created, never
 * restores a snapshot. Revert archives exactly the rows that run created,
 * restores recorded property diffs, and skips anything the person edited
 * since, saying why." A document edit is undone the same way an entity
 * update is (`computeEntityUpdateDiff`): the write records, at APPLY time,
 * each changed region's text before and after; Undo puts a `before` back ONLY
 * where the document still holds the `after`, and names every region it left
 * alone. Restoring the previous version would wipe every later edit — it is
 * never done here.
 *
 * Two granularities, chosen at the write and PROVEN there:
 *   - `sections`: every changed region is a `::::synap-section` block (an
 *     `upsert_section`, or a text edit inside a section). Each block is
 *     compared and put back on its own, so an edit to another section since
 *     does not stop this one being undone. A section the patch ADDED has an
 *     empty `before`: undo removes it.
 *   - `body`: anything else (text outside sections, a section removed, a
 *     whole-body replace). The whole content is put back only while the
 *     document is still exactly what the write left.
 * `sections` is used only when undoing it on the written text gives back the
 * text before byte for byte (`buildDocumentEditRecord` checks it); otherwise
 * the record falls back to `body`, so an inexact section undo can never land.
 *
 * A rename the patch made (`set_title`) is put back while the name is still
 * the one it set. A patch that sets the scope or the refresher is not
 * undoable (`documentEditUndoBlocker`): no record covers those fields.
 */

import type { RevertSkipReason } from "../reversibility/safe-revert.js";
import { parseSections } from "../session-document/sections.js";
import {
  previewPatch,
  sectionBlocks,
  type PatchRename,
  type SectionBlock,
  type SectionPreview,
} from "./patch-ops.js";

/** What one applied document patch changed — `data.materialized.documentEdit`. */
export interface DocumentEditRecord {
  documentId: string;
  granularity: "sections" | "body";
  /**
   * `sections`: one entry per changed section block (`before` "" = added).
   * `body`: one entry, `sectionId` null, the whole content before and after.
   * Empty when the patch changed no content (a rename only).
   */
  changes: SectionPreview[];
  /** The rename the patch made, when it made one. */
  rename?: PatchRename;
}

/** What an undo names when it leaves a part of the document alone. */
export type DocumentEditTarget =
  | {
      kind: "document_section";
      documentId: string;
      /** null = the whole body (`granularity: "body"`). */
      sectionId: string | null;
      title: string | null;
    }
  | { kind: "document_title"; documentId: string };

/** The same shape as the undo engine's `RevertSkip`, for a document part. */
export interface DocumentEditSkip {
  target: DocumentEditTarget;
  reason: RevertSkipReason;
  detail: string;
}

export interface DocumentEditUndoPlan {
  /** The content to write (the current content when no region is restored). */
  content: string;
  /** The rename that puts the old name back, or null. */
  rename: PatchRename | null;
  /** How many parts (sections, the body, the name) are put back. */
  restored: number;
  skipped: DocumentEditSkip[];
}

/**
 * The patch payload as stored: a pending proposal nests the gate data under
 * `data.data`, a receipt (and an older proposal) carries it flat. The one
 * reading of that shape — `applyApprovedDocumentPatch` reads it here too.
 */
export function documentPatchPayload(data: unknown): Record<string, unknown> {
  const raw = (data ?? {}) as Record<string, unknown>;
  return (
    raw.data && typeof raw.data === "object" && !Array.isArray(raw.ops)
      ? raw.data
      : raw
  ) as Record<string, unknown>;
}

/** Ops whose change no record covers: a patch carrying one cannot be undone. */
const UNRECORDED_FIELD_OPS = ["set_scope", "set_refresher"] as const;

/**
 * Why a document patch proposal can NEVER be undone, or null when it can
 * (once applied and stamped). Read by the planner for an applied row and by
 * the pending prediction alike, so the two cannot disagree.
 */
export function documentEditUndoBlocker(data: unknown): string | null {
  const payload = documentPatchPayload(data);
  if (typeof payload.proposedContent === "string") {
    // The pre-W4b full-replace shape, applied by the inline content branch,
    // which records nothing.
    return "Revert of this document edit is not supported: it was filed in an older format that keeps no record of what it changed.";
  }
  const ops = Array.isArray(payload.ops) ? payload.ops : [];
  if (
    ops.some(
      (op) =>
        !!op &&
        typeof op === "object" &&
        (UNRECORDED_FIELD_OPS as readonly string[]).includes(
          String((op as { op?: unknown }).op)
        )
    )
  ) {
    return "Revert of this document edit is not supported: it changes the document's scope or its refresher, which undo cannot restore.";
  }
  return null;
}

/**
 * The record of a write that turned `before` into `after` (and renamed the
 * document, when `rename`). Section-wise only when proven exact.
 */
export function buildDocumentEditRecord(args: {
  documentId: string;
  before: string;
  after: string;
  rename: PatchRename | null;
}): DocumentEditRecord {
  const { documentId, before, after } = args;
  const rename = args.rename ? { rename: args.rename } : {};
  if (before === after) {
    return { documentId, granularity: "sections", changes: [], ...rename };
  }
  const previews = previewPatch(before, after);
  if (
    previews.length > 0 &&
    previews.every((p) => p.sectionId !== null && p.after !== "")
  ) {
    const candidate: DocumentEditRecord = {
      documentId,
      granularity: "sections",
      changes: previews,
    };
    const proof = restoreText(after, candidate);
    if (proof.skipped.length === 0 && proof.content === before) {
      return { ...candidate, ...rename };
    }
  }
  return {
    documentId,
    granularity: "body",
    changes: [{ sectionId: null, title: null, before, after }],
    ...rename,
  };
}

function sectionName(change: SectionPreview): string {
  return `section "${change.title ?? change.sectionId}"`;
}

/** Cut a block out, leaving one blank line where it was (none at the end). */
function removeBlock(content: string, block: SectionBlock): string {
  const head = content.slice(0, block.start).replace(/\s+$/, "");
  const tail = content.slice(block.end).replace(/^\s+/, "");
  if (!head) return tail;
  if (!tail) return `${head}\n`;
  return `${head}\n\n${tail}`;
}

function restoreText(
  current: string,
  record: DocumentEditRecord
): { content: string; restored: number; skipped: DocumentEditSkip[] } {
  const skipped: DocumentEditSkip[] = [];
  const target = (change: SectionPreview): DocumentEditTarget => ({
    kind: "document_section",
    documentId: record.documentId,
    sectionId: change.sectionId,
    title: change.title,
  });

  if (record.granularity === "body") {
    const change = record.changes[0];
    if (!change) return { content: current, restored: 0, skipped };
    if (current === change.after) {
      return { content: change.before, restored: 1, skipped };
    }
    skipped.push({
      target: target(change),
      reason: "edited_since",
      detail: "the document was edited since",
    });
    return { content: current, restored: 0, skipped };
  }

  let content = current;
  let restored = 0;
  for (const change of record.changes) {
    const parsed = parseSections(content);
    if (parsed.unterminatedId || parsed.duplicateIds.length > 0) {
      skipped.push({
        target: target(change),
        reason: "edited_since",
        detail:
          "the document was edited since and its sections can no longer be located safely",
      });
      continue;
    }
    const block = sectionBlocks(content, parsed).find(
      (b) => b.id === change.sectionId
    );
    if (!block) {
      skipped.push({
        target: target(change),
        reason: "not_found",
        detail: `${sectionName(change)} is no longer in the document`,
      });
      continue;
    }
    if (block.text !== change.after) {
      skipped.push({
        target: target(change),
        reason: "edited_since",
        detail: `${sectionName(change)} was edited since`,
      });
      continue;
    }
    content =
      change.before === ""
        ? removeBlock(content, block)
        : content.slice(0, block.start) +
          change.before +
          content.slice(block.end);
    restored += 1;
  }
  return { content, restored, skipped };
}

/**
 * Undo `record` against the document as it is NOW: each recorded part is put
 * back only while it still holds what the edit wrote; every other part is
 * left alone and named, with why.
 */
export function planDocumentEditUndo(
  current: { content: string; title: string },
  record: DocumentEditRecord
): DocumentEditUndoPlan {
  const text = restoreText(current.content, record);
  let rename: PatchRename | null = null;
  let restored = text.restored;
  const skipped = [...text.skipped];
  if (record.rename) {
    if (current.title === record.rename.after) {
      rename = { before: record.rename.after, after: record.rename.before };
      restored += 1;
    } else {
      skipped.push({
        target: { kind: "document_title", documentId: record.documentId },
        reason: "edited_since",
        detail: "the document was renamed since",
      });
    }
  }
  return { content: text.content, rename, restored, skipped };
}
