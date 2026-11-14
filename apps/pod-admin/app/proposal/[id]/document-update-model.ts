/**
 * What a document-update proposal can SHOW when the document is an HTML page:
 * the new page, the old page, both whole.
 *
 * Why this is not `documentChanges`. That reads the proposal's `preview`, a
 * list of changed REGIONS cut by a Markdown sectioner. For an HTML page the cut
 * lands mid-`<style>`: on the proposal this was written for, both sides began
 * inside the stylesheet and the "after" was 21,946 characters of a 23,201
 * character page. Text like that reads as garble in a diff and cannot be drawn
 * as a page. The COMPLETE pages are elsewhere in the same proposal:
 *
 *   after   `payload.ops[0].content` of a single `replace_all` op, present from
 *           the moment the proposal is filed; once approved,
 *           `envelope.materialized.documentEdit.changes[0].after` is what was
 *           applied.
 *   before  only stamped at approval, in `materialized…changes[0].before`. While
 *           the proposal is open the pod does not carry it, so the page reads
 *           the document's current content (that IS the base the edit applies
 *           to: the pod refuses an approval whose base has moved).
 *
 * Pure: the page reads the live document and passes it in.
 */

import { isHtmlPageSource } from "@synap-core/types/renderables";

/** A whole-body replacement that could be an HTML page: the one shape drawn. */
export interface HtmlReplaceCandidate {
  /** The new page, whole (the op's `content`). */
  after: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The new page when the proposal replaces the whole body with something that
 * opens like HTML, else null. Exactly one op, and it must be `replace_all`: a
 * patch (`replace_section`, an append) carries only a piece, and a piece is not
 * a page. Opening with `<` is only a pre-filter (a Markdown document can start
 * with a tag): the document's own type decides (`isHtmlDocument`).
 */
export function htmlReplaceCandidate(
  payload: unknown
): HtmlReplaceCandidate | null {
  const ops = record(payload)?.ops;
  if (!Array.isArray(ops) || ops.length !== 1) return null;
  const op = record(ops[0]);
  if (!op || op.op !== "replace_all") return null;
  const content = op.content;
  if (typeof content !== "string" || !isHtmlPageSource(content)) return null;
  return { after: content };
}

/** The document's own type says it is an HTML page. */
export function isHtmlDocument(document: unknown): boolean {
  return record(document)?.type === "html";
}

/** What approval stamped: the page as it was and as it became, whole. */
export interface AppliedEdit {
  before: string;
  after: string;
}

/**
 * The stamped edit of an approved proposal (`envelope.materialized.
 * documentEdit.changes[0]`), when it holds two whole texts, else null.
 */
export function appliedEdit(envelope: unknown): AppliedEdit | null {
  const edit = record(record(record(envelope)?.materialized)?.documentEdit);
  const changes = edit?.changes;
  if (!Array.isArray(changes) || changes.length !== 1) return null;
  const change = record(changes[0]);
  if (!change) return null;
  const { before, after } = change;
  if (typeof before !== "string" || typeof after !== "string") return null;
  return { before, after };
}

/** What the page shows as the two sides, and which readings that allows. */
export interface HtmlPages {
  /** The new page, always known. */
  after: string;
  /** The old page, or null when it cannot be known honestly. */
  before: string | null;
}

/** An approved proposal's body is now the document itself, not its "before". */
function isApplied(status: string): boolean {
  return status === "approved" || status === "auto_approved";
}

/**
 * The two pages to draw. `liveContent` is the document's content as the viewer
 * reads it now (null while unread or when the read failed).
 *
 *   approved, edit stamped   both sides from the stamp (what was applied).
 *   approved, nothing stamped before unknown: the document now holds the AFTER,
 *                            so using it as "before" would draw two identical
 *                            pages and call it a diff.
 *   still open / rejected    after from the op, before from the live document.
 */
export function htmlPages(input: {
  status: string;
  candidate: HtmlReplaceCandidate;
  envelope: unknown;
  liveContent: string | null;
}): HtmlPages {
  const stamped = appliedEdit(input.envelope);
  if (stamped) return { before: stamped.before, after: stamped.after };
  if (isApplied(input.status)) {
    return { before: null, after: input.candidate.after };
  }
  return { before: input.liveContent, after: input.candidate.after };
}

/** The readings on offer, in order; the first is where it opens. */
export type HtmlReading = "result" | "side" | "lines";

/**
 * Result always (the new page is known). Before | After and Lines need both
 * pages whole and different: with no change between them there is nothing to
 * compare, and the panel says so instead of drawing the same page twice.
 */
export function htmlReadings(pages: HtmlPages): HtmlReading[] {
  if (pages.before === null || pages.before === pages.after) return ["result"];
  return ["result", "side", "lines"];
}

/** True when both pages are known and the same: nothing changes. */
export function htmlUnchanged(pages: HtmlPages): boolean {
  return pages.before !== null && pages.before === pages.after;
}
