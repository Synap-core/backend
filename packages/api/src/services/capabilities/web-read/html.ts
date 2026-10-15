/**
 * Pure HTML text helpers of the built-in reader ladder. No network, no DOM:
 * string in, string out. Page text is DATA, never instructions.
 *
 * LINEAR ON HOSTILE INPUT. Every pattern here runs on untrusted HTML up to
 * `WEB_READ_PAGE_BYTES_MAX`, so none may backtrack super-linearly: a tag body
 * is `[^<>]*` (an attempt ends at the next `<`, so attempts never overlap),
 * and an element's END is found with `indexOf` on a lower-cased copy, with a
 * per-tag "no close after here" memo — never a lazy `[\s\S]*?` scan with a
 * backreference, which made 80 000 unclosed `<form>`s cost 8 s.
 */

import { isHttpUrl } from "@synap-core/types/navigation";

export function decodeEntities(raw: string): string {
  return raw
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (all, n) => {
      const code = Number(n);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    })
    .replace(/&#x([0-9a-f]+);/gi, (all, n) => {
      const code = Number.parseInt(n, 16);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : all;
    });
}

/** A `<meta>` tag longer than this is not metadata; it is skipped. */
const META_TAG_MAX = 4_096;

function metaAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  // The `=value` part is OPTIONAL so a name run without `=` is consumed once
  // (a mandatory `=` made a long run backtrack quadratically).
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(tag))) {
    const value = match[2] ?? match[3] ?? match[4];
    if (value === undefined) continue;
    attrs[match[1]!.toLowerCase()] = decodeEntities(value);
  }
  return attrs;
}

/** First non-empty `<meta property|name=key content=…>` value, or null. */
export function metaContent(html: string, key: string): string | null {
  const re = new RegExp(`<meta\\b[^<>]{0,${META_TAG_MAX}}>`, "gi");
  const want = key.toLowerCase();
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const attrs = metaAttrs(match[0]);
    const name = (attrs.property ?? attrs.name ?? "").toLowerCase();
    const content = attrs.content?.trim();
    if (name === want && content) return content;
  }
  return null;
}

/** ASCII-only lower case: same length as the input, so indices line up. */
export function asciiLower(s: string): string {
  return s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

/**
 * The inner HTML of the FIRST `<tag>` that has a closing `</tag>` after it,
 * or undefined. Linear: one open-tag search, one `indexOf` for the close (if
 * the first open has no close after it, no later one has either).
 */
export function innerOf(html: string, tag: string): string | undefined {
  const open = new RegExp(`<${tag}\\b[^<>]*>`, "i").exec(html);
  if (!open) return undefined;
  const start = open.index + open[0].length;
  const end = asciiLower(html).indexOf(`</${tag}`, start);
  return end < 0 ? undefined : html.slice(start, end);
}

/** The `<title>` text, whitespace collapsed, or "". */
export function titleTag(html: string): string {
  const inner = innerOf(html, "title");
  return inner ? decodeEntities(inner).replace(/\s+/g, " ").trim() : "";
}

/** Elements that are never the page's reading text. */
const CHROME_TAGS =
  "script|style|noscript|svg|template|iframe|nav|header|footer|aside|form|button|select";

/**
 * `html` without HTML comments and without every chrome element (open tag to
 * its first close tag). An element with no close is left as it is, like an
 * unclosed comment. Linear: the scan only moves forward, and a tag whose
 * close is missing after position p is remembered as missing after any later
 * position.
 */
export function stripChrome(html: string): string {
  const lower = asciiLower(html);
  const re = new RegExp(`<!--|<(${CHROME_TAGS})\\b[^<>]*>`, "gi");
  const noCloseAfter = new Map<string, number>();
  let out = "";
  let from = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const tag = match[1]?.toLowerCase();
    const closer = tag ? `</${tag}` : "-->";
    const bodyStart = match.index + match[0].length;
    const missingFrom = noCloseAfter.get(closer);
    const close =
      missingFrom !== undefined && bodyStart >= missingFrom
        ? -1
        : lower.indexOf(closer, bodyStart);
    if (close < 0) {
      if (missingFrom === undefined || bodyStart < missingFrom)
        noCloseAfter.set(closer, bodyStart);
      continue; // unclosed: kept as text, like the old pattern did
    }
    const closeEnd = tag ? lower.indexOf(">", close) : close + 3;
    const end = closeEnd < 0 ? html.length : closeEnd + (tag ? 1 : 0);
    out += html.slice(from, match.index) + " ";
    from = end;
    re.lastIndex = end;
  }
  return out + html.slice(from);
}

/**
 * The READABLE text of an HTML page: the `<article>` (else `<main>`, else the
 * `<body>`), without scripts, styles and site chrome (nav, header, footer,
 * aside, forms), block elements as line breaks, entities decoded, capped at
 * `max` characters. It is DATA the page holds — never instructions.
 */
export function readableTextFromHtml(html: string, max: number): string {
  const scope =
    innerOf(html, "article") ??
    innerOf(html, "main") ??
    innerOf(html, "body") ??
    html;
  const text = stripChrome(scope)
    .replace(
      /<\/?(p|div|section|li|ul|ol|h[1-6]|br|tr|table|blockquote|pre|dd|dt|figcaption)\b[^<>]*>/gi,
      "\n"
    )
    .replace(/<[^<>]+>/g, " ");
  return decodeEntities(text)
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, max);
}

/**
 * Text of an HTML FRAGMENT (an extracted article body, a feed entry, an
 * oEmbed snippet). Unlike {@link readableTextFromHtml} it never narrows to an
 * inner `<article>`/`<main>` — the fragment IS the reading text, and an
 * embedded card inside it must not replace it.
 */
export function fragmentText(html: string, max: number): string {
  return readableTextFromHtml(
    html.replace(/<(\/?)(article|main|body)\b/gi, "<$1div"),
    max
  );
}

/**
 * The whole trimmed `input` when it is ONE http(s) URL — no surrounding
 * prose, no inner whitespace (which `new URL` would silently strip) — or null.
 * The one "is this a lone link" test of the read doors (capture, staging, the
 * built-in reader).
 */
export function loneHttpUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  return isHttpUrl(trimmed) ? trimmed : null;
}

/** An http(s) URL resolved against `base`, or null. */
export function httpUrlOrNull(
  raw: string | null | undefined,
  base?: string
): string | null {
  if (!raw?.trim()) return null;
  try {
    const url = base ? new URL(raw.trim(), base) : new URL(raw.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null; // not a URL: nothing to resolve
  }
}
