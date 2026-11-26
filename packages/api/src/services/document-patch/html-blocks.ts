/**
 * ADDRESSABLE BLOCKS of an HTML artifact (a `documents.type = "html"` page).
 *
 * The convention an author (a person or an agent) writes:
 *   - `data-block-id="<id>"` on an element makes it a SECTION block;
 *   - `data-slide` on an element makes it a SLIDE (its id: `data-block-id`,
 *     else the `data-slide` value, else `slide-<n>` counting slides from 1).
 * A block's title is its `data-title`, else the text of the first heading
 * (h1–h6) inside it.
 *
 * Located with the HTML parser the pod already ships (htmlparser2, the one
 * linkedom parses with): it reports where each tag starts and ends in the
 * SOURCE, so a block is cut out of the page by its exact span and the rest
 * of the page keeps its bytes. Nothing here rewrites markup by pattern.
 *
 * Two uses, one locator:
 *   - the MANIFEST (`htmlBlockManifest`) the after-save reactor stamps on
 *     `documents.metadata.blocks` for the revision it read;
 *   - the `replace_block {blockId, html}` patch op (`replaceHtmlBlock`), which
 *     replaces exactly that element's outer HTML and refuses anything else.
 *
 * Pure: no database, no storage.
 */

import { Parser } from "htmlparser2";

export const HTML_BLOCK_ID_ATTRIBUTE = "data-block-id";
export const HTML_SLIDE_ATTRIBUTE = "data-slide";
export const HTML_BLOCK_TITLE_ATTRIBUTE = "data-title";

/** Bumped when what the manifest holds changes: a stamp from another extractor is stale. */
export const HTML_BLOCK_EXTRACTOR = 1;

/** The longest title the manifest keeps. */
const TITLE_MAX = 200;

export type HtmlBlockKind = "section" | "slide";

/** One addressable block, as the manifest lists it. */
export interface HtmlBlock {
  id: string;
  kind: HtmlBlockKind;
  /** 0-based, in document order of the opening tags (a nested block follows its parent). */
  order: number;
  title: string | null;
}

/** A block with where it sits in the source. */
export interface LocatedHtmlBlock extends HtmlBlock {
  /** Index of the `<` of its opening tag. */
  start: number;
  /** Index just past the `>` of its closing tag (or of the opening tag, for a void or self-closed element). */
  end: number;
  /** False when the parser had to close it (no closing tag written): its span is unknown. */
  closed: boolean;
}

const HEADING = /^h[1-6]$/;

const normalizeTitle = (text: string): string | null => {
  const t = text.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, TITLE_MAX) : null;
};

interface OpenElement {
  name: string;
  block: LocatedHtmlBlock | null;
  /** Blocks waiting for this heading's text to become their title. */
  titleFor: LocatedHtmlBlock[] | null;
  /** The parser's `endIndex` when the opening tag ended. */
  openEnd: number;
}

