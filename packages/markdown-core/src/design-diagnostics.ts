/**
 * DESIGN DIAGNOSTICS — where a document breaks the generation contract
 * (design-fit doc 47b24a73 §7), as data. The grammar pass (`diagnostics.ts`)
 * asks "will this render?"; this pass asks "does this read the way a Synap
 * page reads?".
 *
 * Catalog-agnostic like the grammar pass: only what the markdown itself shows.
 * The rules that need the renderables catalog (a list over its cap, a chart
 * snapshot with no finding) live in the backend's catalog pass
 * (`document-diagnostics.ts`). Advisory: these WARN, never reject, and a
 * reader renders the document exactly as before.
 *
 * Rules covered here (contract numbers):
 *   - 6  a heading with nothing under it (`empty-heading`);
 *   - 5  a bare id in prose instead of a door (`bare-id`);
 *   - 1, 16  hand-typed raw HTML in the body, outside a sandboxed cell (`raw-html`);
 *   - 13 a phrase the failure-words door bans (`banned-phrase`).
 */

import type { Node, Parent } from "unist";
import type { Heading, Html, Root, RootContent, Text } from "mdast";
import { visit } from "unist-util-visit";
import { splitInlineMarkers } from "./markers.js";
import type { Diagnostic } from "./diagnostics.js";

export const DESIGN_DIAGNOSTIC_CODES = [
  /** A heading with no content before the next heading of the same or a higher level. */
  "empty-heading",
  /** A UUID written in prose: a reader sees an id, not a door to the thing. */
  "bare-id",
  /** Raw HTML typed into the body (it draws as text or not at all, and owns no theme). */
  "raw-html",
  /** "Oops", "Sorry", "Something went wrong": words the product never says. */
  "banned-phrase",
] as const;
export type DesignDiagnosticCode = (typeof DESIGN_DIAGNOSTIC_CODES)[number];

const UUID_IN_TEXT_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

/** The failure-words door's banned phrases (`feedback-and-forms.md` §4). */
const BANNED_PHRASE_RE = /\b(oops|sorry|something went wrong)\b/i;

/** An HTML comment is an author's note, not markup that draws. */
const HTML_COMMENT_RE = /^\s*<!--[\s\S]*-->\s*$/;

function hasChildren(node: Node): node is Parent {
  return Array.isArray((node as Parent).children);
}

/** Headings in one block list whose run, up to the next heading of the same or higher level, holds nothing. */
function emptyHeadings(children: readonly RootContent[]): Heading[] {
  const empty: Heading[] = [];
  children.forEach((node, i) => {
    if (node.type !== "heading") return;
    let hasContent = false;
    for (let j = i + 1; j < children.length; j++) {
      const next = children[j]!;
      if (next.type === "heading" && next.depth <= node.depth) break;
      if (next.type === "html" && HTML_COMMENT_RE.test(next.value)) continue;
      hasContent = true;
      break;
    }
    if (!hasContent) empty.push(node);
  });
  return empty;
}

function headingText(heading: Heading): string {
  let out = "";
  visit(heading as Node, "text", (t: Text) => {
    out += t.value;
  });
  return out.trim();
}

/** Every design diagnostic for an already-parsed tree, in source order. */
export function designDiagnostics(tree: Root): Diagnostic[] {
  const out: Diagnostic[] = [];

  visit(tree as Node, (node: Node) => {
    if (!hasChildren(node)) return;
    for (const heading of emptyHeadings(node.children as RootContent[])) {
      const title = headingText(heading);
      out.push({
        code: "empty-heading",
        severity: "warning",
        message: `The heading${title ? ` "${title}"` : ""} has nothing under it; a heading over nothing promises content that is not there.`,
        line: heading.position?.start.line,
      });
    }
  });

  visit(tree as Node, "text", (node: Text) => {
    const prose = splitInlineMarkers(node.value)
      .filter((s) => s.type === "text")
      .map((s) => (s as { value: string }).value)
      .join(" ");
    const id = UUID_IN_TEXT_RE.exec(prose)?.[0];
    if (id) {
      out.push({
        code: "bare-id",
        severity: "warning",
        message: `"${id}" is a bare id in prose; a reader cannot open it.`,
        line: node.position?.start.line,
      });
    }
    const phrase = BANNED_PHRASE_RE.exec(prose)?.[0];
    if (phrase) {
      out.push({
        code: "banned-phrase",
        severity: "info",
        message: `"${phrase}" is not something Synap says.`,
        line: node.position?.start.line,
      });
    }
  });

  visit(tree as Node, "html", (node: Html) => {
    if (HTML_COMMENT_RE.test(node.value)) return;
    out.push({
      code: "raw-html",
      severity: "warning",
      message:
        "Raw HTML in the body is drawn as text or not at all, and takes no theme.",
      line: node.position?.start.line,
    });
  });

  return out;
}
