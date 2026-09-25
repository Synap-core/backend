/**
 * Session document SECTIONS — the section write door's splice over the ONE
 * container scanner.
 *
 * A session document is markdown whose narrative is a run of top-level
 * `::::synap-section{id="…" owner="…" …}` container directives — the same block
 * the renderers draw and paginate. The section write door needs to replace ONE
 * of those blocks by id and leave every other byte of the document untouched.
 *
 * The line-level reading (which lines does each container occupy, with which
 * attributes) is `scanContainers` from `@synap-core/markdown-core`: a
 * byte-preserving scanner bound to micromark by that package's conformance
 * tripwire, so the door and the renderer agree on every extent. This file used
 * to carry its own two line loops and attribute regex; they disagreed with
 * micromark on a bare colon line inside a fenced code block (micromark closes
 * the enclosing container there — closers are checked before the content).
 *
 * WHAT IT CANNOT SEE (the scanner's limits): directives indented inside list
 * items or block quotes. Neither is produced by the write door, and a section
 * this splitter cannot find is appended rather than guessed at.
 */

import { fenceColonsFor, scanContainers } from "@synap-core/markdown-core/scan";
import { serializeAttributes } from "@synap-core/markdown-core/embeds";

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
  /** A top-level section that never closed on its own fence — its extent cannot be trusted. */
  unterminatedId: string | null;
}

/** Every TOP-LEVEL section's line extent. */
export function parseSections(markdown: string): ParsedSections {
  const topLevel = scanContainers(markdown).containers.filter(
    (c) => c.depth === 0 && c.name === SECTION_DIRECTIVE && !!c.attributes.id
  );
  const sections = topLevel
    .filter((c) => c.terminated)
    .map((c) => ({
      id: c.attributes.id!,
      attributes: c.attributes,
      startLine: c.startLine,
      endLine: c.endLine,
    }));
  const unterminated = topLevel.find((c) => !c.terminated);
  const seen = new Set<string>();
  const duplicateIds = new Set<string>();
  for (const s of sections) {
    if (seen.has(s.id)) duplicateIds.add(s.id);
    seen.add(s.id);
  }
  return {
    sections,
    duplicateIds: [...duplicateIds],
    unterminatedId: unterminated?.attributes.id ?? null,
  };
}

/**
 * The owner of a stored section. ONLY an explicit `owner="ai"` is AI-owned: a
 * section with no owner (hand-written, or authored before ownership existed) is
 * treated as human, because the one mistake this must never make is letting the
 * AI rewrite a person's words.
 */
export function sectionOwner(
  section: Pick<ParsedSection, "attributes">
): SectionOwner {
  return section.attributes.owner === "ai" ? "ai" : "human";
}

export class SectionBodyError extends Error {}

/**
 * Refuse a body that is not self-contained — an unclosed inner container or
 * code block would swallow the section's own closing fence, and a nested
 * `synap-section` would be a second section hiding inside the first.
 */
function assertSectionBody(body: string): void {
  const scan = scanContainers(body);
  if (scan.containers.some((c) => c.name === SECTION_DIRECTIVE)) {
    throw new SectionBodyError(
      "A section body cannot contain another synap-section."
    );
  }
  if (scan.unclosedRootFence) {
    throw new SectionBodyError("A section body has an unclosed code block.");
  }
  if (scan.containers.some((c) => !c.terminated)) {
    throw new SectionBodyError(
      "A section body has an unclosed ::: block, which would swallow the rest of the document."
    );
  }
}

/** One line per attribute value; quotes and braces are escaped by the writer, not stripped. */
function attributeValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

export interface SectionInput {
  id: string;
  title: string;
  body: string;
  /** Written in this order after `id`; empty values are omitted. */
  attributes: Record<string, string>;
}

export function serializeSection(input: SectionInput): string {
  assertSectionBody(input.body);
  // Min 4 (the report convention), and more than any colon line in the body.
  const colons = ":".repeat(fenceColonsFor(input.body, 4));
  const attributes: Record<string, string> = { id: attributeValue(input.id) };
  for (const [key, value] of Object.entries(input.attributes)) {
    if (key !== "id") attributes[key] = attributeValue(value);
  }
  const title = input.title.replace(/[\r\n]+/g, " ").trim();
  const body = input.body.replace(/\s+$/, "");
  return [
    `${colons}${SECTION_DIRECTIVE}${serializeAttributes(attributes)}`,
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
