/**
 * What a stored source asks the network (or the host) for: THE one scanner.
 * The frame policy (`CELL_FRAME_CSP_DIRECTIVES`) names no remote origin, so the
 * browser blocks every remote load in silence; this leaf reads the loads from
 * the source so the rules that judge them can say it out loud:
 *   - a stored HTML page's diagnostics and the reader's host
 *     (`frameNetworkLoads`, `frameNetworkCodeRefusal`, `frameNetworkAssetsNotice`):
 *     the author reads why, the reader sees why instead of a blank frame;
 *   - a cell's define-time check (`checkCellSource`,
 *     `@synap-core/types/renderables`), which refuses what cannot mount, line
 *     by line.
 * Both read `frameMarkupLoads` (a page) or `frameModuleLoads` (an ES module):
 * no other file reads `<script src>`, imports, `<link>`, CSS `@import` or
 * esm.sh out of a source (tripwire `one-frame-policy`). What each rule makes of
 * a load is its own: a cell refuses a stylesheet, a document page only warns.
 *
 * Read from the text, never by running it, so it sees what the author wrote:
 * a URL built at run time is not found here (and is refused by the policy all
 * the same). HTML comments are skipped, and in code a comment that opens its
 * line (a commented-out import loads nothing).
 *
 * LINEAR IN THE SOURCE, by construction. The scan runs on the pod's request
 * thread (a write's receipt, a read's diagnostics, a cell's definition) and in
 * the reader's host, on sources of up to megabytes: a regex that can backtrack
 * over an unbounded span (`[^>]*?` to a tag's end, `[\s\S]*?` to `</script>`,
 * a lazy clause before `from`, two adjacent `\s*`) turns one bad source into
 * minutes of CPU (measured: 164 s on 1 MB of `<script `; a 126 MB read froze
 * the pod on 3 Nov 2026). So tags are walked with `indexOf`, a script's end
 * and a comment's end are literal searches, an import keyword is checked by
 * looking back over spaces only, and no regex below puts two quantifiers over
 * the same characters.
 */

export interface FrameNetworkLoads {
  /** Hosts the page loads CODE from: it cannot run. Sorted, unique. */
  code: string[];
  /** Hosts the page loads styles, fonts or images from: it draws without them. */
  assets: string[];
}

/** What kind of load, by where the source asks for it. */
export type FrameLoadKind =
  /** `import … from 'x'`, `import 'x'`, `import('x')`, `export … from 'x'`. */
  | "import"
  /** A URL in a `<script type="importmap">`. */
  | "import-map"
  /** `<script src>`. */
  | "script"
  /** `<link href>` (see `rel`). */
  | "link"
  /** `<img|source|video|audio src|srcset|poster>` (the first candidate). */
  | "media"
  /** CSS `@import`. */
  | "css-import"
  /** CSS `url(…)`. */
  | "css-url"
  /** `fetch("…")`, `new WebSocket("…")`, `new EventSource("…")` with a literal URL. */
  | "request";

export interface FrameLoad {
  kind: FrameLoadKind;
  /** The value as written: a URL, a path or a bare specifier. */
  value: string;
  /** Offset of the value in the scanned text (for a line number). */
  index: number;
  /** A `<link>`'s `rel`, as written (trimmed); "" when it has none. */
  rel?: string;
}

/** A tag in a page's markup (outside comments and script bodies). */
export interface MarkupTag {
  /** As written (`div`, `IMG`). */
  name: string;
  /** The text between the name and the `>`. */
  attrs: string;
  /** Offset of its `<`. */
  index: number;
}

/** A value that names a network location: `https://…`, `http://…`, `//…`. */
export function frameUrlIsNetwork(value: string): boolean {
  return /^(?:https?:)?\/\//i.test(value.trim());
}

/** A value the frame resolves with no network: `data:` or `blob:`. */
export function frameUrlIsInline(value: string): boolean {
  return /^(?:data|blob):/i.test(value.trim());
}

/** The host a network value names, or null. */
export function frameUrlHost(value: string): string | null {
  const url = value.trim();
  if (!frameUrlIsNetwork(url)) return null;
  try {
    return (
      new URL(url.startsWith("//") ? `https:${url}` : url).hostname || null
    );
  } catch {
    return null;
  }
}

/**
 * Where the source names esm.sh (`http(s)://esm.sh/`), anywhere, comments
 * included, or -1. The web and desktop frames refuse any such source at mount.
 */
export function frameEsmShAt(text: string): number {
  const m = /https?:\/\/esm\.sh\//i.exec(text);
  return m ? m.index : -1;
}

/**
 * `name = "v"`, `name = 'v'` or `name = v`: three alternatives, three first
 * characters. The name opens the attribute list or follows a space or `/`, so
 * `data-src` / `data-href` (a word boundary after `-`) are not `src` / `href`.
 */