/** Every block of `html`, in document order, with its source span. */
export function locateHtmlBlocks(html: string): LocatedHtmlBlock[] {
  const blocks: LocatedHtmlBlock[] = [];
  const stack: OpenElement[] = [];
  let slides = 0;
  let heading: { text: string; blocks: LocatedHtmlBlock[] } | null = null;
  // Blocks named by `data-title` never take a heading's text.
  const titled = new Set<LocatedHtmlBlock>();

  const parser: Parser = new Parser(
    {
      onopentag(name, attribs) {
        const blockId = attribs[HTML_BLOCK_ID_ATTRIBUTE];
        const isSlide = Object.prototype.hasOwnProperty.call(
          attribs,
          HTML_SLIDE_ATTRIBUTE
        );
        let block: LocatedHtmlBlock | null = null;
        if (isSlide || blockId !== undefined) {
          if (isSlide) slides += 1;
          const id =
            blockId?.trim() ||
            (isSlide
              ? attribs[HTML_SLIDE_ATTRIBUTE]?.trim() || `slide-${slides}`
              : "");
          if (id) {
            const title = normalizeTitle(
              attribs[HTML_BLOCK_TITLE_ATTRIBUTE] ?? ""
            );
            block = {
              id,
              kind: isSlide ? "slide" : "section",
              order: blocks.length,
              title,
              start: parser.startIndex,
              end: -1,
              closed: false,
            };
            if (title) titled.add(block);
            blocks.push(block);
          }
        }
        let titleFor: LocatedHtmlBlock[] | null = null;
        if (!heading && HEADING.test(name)) {
          const waiting: LocatedHtmlBlock[] = [];
          for (const open of stack) {
            if (open.block && !open.block.title && !titled.has(open.block)) {
              waiting.push(open.block);
            }
          }
          if (block && !block.title) waiting.push(block);
          if (waiting.length > 0) {
            heading = { text: "", blocks: waiting };
            titleFor = waiting;
          }
        }
        stack.push({ name, block, titleFor, openEnd: parser.endIndex });
      },
      ontext(text) {
        if (heading) heading.text += text;
      },
      onclosetag(_name, isImplied) {
        const open = stack.pop();
        if (!open) return;
        if (open.titleFor && heading) {
          const title = normalizeTitle(heading.text);
          if (title) for (const b of open.titleFor) if (!b.title) b.title = title;
          heading = null;
        }
        const block = open.block;
        if (!block) return;
        if (!isImplied) {
          // The parser stops at the end of the tag NAME (`</section` or a
          // space after it); the tag itself ends at the next `>`.
          const gt = html.indexOf(">", parser.endIndex);
          block.end = gt === -1 ? html.length : gt + 1;
          block.closed = true;
        } else if (parser.startIndex === block.start) {
          // A void element (`<img data-block-id>`) or a self-closed one in
          // foreign content (`<rect data-block-id="x"/>`): closed by its own
          // opening tag.
          block.end = open.openEnd + 1;
          block.closed = true;
        }
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true }
  );
  parser.write(html);
  parser.end();
  return blocks;
}

/** The manifest of a page: every block's id, kind, order and title. */
export function htmlBlockManifest(html: string): HtmlBlock[] {
  return locateHtmlBlocks(html).map(({ id, kind, order, title }) => ({
    id,
    kind,
    order,
    title,
  }));
}

/** A `replace_block` the page cannot take; the message says what to do next. */
export class HtmlBlockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HtmlBlockError";
  }
}

const knownIds = (blocks: readonly HtmlBlock[]): string => {
  const ids = [...new Set(blocks.map((b) => b.id))];
  if (ids.length === 0) return "This page has no blocks.";
  const shown = ids
    .slice(0, 20)
    .map((id) => JSON.stringify(id))
    .join(", ");
  return `Its blocks: ${shown}${ids.length > 20 ? ", …" : ""}.`;
};

/**
 * Replace block `blockId`'s outer HTML with `replacement`, leaving every other
 * byte of the page as it was. Refused (an `HtmlBlockError`) when the id names
 * no block or several, when the block has no closing tag, when the
 * replacement does not carry the same block id exactly once, or when it
 * would change any block outside the one replaced (unbalanced markup that
 * swallows a sibling).
 */
export function replaceHtmlBlock(
  html: string,
  blockId: string,
  replacement: string
): string {
  const before = locateHtmlBlocks(html);
  const matches = before.filter((b) => b.id === blockId);
  if (matches.length === 0) {
    throw new HtmlBlockError(
      `replace_block: there is no block "${blockId}". ${knownIds(before)}`
    );
  }
  if (matches.length > 1) {
    throw new HtmlBlockError(
      `replace_block: ${matches.length} blocks are named "${blockId}", so which one to replace is ambiguous. Give each block its own data-block-id.`
    );
  }
  const target = matches[0]!;
  if (!target.closed) {
    throw new HtmlBlockError(
      `replace_block: block "${blockId}" has no closing tag, so where it ends is unknown. Close it explicitly (replace_all once), then replace it.`
    );
  }
  const next =
    html.slice(0, target.start) + replacement + html.slice(target.end);

  const after = locateHtmlBlocks(next);
  const kept = after.filter((b) => b.id === blockId);
  if (kept.length !== 1 || !kept[0]!.closed) {
    throw new HtmlBlockError(
      `replace_block: the new HTML must be the block itself — one element that keeps ${target.kind === "slide" ? `data-slide` : `data-block-id="${blockId}"`} and closes its own tag.`
    );
  }
  // Every block that is neither the target, inside it, nor around it must
  // read byte for byte as it did.
  const outside = before.filter(
    (b) =>
      b !== target &&
      !(b.start >= target.start && b.end <= target.end) &&
      !(b.start <= target.start && b.end >= target.end)
  );
  for (const b of outside) {
    const text = html.slice(b.start, b.end);
    const still = after.some(
      (a) => a.id === b.id && a.closed && next.slice(a.start, a.end) === text
    );
    if (!still) {
      throw new HtmlBlockError(
        `replace_block: the new HTML for "${blockId}" changes block "${b.id}" too (unbalanced tags reach past the block). Send one balanced element.`
      );
    }
  }
  return next;
}
