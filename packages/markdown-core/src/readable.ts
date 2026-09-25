/**
 * READABLE — the one rule that turns a stored document into what relay,
 * exports and other agents read: every `synap-*` embed replaced by its
 * markdown fallback, everything else byte-for-byte.
 *
 * The pod's agent read (`format: "readable"`) and the user's export both call
 * `readableMarkdown`; there is no second copy of the walk.
 *
 * Core stays catalog-free: when an embed carries no authored fallback, the
 * caller names it through `labelFor` (the pod passes the renderables catalog's
 * `fallbackFor`, else the vocabulary noun). Core never invents a label.
 */

import { parseMarkdown } from "./processor.js";
import { readEmbed, type Embed } from "./embeds.js";

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
 * The readable form: each embed's source replaced by the markdown fallback its
 * author wrote; with none, `*<labelFor(embed)>*`. Never the raw directive.
 */
export function readableMarkdown(
  markdown: string,
  labelFor: ReadableEmbedLabel
): string {
  let out = "";
  let cursor = 0;
  for (const { embed, start, end, fallbackRange } of locateEmbeds(markdown)) {
    out += markdown.slice(cursor, start);
    out += fallbackRange
      ? markdown.slice(fallbackRange.start, fallbackRange.end)
      : `*${labelFor(embed)}*`;
    cursor = end;
  }
  return out + markdown.slice(cursor);
}
