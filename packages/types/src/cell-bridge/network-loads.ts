/**
 * What a stored HTML page tries to load from the network, which the frame
 * policy (`CELL_FRAME_CSP_DIRECTIVES`) refuses: the policy names no remote
 * origin, so the browser blocks every such load in silence. These rules say it
 * out loud, once, for every reader of the rule:
 *   - the AUTHOR, at write and read time (the pod's document diagnostics);
 *   - the READER, whose host does not run a page whose code cannot load and
 *     shows why instead of a frame that stays blank.
 *
 * Two classes, because their effect differs:
 *   - CODE (`<script src>`, an `import` from a URL, an import map entry): the
 *     page's behaviour is missing, so it cannot run. Refused.
 *   - ASSETS (a stylesheet `<link>`, a CSS `@import` or `url()`, an `<img>`):
 *     the page runs and draws without them (system fonts, no picture).
 *     Advised.
 *
 * Read from the markup, never by running it, so it sees what the author wrote:
 * a URL built at run time is not found here (and is refused by the policy all
 * the same). HTML comments are skipped: a commented-out tag loads nothing.
 */

export interface FrameNetworkLoads {
  /** Hosts the page loads CODE from: it cannot run. Sorted, unique. */
  code: string[];
  /** Hosts the page loads styles, fonts or images from: it draws without them. */
  assets: string[];
}

/*
 * LINEAR IN THE PAGE, by construction. The scan runs on the pod's request
 * thread (a write's receipt, a read's diagnostics) and in the reader's host,
 * on pages of up to megabytes: a regex that can backtrack over an unbounded
 * span (`[^>]*?` to a tag's end, `[\s\S]*?` to `</script>`, two adjacent
 * `\s*`) turns one bad page into minutes of CPU (measured: 164 s on 1 MB of
 * `<script ` before this was rewritten; a 126 MB read froze the pod on
 * 3 Nov 2026). So tags are walked with `indexOf`, a script's end is a literal
 * search, an import keyword is checked in a fixed window, and every regex
 * below runs on one tag's text with no two quantifiers over the same
 * characters.
 */