function attrRe(names: string): RegExp {
  return new RegExp(
    String.raw`(?:^|[\s/])(?:${names})\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))`,
    "gi"
  );
}
const SRC = attrRe("src");
const HREF = attrRe("href");
const MEDIA_SRC = attrRe("src|srcset|poster");
const REL = attrRe("rel");
const IMPORT_MAP_TYPE = /\btype\s*=\s*["']?importmap\b/i;
/** A tag's name, read at a `<`. */
const TAG_NAME = /<([a-zA-Z][\w-]*)/y;
const SCRIPT_END = /<\/script/gi;
/** A one-line string: `"…"`, `'…'` or a backtick string with no newline. */
const QUOTED = /(["'`])([^"'`\n]+)\1/g;
/** A quoted network URL (an import map entry). */
const QUOTED_URL = /["']((?:https?:)?\/\/[^"'\s]+)/g;
/** CSS `@import "…"` / `@import url(…)` / `url(…)`, with a network URL. */
const CSS_URL =
  /(@import\s+(?:url\(\s*)?|url\(\s*)(?:["']\s*)?((?:https?:)?\/\/[^"'\s>)]+)/gi;
/** A request to a literal network URL. */
const REQUEST =
  /\b(?:fetch|new\s+(?:WebSocket|EventSource))\s*\(\s*(["'`])((?:https?:|wss?:)?\/\/[^"'`\s]+)\1/g;
const MEDIA_TAGS = new Set(["img", "source", "video", "audio"]);

/** Every value of one attribute in a tag, with its offset in the page. */
function attrValues(
  re: RegExp,
  attrs: string,
  attrsAt: number
): { value: string; index: number }[] {
  const out: { value: string; index: number }[] = [];
  re.lastIndex = 0;
  for (const m of attrs.matchAll(re)) {
    const raw = m[1] ?? m[2] ?? m[3] ?? "";
    const quoted = m[3] === undefined;
    const start = m.index! + m[0].length - (quoted ? 1 : 0) - raw.length;
    const lead = raw.length - raw.trimStart().length;
    out.push({ value: raw.trim(), index: attrsAt + start + lead });
  }
  return out;
}

const isSpace = (c: string | undefined) =>
  c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
const isWordChar = (c: string | undefined) =>
  c !== undefined && /[\w$.]/.test(c);

/**
 * May this character sit between `import` / `export` and the `from` of the
 * same statement? Names, spaces, `,` `{` `}` `*` and the `/` of a comment:
 * `import a, { b as c } from`, `export * as ns from`, `import type { T } from`.
 */
function inImportClause(c: number): boolean {
  return (
    (c >= 48 && c <= 57) || // 0-9
    (c >= 65 && c <= 90) || // A-Z
    (c >= 97 && c <= 122) || // a-z
    c === 95 || // _
    c === 36 || // $
    c === 32 || // space
    c === 9 || // tab
    c === 10 || // \n
    c === 13 || // \r
    c === 12 || // \f
    c === 44 || // ,
    c === 123 || // {
    c === 125 || // }
    c === 42 || // *
    c === 47 // /
  );
}

const atWord = (code: string, word: string, end: number): boolean => {
  const start = end - word.length;
  return (
    start >= 0 && code.startsWith(word, start) && !isWordChar(code[start - 1])
  );
};

/**
 * A test of whether the string opening at `quote` is a module specifier: it
 * follows `import` or `import(` (`import "…"`, `import("…")`), or the `from`
 * of an import or export clause (`import x from "…"`, `export … from "…"`).
 * A `from` counts only when an `import` / `export` opens its statement with
 * nothing but a clause between them, so JSX prose (`Synced from "Google
 * Sheets"`) is not an import. Called with ascending offsets: one forward pass
 * tracks the last opener and the last character no clause holds, so the scan
 * stays linear in the code.
 */
function moduleSpecifierTest(code: string): (quote: number) => boolean {
  let scanned = 0;
  let opener = -1;
  let broken = -1;
  const scanTo = (end: number) => {
    for (; scanned < end; scanned++) {
      const ch = code[scanned];
      if (
        (ch === "i" || ch === "e") &&
        (code.startsWith("import", scanned) ||
          code.startsWith("export", scanned)) &&
        !isWordChar(code[scanned - 1]) &&
        !isWordChar(code[scanned + 6])
      ) {
        opener = scanned;
      } else if (!inImportClause(code.charCodeAt(scanned))) {
        broken = scanned;
      }
    }
  };
  return (quote) => {
    let j = quote;
    while (j > 0 && isSpace(code[j - 1])) j--;
    if (code[j - 1] === "(") {
      j--;
      while (j > 0 && isSpace(code[j - 1])) j--;
    }
    if (atWord(code, "import", j)) return true;
    if (!atWord(code, "from", j)) return false;
    scanTo(j - 4);
    return opener !== -1 && broken < opener;
  };
}

/**
 * The comments that open a line in code (`// …` to the line's end, `/* … *\/`
 * to its close), as sorted [start, end) ranges. A comment after code on the
 * same line is kept: a URL's `//` cannot be told from one without a parser.
 */
function leadingCommentRanges(code: string): [number, number][] {
  const out: [number, number][] = [];
  let i = 0;
  while (i < code.length) {
    let j = i;
    while (code[j] === " " || code[j] === "\t") j++;
    let end = -1;
    if (code.startsWith("//", j)) {
      end = code.indexOf("\n", j);
      if (end === -1) end = code.length;
    } else if (code.startsWith("/*", j)) {
      const close = code.indexOf("*/", j + 2);
      end = close === -1 ? code.length : close + 2;
    }
    if (end !== -1) out.push([j, end]);
    const nl = code.indexOf("\n", end === -1 ? j : end);
    i = nl === -1 ? code.length : nl + 1;
  }
  return out;
}

/** A filter for ascending offsets: false inside any of the sorted ranges. */
function outside(
  ranges: readonly [number, number][]
): (index: number) => boolean {
  let r = 0;
  return (index) => {
    while (r < ranges.length && ranges[r]![1] <= index) r++;
    return !(r < ranges.length && ranges[r]![0] <= index);
  };
}

/** Imports and literal requests in code, at `base` + their offset in it. */
function codeLoads(code: string, base: number, out: FrameLoad[]): void {
  const comments = leadingCommentRanges(code);
  const keep = outside(comments);
  const imports: FrameLoad[] = [];
  const isModuleSpecifier = moduleSpecifierTest(code);
  QUOTED.lastIndex = 0;
  for (const m of code.matchAll(QUOTED)) {
    if (!isModuleSpecifier(m.index!) || !keep(m.index!)) continue;
    imports.push({ kind: "import", value: m[2]!, index: base + m.index! + 1 });
  }
  const keepRq = outside(comments);
  const requests: FrameLoad[] = [];
  REQUEST.lastIndex = 0;
  for (const m of code.matchAll(REQUEST)) {
    if (!keepRq(m.index!)) continue;
    requests.push({ kind: "request", value: m[2]!, index: base + m.index! });
  }
  out.push(...imports, ...requests);
}

/** CSS `@import` and `url(…)` network loads in `text`, skipping `skip` ranges. */
function cssLoads(
  text: string,
  skip: readonly [number, number][],
  out: FrameLoad[]
): void {
  const keep = outside(skip);
  CSS_URL.lastIndex = 0;
  for (const m of text.matchAll(CSS_URL)) {
    if (!keep(m.index!)) continue;
    out.push({
      kind: m[1]!.startsWith("@") ? "css-import" : "css-url",
      value: m[2]!,
      index: m.index! + m[0].length - m[2]!.length,
    });
  }
}

interface MarkupWalk {
  tags: MarkupTag[];
  scripts: { attrs: string; body: string; bodyAt: number }[];
  comments: [number, number][];
}

/** One pass over a page: its tags, its script bodies, its comments. */
function walkMarkup(html: string): MarkupWalk {
  const walk: MarkupWalk = { tags: [], scripts: [], comments: [] };
  let at = 0;
  while ((at = html.indexOf("<", at)) !== -1) {
    if (html.startsWith("<!--", at)) {
      const close = html.indexOf("-->", at + 4);
      const end = close === -1 ? html.length : close + 3;
      walk.comments.push([at, end]);
      at = end;
      continue;
    }
    TAG_NAME.lastIndex = at;
    const name = TAG_NAME.exec(html);
    if (!name) {
      at += 1;
      continue;
    }
    const close = html.indexOf(">", at);
    // No `>` left: nothing after this point is a tag.
    if (close === -1) break;
    const attrs = html.slice(at + name[0].length, close);
    walk.tags.push({ name: name[1]!, attrs, index: at });
    at = close + 1;
    if (name[1]!.toLowerCase() === "script") {
      SCRIPT_END.lastIndex = at;
      const end = SCRIPT_END.exec(html);
      const bodyEnd = end ? end.index : html.length;
      walk.scripts.push({ attrs, body: html.slice(at, bodyEnd), bodyAt: at });
      // The script's text is never markup.
      at = end ? end.index + 1 : html.length;
    }
  }
  return walk;
}

/** Every tag of a page, outside comments and script bodies, in order. */
export function markupTags(html: string): MarkupTag[] {
  return walkMarkup(html).tags;
}

/** The comments of a page, as sorted [start, end) ranges. */
export function markupComments(html: string): [number, number][] {
  return walkMarkup(html).comments;
}

/** Every load an HTML page asks for, in source order. Never throws. */
export function frameMarkupLoads(html: string): FrameLoad[] {
  const walk = walkMarkup(html);
  const out: FrameLoad[] = [];
  for (const tag of walk.tags) {
    const name = tag.name.toLowerCase();
    const attrsAt = tag.index + 1 + tag.name.length;
    if (name === "script") {
      for (const v of attrValues(SRC, tag.attrs, attrsAt))
        out.push({ kind: "script", ...v });
    } else if (name === "link") {
      const href = attrValues(HREF, tag.attrs, attrsAt)[0];
      if (!href) continue;
      const rel = attrValues(REL, tag.attrs, attrsAt)[0]?.value ?? "";
      out.push({ kind: "link", ...href, rel });
    } else if (MEDIA_TAGS.has(name)) {
      for (const v of attrValues(MEDIA_SRC, tag.attrs, attrsAt)) {
        const first = v.value.split(/\s+/)[0]!;
        if (first) out.push({ kind: "media", value: first, index: v.index });
      }
    }
  }
  for (const script of walk.scripts) {
    if (IMPORT_MAP_TYPE.test(script.attrs)) {
      QUOTED_URL.lastIndex = 0;
      for (const m of script.body.matchAll(QUOTED_URL))
        out.push({
          kind: "import-map",
          value: m[1]!,
          index: script.bodyAt + m.index! + 1,
        });
    } else {
      codeLoads(script.body, script.bodyAt, out);
    }
  }
  cssLoads(html, walk.comments, out);
  return out.sort((a, b) => a.index - b.index);
}

/** Every load an ES module asks for, in source order. Never throws. */
export function frameModuleLoads(code: string): FrameLoad[] {
  const out: FrameLoad[] = [];
  codeLoads(code, 0, out);
  cssLoads(code, [], out);
  return out.sort((a, b) => a.index - b.index);
}

/** Rels that only hint (no bytes are used by the page). */
const HINT_RELS =
  /^(?:preconnect|dns-prefetch|canonical|alternate|author|help|license|next|prev|search|me)$/i;

/** Every remote load a stored page's markup asks for, by class. Never throws. */
export function frameNetworkLoads(html: string): FrameNetworkLoads {
  const code = new Set<string>();
  const assets = new Set<string>();
  for (const load of frameMarkupLoads(html)) {
    const host = frameUrlHost(load.value);
    if (!host) continue;
    switch (load.kind) {
      case "script":
      case "import":
      case "import-map":
        code.add(host);
        break;
      case "link": {
        const rels = (load.rel ?? "").split(/\s+/);
        if (rels.every((r) => HINT_RELS.test(r))) break;
        // `modulepreload` fetches code the page then imports.
        (rels.some((r) => /^modulepreload$/i.test(r)) ? code : assets).add(
          host
        );
        break;
      }
      case "media":
      case "css-import":
      case "css-url":
        assets.add(host);
        break;
      case "request":
        // A request is data, not code or a drawing asset: the page runs, and
        // the request fails (connect-src 'none').
        break;
    }
  }
  return { code: [...code].sort(), assets: [...assets].sort() };
}

function hostList(hosts: readonly string[]): string {
  if (hosts.length <= 1) return hosts.join("");
  return `${hosts.slice(0, -1).join(", ")} and ${hosts[hosts.length - 1]}`;
}

/**
 * Why this page cannot run, when it loads code from the network: the one
 * sentence the author's diagnostics and the reader's host both say. Null when
 * every line of its code is in the page. `page` is the page, or its loads
 * already read (`frameNetworkLoads`), so a caller saying both sentences scans
 * the page once.
 */
export function frameNetworkCodeRefusal(
  page: string | FrameNetworkLoads
): string | null {
  const { code } = typeof page === "string" ? frameNetworkLoads(page) : page;
  if (code.length === 0) return null;
  return `This page loads code from ${hostList(code)}. Pages run with no network, so that code never loads and the page does not run.`;
}

/**
 * What this page draws without, when it loads styles, fonts or images from the
 * network. Advisory: the page still runs. Null when it loads none. `page` as
 * in {@link frameNetworkCodeRefusal}.
 */
export function frameNetworkAssetsNotice(
  page: string | FrameNetworkLoads
): string | null {
  const { assets } = typeof page === "string" ? frameNetworkLoads(page) : page;
  if (assets.length === 0) return null;
  return `This page loads styles, fonts or images from ${hostList(assets)}. Pages run with no network, so it draws without them.`;
}
