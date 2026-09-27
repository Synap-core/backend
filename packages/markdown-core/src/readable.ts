/**
 * READABLE — the one rule that turns a stored document into what relay,
 * exports and other agents read: every `synap-*` embed replaced by its
 * markdown fallback (embeds inside frames included: `locateEmbeds` walks into
 * every frame), column rows unwrapped into their content, Synap-only inline
 * formatting reduced to its text
 * (`:u[x]` → `x`, `:color[x]{tone=…}` → `x`, `==x=={tone=…}` → `==x==`),
 * everything else byte-for-byte.
 *
 * The pod's agent read (`format: "readable"`) and the user's export both call
 * `readableMarkdown`; there is no second copy of the walk.
 *
 * Core stays catalog-free: when an embed carries no authored fallback, the
 * caller names it through `labelFor` (the pod passes the renderables catalog's
 * `fallbackFor`, else the vocabulary noun). Core never invents a label.
 */

import { highlightToneSuffixRange, parseMarkdown } from "./processor.js";
import { isLayoutDirective, readEmbed, type Embed } from "./embeds.js";
import { scanContainers } from "./scan.js";
import { readInlineFormatAt } from "./inline-format.js";

/** An embed together with the character range of its source. */
export interface LocatedEmbed {
  embed: Embed;
  start: number;
  end: number;
  /** The character range of its markdown fallback, when it has one. */
  fallbackRange: { start: number; end: number } | null;
}

/** Every `synap-*` reference embed in the document, in source order. */
export function locateEmbeds(markdown: string): LocatedEmbed[] {
  const out: LocatedEmbed[] = [];
  const walk = (node: {
    type: string;
    children?: unknown[];
    position?: { start: { offset?: number }; end: { offset?: number } };
  }) => {
    const embed = readEmbed(node as Parameters<typeof readEmbed>[0]);
    if (embed) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (typeof start === "number" && typeof end === "number") {
        const first = embed.fallback[0]?.position?.start.offset;
        const last =
          embed.fallback[embed.fallback.length - 1]?.position?.end.offset;
        out.push({
          embed,
          start,
          end,
          fallbackRange:
            typeof first === "number" && typeof last === "number"
              ? { start: first, end: last }
              : null,
        });
      }
      return; // an embed's fallback is prose, never another embed to count
    }
    for (const child of node.children ?? []) walk(child as typeof node);
  };
  walk(parseMarkdown(markdown) as unknown as Parameters<typeof walk>[0]);
  return out;
}

/** Names an embed that has no authored fallback (catalog template or noun). */
export type ReadableEmbedLabel = (embed: Embed) => string;

/**
 * The fence lines of every column row outside an embed, as character ranges
 * (each line with its line break). The scanner reads the extents (bound to
 * micromark by the conformance corpus); a row inside an embed's fallback is
 * the fallback's business and is left alone.
 */
function layoutFenceRanges(
  markdown: string,
  embeds: readonly LocatedEmbed[]
): Array<{ start: number; end: number }> {
  const lines = markdown.split("\n");
  const lineStart: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStart.push(offset);
    offset += line.length + 1;
  }
  const rangeOf = (line: number) => ({
    start: lineStart[line]!,
    end: Math.min(lineStart[line]! + lines[line]!.length + 1, markdown.length),
  });
  const out: Array<{ start: number; end: number }> = [];
  for (const c of scanContainers(markdown).containers) {
    if (!isLayoutDirective(c.name)) continue;
    const opener = rangeOf(c.startLine);
    if (embeds.some((e) => opener.start >= e.start && opener.start < e.end))
      continue;
    out.push(opener);
    if (c.terminated) out.push(rangeOf(c.endLine));
  }
  return out;
}

/**
 * The readable form: each embed's source replaced by the markdown fallback its
 * author wrote; with none, `*<labelFor(embed)>*`. Never the raw directive.
 * Column rows are UNWRAPPED: each column's content in order, separated by a
 * blank line (GitHub, a Notion import and other agents read clean markdown).
 */
export function readableMarkdown(
  markdown: string,
  labelFor: ReadableEmbedLabel
): string {
  const embeds = locateEmbeds(markdown);
  const edits: Array<{ start: number; end: number; text: string | null }> = [
    ...embeds.map(({ embed, start, end, fallbackRange }) => ({
      start,
      end,
      text: fallbackRange
        ? markdown.slice(fallbackRange.start, fallbackRange.end)
        : `*${labelFor(embed)}*`,
    })),
    // `null` = a removed fence line: the text around it becomes separate blocks.
    ...layoutFenceRanges(markdown, embeds).map((r) => ({ ...r, text: null })),
  ].sort((a, b) => a.start - b.start);

  let out = "";
  let breakPending = false;
  const emit = (piece: string) => {
    if (breakPending) {
      if (piece.trim() === "") return;
      piece = piece.replace(/^\n+/, "");
      if (out !== "") out = out.replace(/\n*$/, "\n\n");
      breakPending = false;
    }
    out += piece;
  };
  let cursor = 0;
  for (const edit of edits) {
    emit(markdown.slice(cursor, edit.start));
    if (edit.text === null) breakPending = true;
    else emit(edit.text);
    cursor = edit.end;
  }
  emit(markdown.slice(cursor));
  // A row closing the document: end as the source ended.
  if (breakPending)
    out = out.replace(/\n+$/, "") + (/\n$/.test(markdown) ? "\n" : "");
  return stripInlineFormatting(out);
}

type Walked = {
  type: string;
  tone?: string | null;
  children?: Walked[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};

/**
 * Synap-only inline formatting reduced to its text, as DELETIONS of source
 * ranges (the directive head, its `]{…}` tail, a highlight's tone suffix), so
 * nesting composes and the label's own markdown is kept byte for byte.
 * A tone suffix whose surrounding text was not verbatim source (an escape in
 * the same run) has no known range and is left as written.
 */
export function stripInlineFormatting(markdown: string): string {
  const cuts: Array<{ start: number; end: number }> = [];
  const walk = (node: Walked) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (
      (node.type === "underline" || node.type === "textColor") &&
      start != null &&
      end != null
    ) {
      const match = readInlineFormatAt(markdown.slice(start, end));
      if (match) {
        const labelStart = start + match.raw.indexOf("[") + 1;
        const labelEnd = labelStart + match.label.length;
        cuts.push({ start, end: labelStart }, { start: labelEnd, end });
      }
    }
    if (node.type === "mark") {
      const range = highlightToneSuffixRange(node);
      if (range) cuts.push(range);
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(parseMarkdown(markdown) as unknown as Walked);
  if (cuts.length === 0) return markdown;
  cuts.sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const cut of cuts) {
    out += markdown.slice(cursor, cut.start);
    cursor = Math.max(cursor, cut.end);
  }
  return out + markdown.slice(cursor);
}
