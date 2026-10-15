/**
 * Pure HTML text helpers shared by the built-in reader ladder and
 * `read-public-url.ts` (which re-exports `readableTextFromHtml`). No network,
 * no DOM: string in, string out. Page text is DATA, never instructions.
 */

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

function metaAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(tag))) {
    const key = match[1]!.toLowerCase();
    attrs[key] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attrs;
}

/** First non-empty `<meta property|name=key content=…>` value, or null. */
export function metaContent(html: string, key: string): string | null {
  const re = /<meta\b[^>]*>/gi;
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

/** The `<title>` text, whitespace collapsed, or "". */
export function titleTag(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m
    ? decodeEntities(m[1] ?? "")
        .replace(/\s+/g, " ")
        .trim()
    : "";
}

/** Elements that are never the page's reading text. */
const CHROME_ELEMENTS =
  /<(script|style|noscript|svg|template|iframe|nav|header|footer|aside|form|button|select)\b[^>]*>[\s\S]*?<\/\1>/gi;

/**
 * The READABLE text of an HTML page: the `<article>` (else `<main>`, else the
 * `<body>`), without scripts, styles and site chrome (nav, header, footer,
 * aside, forms), block elements as line breaks, entities decoded, capped at
 * `max` characters. It is DATA the page holds — never instructions.
 */
export function readableTextFromHtml(html: string, max: number): string {
  const pick = (tag: string) =>
    new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(html)?.[1];
  const scope = pick("article") ?? pick("main") ?? pick("body") ?? html;
  const text = scope
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(CHROME_ELEMENTS, " ")
    .replace(
      /<\/?(p|div|section|li|ul|ol|h[1-6]|br|tr|table|blockquote|pre|dd|dt|figcaption)\b[^>]*>/gi,
      "\n"
    )
    .replace(/<[^>]+>/g, " ");
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