/** A URL: protocol-relative or http(s), up to a quote, a space, `>` or `)`. */
const URL_TEXT = String.raw`((?:https?:)?\/\/[^"'\s>)]+)`;
/** `name = "url"` in one tag's attributes (the quote is optional). */
function attrRe(names: string): RegExp {
  return new RegExp(
    String.raw`\b(?:${names})\s*=\s*(?:["']\s*)?` + URL_TEXT,
    "gi"
  );
}
const SCRIPT_SRC = attrRe("src");
const LINK_HREF = attrRe("href");
const MEDIA_SRC = attrRe("src|srcset|poster");
/** `rel="a b"` or `rel=a`: quoted value, or one unquoted token. */
const LINK_REL = /\brel\s*=\s*(?:["']([^"']*)|([^\s"'>]+))/i;
const IMPORT_MAP_TYPE = /\btype\s*=\s*["']?importmap\b/i;
/** Rels that only hint (no bytes are used by the page). */
const HINT_RELS =
  /^(?:preconnect|dns-prefetch|canonical|alternate|author|help|license|next|prev|search|me)$/i;
/** A tag's name, read at a `<`. */
const TAG_NAME = /<([a-zA-Z][\w-]*)/y;
const SCRIPT_END = /<\/script/gi;
/** A quoted URL (a module specifier, an import map entry). */
const QUOTED_URL = new RegExp(String.raw`["']` + URL_TEXT, "g");
/** CSS `@import "https://…"` / `@import url(https://…)` / `url(https://…)`. */
const CSS_URL = new RegExp(
  String.raw`(?:@import\s+(?:url\(\s*)?|url\(\s*)(?:["']\s*)?` + URL_TEXT,
  "gi"
);
const MEDIA_TAGS = new Set(["img", "source", "video", "audio"]);

function hostOf(url: string): string | null {
  try {
    return (
      new URL(url.startsWith("//") ? `https:${url}` : url).hostname || null
    );
  } catch {
    return null;
  }
}

function collect(into: Set<string>, re: RegExp, text: string): void {
  re.lastIndex = 0;
  for (const m of text.matchAll(re)) {
    const host = hostOf(m[1]!);
    if (host) into.add(host);
  }
}

/** The page without its HTML comments (an unclosed one runs to the end). */
function withoutComments(html: string): string {
  let out = "";
  let at = 0;
  for (;;) {
    const open = html.indexOf("<!--", at);
    if (open === -1) return out + html.slice(at);
    out += html.slice(at, open);
    const close = html.indexOf("-->", open + 4);
    if (close === -1) return out;
    at = close + 3;
  }
}

const isSpace = (c: string | undefined) =>
  c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
const isWordChar = (c: string | undefined) =>
  c !== undefined && /[\w$.]/.test(c);

/**
 * Whether the quoted specifier at `quote` follows `import`, `import(` or
 * `from`: `import x from "…"`, `import "…"`, `import("…")`,
 * `export … from "…"`. Looks back over spaces and one `(` only: constant work.
 */
function isModuleSpecifier(body: string, quote: number): boolean {
  let j = quote;
  while (j > 0 && isSpace(body[j - 1])) j--;
  if (body[j - 1] === "(") {
    j--;
    while (j > 0 && isSpace(body[j - 1])) j--;
  }
  for (const word of ["import", "from"]) {
    const start = j - word.length;
    if (
      start >= 0 &&
      body.startsWith(word, start) &&
      !isWordChar(body[start - 1])
    )
      return true;
  }
  return false;
}

/** Every remote load the page's markup asks for, by class. Never throws. */
export function frameNetworkLoads(html: string): FrameNetworkLoads {
  const text = withoutComments(html);
  const code = new Set<string>();
  const assets = new Set<string>();

  let at = 0;
  while ((at = text.indexOf("<", at)) !== -1) {
    TAG_NAME.lastIndex = at;
    const name = TAG_NAME.exec(text);
    if (!name) {
      at += 1;
      continue;
    }
    const close = text.indexOf(">", at);
    // No `>` left: nothing after this point is a tag.
    if (close === -1) break;
    const tag = name[1]!.toLowerCase();
    const attrs = text.slice(at + name[0].length, close);
    at = close + 1;

    if (tag === "script") {
      collect(code, SCRIPT_SRC, attrs);
      SCRIPT_END.lastIndex = at;
      const end = SCRIPT_END.exec(text);
      const body = text.slice(at, end ? end.index : text.length);
      if (IMPORT_MAP_TYPE.test(attrs)) {
        collect(code, QUOTED_URL, body);
      } else {
        QUOTED_URL.lastIndex = 0;
        for (const m of body.matchAll(QUOTED_URL)) {
          if (!isModuleSpecifier(body, m.index!)) continue;
          const host = hostOf(m[1]!);
          if (host) code.add(host);
        }
      }
      // The script's text is never markup.
      if (!end) break;
      at = end.index + 1;
    } else if (tag === "link") {
      LINK_HREF.lastIndex = 0;
      const href = LINK_HREF.exec(attrs);
      if (!href) continue;
      const rel = LINK_REL.exec(attrs);
      const rels = (rel?.[1] ?? rel?.[2] ?? "").trim().split(/\s+/);
      if (rels.every((r) => HINT_RELS.test(r))) continue;
      const host = hostOf(href[1]!);
      if (!host) continue;
      // `modulepreload` fetches code the page then imports.
      (rels.some((r) => /^modulepreload$/i.test(r)) ? code : assets).add(host);
    } else if (MEDIA_TAGS.has(tag)) {
      collect(assets, MEDIA_SRC, attrs);
    }
  }
  collect(assets, CSS_URL, text);

  return { code: [...code].sort(), assets: [...assets].sort() };
}

function hostList(hosts: readonly string[]): string {
  if (hosts.length <= 1) return hosts.join("");
  return `${hosts.slice(0, -1).join(", ")} and ${hosts[hosts.length - 1]}`;
}

/**
 * Why this page cannot run, when it loads code from the network: the one
 * sentence the author's diagnostics and the reader's host both say. Null when
 * every line of its code is in the page.
 */
export function frameNetworkCodeRefusal(html: string): string | null {
  const { code } = frameNetworkLoads(html);
  if (code.length === 0) return null;
  return `This page loads code from ${hostList(code)}. Pages run with no network, so that code never loads and the page does not run.`;
}

/**
 * What this page draws without, when it loads styles, fonts or images from the
 * network. Advisory: the page still runs. Null when it loads none.
 */
export function frameNetworkAssetsNotice(html: string): string | null {
  const { assets } = frameNetworkLoads(html);
  if (assets.length === 0) return null;
  return `This page loads styles, fonts or images from ${hostList(assets)}. Pages run with no network, so it draws without them.`;
}
