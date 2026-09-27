/**
 * DIAGNOSTICS — what a document's markdown gets wrong, as data.
 *
 * Catalog-agnostic on purpose: these codes are about the GRAMMAR (an embed
 * that never closes, props that are not JSON, a reference with no id). Whether
 * a `cellKey` exists is the renderables catalog's question, asked by a caller
 * that has one — this module never imports a catalog.
 *
 * Diagnostics WARN, they never reject: the backend write path attaches them to
 * a result, the editor lints with them, and a reader still renders.
 */

import { visit } from "unist-util-visit";
import type { Node } from "unist";
import { parseMarkdownWithDiagnostics } from "./processor.js";
import { readEmbed } from "./embeds.js";
import { DIRECTIVE_ATTRIBUTES } from "./directive-registry.js";
import { columnsDiagnostics } from "./columns.js";

/**
 * Diagnostics about an EMBED — a `:::synap-*` directive that shows content
 * (entity/view/cell) or is otherwise not a layout container. What a reader
 * cannot render as the thing it names.
 */
export const EMBED_DIAGNOSTIC_CODES = [
  /** A `:::synap-*` embed closed only by its parent or EOF (repaired on read). */
  "unterminated-embed",
  /** Props arrived in the legacy `cellProps` attribute (read; rewritten on save). */
  "legacy-props",
  /** Both a props block and a legacy props attribute; the block wins. */
  "duplicate-props",
  /** The props value is not a JSON object. The embed must show an error, never an empty config. */
  "malformed-props",
  /** An embed with none of the attributes that name what it shows. */
  "missing-ref",
  /** A `synap-*` directive name no reader understands. */
  "unknown-directive",
  /** A `:color[…]` or `==…==` names a tone that is not a Synap tone (it draws plain). */
  "unknown-tone",
] as const;

/**
 * Diagnostics about a columns ROW's layout (columns.md §2.8, `columns.ts`).
 * Readers still render every one of these; the code names what to fix, not
 * something that fails to appear.
 */
export const LAYOUT_DIAGNOSTIC_CODES = [
  /** A `synap-column` outside a `synap-columns` row (the equal-colon mistake). */
  "orphan-column",
  /** A row of columns inside a column. */
  "nested-columns",
  /** A `synap-section` inside columns (invisible to the section door). */
  "section-in-columns",
  /** Content inside a row but outside every column (rendered above the row). */
  "columns-stray-content",
  /** More than `MAX_COLUMNS` columns in one row. */
  "too-many-columns",
  /** A row with one column (renders as flow). */
  "single-column",
  /** A column with no content. */
  "empty-column",
  /** An unreadable width, widths on only some columns, or widths not adding up to 100. */
  "invalid-width",
] as const;

/** Every diagnostic code, derived from the two groups above — never a third list. */
export const DIAGNOSTIC_CODES = [
  ...EMBED_DIAGNOSTIC_CODES,
  ...LAYOUT_DIAGNOSTIC_CODES,
] as const;
export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

/**
 * The WIRE code each grammar diagnostic renders as once it reaches a document
 * patch proposal (`document-diagnostics.ts`'s `diagnoseDocument`, the ONE
 * caller — it imports this instead of hand-duplicating the renaming). Pure
 * data: this module never touches the catalog or access layer, so it owns
 * only the grammar → wire renaming, not the wire codes born elsewhere
 * (`not_found`, `not_visible`, `freeze_failed`).
 *
 * `satisfies Record<DiagnosticCode, string>` is the coverage floor: a new
 * member of `EMBED_DIAGNOSTIC_CODES` / `LAYOUT_DIAGNOSTIC_CODES` with no
 * entry here fails the BUILD (a missing property), not a test that might not
 * be run.
 */
export const GRAMMAR_WIRE_CODE = {
  "unterminated-embed": "unterminated",
  "legacy-props": "legacy_props",
  "duplicate-props": "legacy_props",
  "malformed-props": "bad_props",
  "missing-ref": "missing_attr",
  "unknown-directive": "unknown_key",
  "unknown-tone": "unknown_tone",
  "orphan-column": "bad_columns",
  "nested-columns": "bad_columns",
  "section-in-columns": "bad_columns",
  "columns-stray-content": "bad_columns",
  "too-many-columns": "bad_columns",
  "single-column": "bad_columns",
  "empty-column": "bad_columns",
  "invalid-width": "bad_width",
} as const satisfies Record<DiagnosticCode, string>;

export type GrammarWireCode = (typeof GRAMMAR_WIRE_CODE)[DiagnosticCode];

export interface Diagnostic {
  code: DiagnosticCode;
  severity: "error" | "warning" | "info";
  /** A sentence a person can act on. */
  message: string;
  /** 1-based source line, when known. */
  line?: number;
  /** The directive involved, when there is one. */
  directive?: string;
}

/** Every grammar diagnostic for a markdown document, in source order. */
export function collectDiagnostics(markdown: string): Diagnostic[] {
  const { tree, diagnostics } = parseMarkdownWithDiagnostics(markdown);
  const out = [...diagnostics, ...columnsDiagnostics(tree)];
  visit(
    tree as Node,
    ["textDirective", "leafDirective", "containerDirective"],
    (node: any) => {
      const name: string = node.name ?? "";
      if (!name.startsWith("synap-")) return;
      if (!(name in DIRECTIVE_ATTRIBUTES)) {
        out.push({
          code: "unknown-directive",
          severity: "warning",
          message: `\`${name}\` is not a Synap directive; readers show it as missing.`,
          line: node.position?.start.line,
          directive: name,
        });
        return;
      }
      const embed = readEmbed(node);
      if (embed) out.push(...embed.diagnostics);
    }
  );
  return out.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
}
