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

export const DIAGNOSTIC_CODES = [
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
export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

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
  const out = [...diagnostics];
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
