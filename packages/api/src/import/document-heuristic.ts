/**
 * Long-form content heuristic.
 *
 * Decides whether a piece of captured/imported text is "long-form" enough to be
 * materialized as a REAL versioned document (a `documents` row backed by storage
 * + a `document_versions` v1 snapshot, linked via `entity.documentId`) instead
 * of being stuffed into a short `description` / `properties.content` field.
 *
 * Deliberately deterministic and pure: same input → same answer, no LLM, no DB.
 * Shared by the capture pipeline (capture.execute) and the deterministic import
 * pipeline (importProposalToComposite) so both surfaces make the SAME call —
 * there is exactly one definition of "this is a document".
 */

/** Matches a markdown ATX heading line (`# ` … `###### `). */
const HEADING_RE = /^#{1,6} /gm;
/** Matches a fenced code block opener (``` or ~~~). */
const CODE_FENCE_RE = /^(```|~~~)/m;
/** Matches a markdown list item (-, *, + bullets or `1.` ordered). */
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+\.)\s+\S/gm;
/** Splits on one-or-more blank lines (paragraph boundaries). */
const PARAGRAPH_SPLIT_RE = /\n\s*\n/;

/** Length at/above which content is always treated as long-form. */
const LONG_FORM_LENGTH = 600;

function countMatches(re: RegExp, text: string): number {
  // re carries the global flag; matchAll is safe and doesn't keep lastIndex state.
  let count = 0;
  for (const _ of text.matchAll(re)) count++;
  return count;
}

/**
 * True when `content` reads as long-form markdown that deserves to become a
 * versioned document. Returns false for short facts / one-liners, which should
 * stay as a property/description on the entity.
 *
 * Long-form when EITHER:
 *   - length ≥ 600 chars, OR
 *   - it has markdown structure: ≥2 headings, OR a code fence, OR ≥3 list
 *     items, OR ≥4 blank-line-separated paragraphs.
 */
export function shouldMaterializeAsDocument(content: string): boolean {
  if (!content) return false;
  const text = content.trim();
  if (!text) return false;

  if (text.length >= LONG_FORM_LENGTH) return true;

  const headingCount = countMatches(HEADING_RE, text);
  if (headingCount >= 2) return true;

  if (CODE_FENCE_RE.test(text)) return true;

  const listItemCount = countMatches(LIST_ITEM_RE, text);
  if (listItemCount >= 3) return true;

  const paragraphCount = text
    .split(PARAGRAPH_SPLIT_RE)
    .filter((p) => p.trim().length > 0).length;
  if (paragraphCount >= 4) return true;

  return false;
}
