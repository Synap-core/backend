/**
 * MARKDOWN → PLAIN TEXT, for surfaces that are NOT documents.
 *
 * A card body, a list row, a notification, a two-line preview: these clip.
 * Running the full renderer inside three clipped lines is worse than useless —
 * the heading rule, the blockquote bar and the list bullets all cost vertical
 * space that the clip then eats, and what survives is a fragment of chrome.
 * But printing the RAW source is worse still: that is how a document proposal
 * card came to read `# Synap — Codebase Architecture Map` with the hash and
 * the `>` visible to the user.
 *
 * So the rule is: DOCUMENT surfaces render (`MarkdownNative`), PREVIEW
 * surfaces flatten (this). Both go through the same parser, so a construct the
 * renderer understands can never be a construct the preview leaks.
 *
 * Pure — no React, no react-native, no DOM. Importable from the
 * `@synap-core/markdown-core/plain-text` subpath with no stubs.
 */

import { parseMarkdown } from "./processor.js";
import type { Root, RootContent, PhrasingContent } from "mdast";
import type { ContainerDirective } from "mdast-util-directive";
import { flattenInlineMarkers, type MarkerNoun } from "./markers.js";
import { readEmbed, type Embed } from "./embeds.js";

export interface MarkdownPlainTextOptions {
  /**
   * Hard cap on the returned string. Applied AFTER flattening, so a 400KB
   * document does not become a 400KB string on its way to a 3-line card.
   * No ellipsis is appended — the caller owns its own truncation affordance
   * (React Native's `numberOfLines` already draws one).
   */
  maxLength?: number;
  /**
   * Return only the first block that yields text — the "first paragraph"
   * projection. A document whose first block is its `# Title` heading yields
   * the title; one that opens on prose yields the opening sentence.
   */
  firstBlockOnly?: boolean;
  /**
   * What an unlabeled `[[kind:id]]` reads as — pass the vocabulary's
   * `resolveObjectNoun`. Default: the kind word (never the id).
   */
  nounFor?: MarkerNoun;
}

/** Inline nodes → their text, discarding every mark. */
function inlineText(
  nodes: readonly PhrasingContent[],
  nounFor?: MarkerNoun
): string {
  let out = "";
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        // `[[entity:id|Label]]` reads as `Label` — the marker is machinery.
        out += flattenInlineMarkers(node.value, nounFor);
        break;
      case "inlineCode":
        out += node.value;
        break;
      case "strong":
      case "emphasis":
      case "delete":
      case "mark":
      case "link":
      case "linkReference":
        out += inlineText(node.children, nounFor);
        break;
      case "image":
        // Alt text is the only human-readable part of an image; a bare
        // `![](url)` contributes nothing rather than leaking the URL.
        out += node.alt ?? "";
        break;
      case "break":
        out += " ";
        break;
      // `html`, `footnoteReference` and the three directive types are chrome
      // or machine markers, never preview prose.
      default:
        break;
    }
  }
  return out;
}

/** One block → its text, or "" when the block carries no prose. */
function blockText(node: RootContent, nounFor?: MarkerNoun): string {
  switch (node.type) {
    case "heading":
    case "paragraph":
      return inlineText(node.children, nounFor);
    case "blockquote":
      return node.children
        .map((c) => blockText(c, nounFor))
        .filter(Boolean)
        .join(" ");
    case "list":
      return node.children
        .map((item) =>
          item.type === "listItem"
            ? item.children
                .map((c) => blockText(c, nounFor))
                .filter(Boolean)
                .join(" ")
            : ""
        )
        .filter(Boolean)
        .join(" ");
    case "code":
    case "math":
      // The code IS content — a preview that drops a fenced block entirely
      // would render an empty card for a snippet-only note. Math likewise.
      return node.value;
    case "table":
      return node.children
        .map((row) =>
          row.children
            .map((cell) => inlineText(cell.children, nounFor))
            .join(" ")
        )
        .filter(Boolean)
        .join(" ");
    case "containerDirective": {
      // A report section is a FRAME around prose — its body is the report.
      // Dropping it with the other directives emptied every report preview.
      if ((node as ContainerDirective).name === "synap-section") {
        return (node as ContainerDirective).children
          .map((child) => blockText(child as RootContent, nounFor))
          .filter(Boolean)
          .join(" ");
      }
      // A reference embed reads as its author's FALLBACK prose, never as its
      // props JSON; an embed without one contributes nothing.
      const embed = readEmbed(node);
      return embed ? embedFallback(embed, nounFor) : "";
    }
    // thematicBreak, html, definition, footnoteDefinition and the reference
    // directives are structure or machine markers, not prose.
    default:
      return "";
  }
}

/**
 * An embed's readable stand-in: the markdown fallback the author wrote after
 * the props block, flattened. "" when there is none — the caller names the
 * embed itself (through the vocabulary door), this never invents a label.
 */
export function embedFallback(
  embed: Pick<Embed, "fallback">,
  nounFor?: MarkerNoun
): string {
  return collapse(
    embed.fallback
      .map((c) => blockText(c, nounFor))
      .filter(Boolean)
      .join(" ")
  );
}

/** Collapse every run of whitespace (newlines included) to one space. */
function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Flatten markdown to a single line of readable prose.
 *
 * Returns `""` for input that carries no prose (empty string, a lone `---`,
 * a bare image with no alt) — callers should treat `""` as "nothing to show"
 * rather than rendering an empty row.
 */
export function markdownToPlainText(
  markdown: string,
  options: MarkdownPlainTextOptions = {}
): string {
  if (!markdown) return "";

  const tree: Root = parseMarkdown(markdown);

  let out: string;
  if (options.firstBlockOnly) {
    out = "";
    for (const node of tree.children) {
      const text = collapse(blockText(node, options.nounFor));
      if (text) {
        out = text;
        break;
      }
    }
  } else {
    out = collapse(
      tree.children
        .map((c) => blockText(c, options.nounFor))
        .filter(Boolean)
        .join(" ")
    );
  }

  const max = options.maxLength;
  if (typeof max === "number" && max >= 0 && out.length > max) {
    return out.slice(0, max).trimEnd();
  }
  return out;
}
