/**
 * Session document SECTIONS — a narrow splitter for the stored narrative layer.
 *
 * A session document is markdown whose narrative is a run of top-level
 * `::::synap-section{id="…" owner="…" …}` container directives — the same block
 * the markdown engine already renders and paginates
 * (`synap-app/packages/core/markdown-engine/src/renderer/sections.ts`). The
 * section write door needs to replace ONE of those blocks by id and leave every
 * other byte of the document untouched.
 *
 * WHY NOT THE MARKDOWN ENGINE'S PARSER: it lives in synap-app (a React package
 * built on unified/remark-directive) and the backend cannot import it. A second
 * full markdown parser here would be a fork. So this is deliberately NOT a
 * markdown parser: it only answers "which LINES does top-level section X
 * occupy", by tracking container-directive fences and fenced code blocks, and it
 * never interprets anything inside a section. Everything it does not understand
 * it copies through verbatim.
 *
 * The rules it mirrors from micromark-extension-directive:
 *   - a container opens with a line of 3+ colons followed by a name;
 *   - a line of colons closes the innermost open container only when it has at
 *     least as many colons as that container's opener;
 *   - nothing inside a fenced code block (``` or ~~~) is a directive.
 *
 * WHAT IT CANNOT SEE: directives indented inside list items or block quotes, and
 * `#id` / `.class` attribute shorthands beyond `#id`. Neither is produced by the
 * write door, and a section this splitter cannot find is appended rather than
 * guessed at.
 */

export const SECTION_DIRECTIVE = "synap-section";

/** Who may rewrite a section. Absent or unknown reads as `human` — see `sectionOwner`. */
export type SectionOwner = "ai" | "human";

export interface ParsedSection {
  id: string;
  attributes: Record<string, string>;
  /** 0-based index of the opening fence line. */
  startLine: number;
  /** 0-based index of the closing fence line (inclusive). */
  endLine: number;
}

export interface ParsedSections {
  sections: ParsedSection[];
  /** Ids that appear on more than one top-level section. */
  duplicateIds: string[];
  /** A top-level section that never closed — its extent cannot be trusted. */
  unterminatedId: string | null;
}

const OPEN_RE = /^(:{3,})([A-Za-z][\w-]*)(\{.*\})?\s*$/;
const CLOSE_RE = /^(:{3,})\s*$/;
const CODE_FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/** Parse `{id="x" owner='ai' round=2 #anchor}` into a flat record. */
export function parseDirectiveAttributes(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  const inner = raw.replace(/^\{/, "").replace(/\}$/, "");
  const re = /([A-Za-z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'}]+))|#([\w-]+)/g;
  for (const m of inner.matchAll(re)) {
    if (m[5] !== undefined) {
      out.id = m[5];
    } else if (m[1]) {
      out[m[1]] = m[2] ?? m[3] ?? m[4] ?? "";
    }
  }
  return out;
}

/** Walk the document once and return every TOP-LEVEL section's line extent. */
export function parseSections(markdown: string): ParsedSections {
  const lines = markdown.split("\n");
  const stack: Array<{ colons: number; section: ParsedSection | null }> = [];
  const sections: ParsedSection[] = [];
  let codeFence: { char: string; length: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const fence = CODE_FENCE_RE.exec(line);
    if (codeFence) {
      if (
        fence &&
        fence[1]![0] === codeFence.char &&
        fence[1]!.length >= codeFence.length &&
        line.trim() === fence[1]
      ) {
        codeFence = null;
      }
      continue;
    }
    if (fence) {
      codeFence = { char: fence[1]![0]!, length: fence[1]!.length };
      continue;
    }

    const close = CLOSE_RE.exec(line);
    if (close) {
      const top = stack[stack.length - 1];
      if (top && close[1]!.length >= top.colons) {
        stack.pop();
        if (top.section) {
          top.section.endLine = i;
          sections.push(top.section);
        }
      }
      continue;
    }

    const open = OPEN_RE.exec(line);
    if (open) {
      const isTopLevelSection =
        stack.length === 0 && open[2] === SECTION_DIRECTIVE;
      const attributes = isTopLevelSection ? parseDirectiveAttributes(open[3]) : {};
      stack.push({
        colons: open[1]!.length,
        section:
          isTopLevelSection && attributes.id
            ? { id: attributes.id, attributes, startLine: i, endLine: -1 }
            : null,
      });
    }
  }

  const unterminated = stack.find((frame) => frame.section)?.section ?? null;
  const seen = new Set<string>();
  const duplicateIds = new Set<string>();
  for (const s of sections) {
    if (seen.has(s.id)) duplicateIds.add(s.id);
    seen.add(s.id);
  }
  return {
    sections,
    duplicateIds: [...duplicateIds],
    unterminatedId: unterminated?.id ?? null,
  };
}

/**
 * The owner of a stored section. ONLY an explicit `owner="ai"` is AI-owned: a
 * section with no owner (hand-written, or authored before ownership existed) is
 * treated as human, because the one mistake this must never make is letting the
 * AI rewrite a person's words.
 */
export function sectionOwner(section: Pick<ParsedSection, "attributes">): SectionOwner {
  return section.attributes.owner === "ai" ? "ai" : "human";
}

export class SectionBodyError extends Error {}

/**
 * Colon count for a new section's fence: one more than any container fence the
 * body itself uses (min 4, the report convention), so nothing in the body can
 * close the section early. Throws when the body is not self-contained — an
 * unclosed inner container would swallow the section's own closing fence, and
 * a nested `synap-section` would be a second section hiding inside the first.
 */
function fenceColonsFor(body: string): number {
  let max = 3;
  const stack: number[] = [];
  let codeFence: { char: string; length: number } | null = null;
  for (const line of body.split("\n")) {
    const fence = CODE_FENCE_RE.exec(line);
    if (codeFence) {
      if (
        fence &&
        fence[1]![0] === codeFence.char &&
        fence[1]!.length >= codeFence.length &&
        line.trim() === fence[1]
      ) {
        codeFence = null;
      }
      continue;
    }
    if (fence) {
      codeFence = { char: fence[1]![0]!, length: fence[1]!.length };
      continue;
    }
    const close = CLOSE_RE.exec(line);
    if (close) {
      max = Math.max(max, close[1]!.length);
      const top = stack[stack.length - 1];
      if (top !== undefined && close[1]!.length >= top) stack.pop();
      continue;
    }
    const open = OPEN_RE.exec(line);
    if (open) {
      if (open[2] === SECTION_DIRECTIVE) {
        throw new SectionBodyError(
          "A section body cannot contain another synap-section."
        );
      }
      max = Math.max(max, open[1]!.length);
      stack.push(open[1]!.length);
    }
  }
  if (codeFence) {
    throw new SectionBodyError("A section body has an unclosed code block.");
  }
  if (stack.length > 0) {
    throw new SectionBodyError(
      "A section body has an unclosed ::: block, which would swallow the rest of the document."
    );
  }
  return Math.max(4, max + 1);
}

/** Attribute values are written double-quoted; strip what would break the brace. */
function attributeValue(value: string): string {
  return value.replace(/["{}\r\n]/g, "").trim();
}

export interface SectionInput {
  id: string;
  title: string;
  body: string;
  /** Written in this order after `id`; empty values are omitted. */
  attributes: Record<string, string>;
}

export function serializeSection(input: SectionInput): string {
  const colons = ":".repeat(fenceColonsFor(input.body));
  const attrs = [
    `id="${attributeValue(input.id)}"`,
    ...Object.entries(input.attributes)
      .filter(([key, value]) => key !== "id" && attributeValue(value) !== "")
      .map(([key, value]) => `${key}="${attributeValue(value)}"`),
  ].join(" ");
  const title = input.title.replace(/[\r\n]+/g, " ").trim();
  const body = input.body.replace(/\s+$/, "");
  return [
    `${colons}${SECTION_DIRECTIVE}{${attrs}}`,
    `## ${title}`,
    ...(body ? ["", body] : []),
    colons,
  ].join("\n");
}

/**
 * Replace top-level section `input.id` in place, or append it at the end of the
 * document when absent. Every line outside that one block is preserved exactly.
 * Callers must have already refused duplicate / unterminated ids (see
 * `parseSections`) — this function trusts the extent it is given.
 */
export function upsertSectionInMarkdown(
  markdown: string,
  parsed: ParsedSections,
  input: SectionInput
): { markdown: string; replaced: boolean } {
  const block = serializeSection(input);
  const existing = parsed.sections.find((s) => s.id === input.id);
  if (existing) {
    const lines = markdown.split("\n");
    lines.splice(
      existing.startLine,
      existing.endLine - existing.startLine + 1,
      ...block.split("\n")
    );
    return { markdown: lines.join("\n"), replaced: true };
  }
  const head = markdown.replace(/\s+$/, "");
  return {
    markdown: head ? `${head}\n\n${block}\n` : `${block}\n`,
    replaced: false,
  };
}
