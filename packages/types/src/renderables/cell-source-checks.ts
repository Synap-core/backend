/**
 * What a stored cell source needs in order to MOUNT in a frame — the ONE rule,
 * checked when the cell is defined instead of when someone opens it.
 *
 * Until this check, nothing looked at a cell's source when it was written: the
 * web and desktop frames refused runtime `deps` and esm.sh only at mount
 * (synap-app `cell-runtime/ViewFrame` `frameNetworkCodeRefusal`), so a person
 * could approve a cell that then failed on every open, forever. The pod's one
 * cell writer (`defineCell`, synap-backend `services/cells/define-cell.ts`) and
 * the doors that file a cell proposal run this before anything is stored or
 * proposed.
 *
 * Two outputs, two strengths (founder decision Q9, plan 9ad4b2fc):
 *   - `refusals`: what cannot mount in the frame. The write is refused, and the
 *     message names the line and the fix in the words the skills teach
 *     (`skills/synap/viewframe-cells.md`).
 *   - `advice`: words, colour and accessibility. Never a refusal; returned with
 *     the write so the author can fix it.
 *
 * What each mechanism gets from the host (read at today's mains):
 *   - `frame` (an ES module that default-exports a component): an import map of
 *     the host's own modules, {@link HOST_PROVIDED_FRAME_SPECIFIERS}, and a CSP
 *     with no remote code origin; `connect-src` names only the cell's approved
 *     `externalHosts`.
 *   - `iframe` (an HTML page): NO host modules (no import map) and the srcdoc
 *     CSP `script-src 'unsafe-inline'; style-src 'unsafe-inline';
 *     font-src data:; connect-src 'none'` (synap-app
 *     `cell-runtime/srcdoc-csp.ts`, browser `cells/srcdocCsp.ts`). So a page
 *     may run inline script only, and any `import` in it fails.
 *
 * Text checks, not a parser (this subpath stays a leaf: no TypeScript, no
 * acorn). Measured blind spots: an import built at run time
 * (`import(name)`), a URL assembled from parts, a commented-out import that is
 * not at the start of its line (it is still read as an import), and a string
 * that happens to look like an import statement.
 */

/**
 * The modules the host hands every `frame` cell through its import map — the
 * names a frame cell may import, and may list in `deps` (they are ignored).
 *
 * Mirror of synap-app `packages/web/src/cell-runtime/ViewFrame.tsx`
 * `HOST_PROVIDED_SPECIFIERS` (and `frame-import-map.ts`), which predates this
 * file; that copy should read this one.
 */
export const HOST_PROVIDED_FRAME_SPECIFIERS: readonly string[] = [
  "react",
  "react-dom",
  "react-dom/client",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "@synap/kit",
  "@synap/view-sdk",
];

/** The mechanisms whose source this check reads. `builtin` and `mcp-app` are not drawn in a Synap frame. */
export type CellSourceMechanism = "frame" | "iframe";

/** Why a source cannot mount. */
export type CellSourceRefusalCode =
  | "runtime_deps"
  | "unprovided_import"
  | "local_import"
  | "network_import"
  | "page_import"
  | "network_script"
  | "network_stylesheet"
  | "network_request"
  | "esm_sh";

/** What could be better, never a refusal. */
export type CellSourceAdviceCode =
  "raw_colour" | "image_without_alt" | "click_without_button";

export interface CellSourceFinding<C extends string = string> {
  code: C;
  /** 1-based line in the stored source, or null when the finding is not about a line (`deps`). */
  line: number | null;
  /** What is wrong, in one sentence. */
  message: string;
  /** What to do instead, in the words the skills teach. */
  fix: string;
}

export interface CellSourceCheck {
  refusals: CellSourceFinding<CellSourceRefusalCode>[];
  advice: CellSourceFinding<CellSourceAdviceCode>[];
}

export interface CellSourceCheckInput {
  source: string;
  mechanism: CellSourceMechanism;
  deps?: Record<string, string> | null;
  /** Origins the cell's frame may reach (`widget_definitions.external_hosts`). A page reaches none. */
  externalHosts?: readonly string[] | null;
}

const BUNDLE_FIX =
  "Bundle the library into the source (`synap cell build <entry> --bundle-deps`) and import only what the host provides: react, react-dom and @synap/kit.";

const FIX: Record<CellSourceRefusalCode, string> = {
  runtime_deps: `Leave \`deps\` out (or send {}). ${BUNDLE_FIX}`,
  unprovided_import: BUNDLE_FIX,
  local_import:
    "A cell is one self-contained module: inline that file, or bundle it into the source (`synap cell build <entry> --bundle-deps`).",
  network_import: `The frame loads no code from the network (no CDN, no esm.sh). ${BUNDLE_FIX}`,
  page_import:
    "An HTML page gets no host modules and no network code: use inline script only, or write the cell as an ES module that default-exports a React component (a frame cell), which can import react and @synap/kit.",
  network_script:
    "No `<script src>`: the frame's security policy blocks it. Put the script inline, bundled into the source (`synap cell build <entry> --bundle-deps`).",
  network_stylesheet:
    "No CDN stylesheet and no web font link: the frame's security policy blocks them. Inline `<style>` tags or CSS-in-JS only; fonts and colours come from the host's tokens (var(--synap-*)).",
  network_request:
    "The frame reaches no network for data: read through `SynapWidget.query` (the bridge). An installed package may declare the origin in `externalHosts` for a person to approve.",
  esm_sh: `The web and desktop frames refuse any source that names esm.sh. ${BUNDLE_FIX}`,
};

const ADVICE_FIX: Record<CellSourceAdviceCode, string> = {
  raw_colour:
    "Use the host's tokens, e.g. var(--synap-foreground), var(--synap-background), var(--synap-primary): the frame receives them, and they follow the person's theme.",
  image_without_alt:
    'Give every image an `alt` (a short description, or alt="" when it is decoration).',
  click_without_button:
    "Use a `<button>` (or kit `SpatialButton`) for anything clickable: a clickable div is not reachable by keyboard or screen reader.",
};

/*
 * LINEAR SCANS ONLY. This check runs on the pod's request thread, on a source
 * any agent can send, so every scan below costs time linear in the source:
 * no regex with an unbounded run that can fail at its end (`[^>]*>` with no
 * `>` ahead, `[\s\S]*?-->` with no `-->`) re-tried from every start, and no
 * line count from the start of the text per hit. A tag or comment that is
 * never closed ends the scan for that construct: no later one can close
 * either. Guarded by `cell-source-checks.linear.test.ts`.
 */

/** 1-based line of any offset, in O(log lines). The blanking helpers keep every offset, so one index serves every view of the source. */
function lineIndex(text: string): (index: number) => number {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
    starts.push(i + 1);
  }
  return (index) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** Replace `[from, to)` with spaces, keeping newlines. */
function blankRange(out: string[], from: number, to: number): void {
  for (let i = from; i < to; i++) if (out[i] !== "\n") out[i] = " ";
}

/** The offset after the spaces and tabs that open the line starting at `lineStart`. */
function afterIndent(text: string, lineStart: number): number {
  let j = lineStart;
  while (text[j] === " " || text[j] === "\t") j++;
  return j;
}

/** The start of the line after the one holding `index`, or -1. */
function nextLine(text: string, index: number): number {
  const nl = text.indexOf("\n", index);
  return nl === -1 ? -1 : nl + 1;
}

/**
 * Blank out comments that open a line (`// …`, and `/* … *\/` blocks that open
 * a line), keeping every newline so line numbers stay true. Comments after
 * code on the same line are kept: a URL's `//` cannot be told from one
 * without a parser.
 */
function blankLeadingComments(text: string): string {
  const out = text.split("");
  // Blocks first: one that opens a line, up to its first `*/`.
  for (let ls = 0; ls !== -1;) {
    const j = afterIndent(text, ls);
    if (text.startsWith("/*", j)) {
      const end = text.indexOf("*/", j + 2);
      if (end === -1) break;
      blankRange(out, j, end + 2);
      ls = nextLine(text, end + 2);
    } else {
      ls = nextLine(text, j);
    }
  }
  // Then line comments, read on what the blocks left.
  const blocked = out.join("");
  for (let ls = 0; ls !== -1;) {
    const j = afterIndent(blocked, ls);
    const nl = blocked.indexOf("\n", j);
    if (blocked.startsWith("//", j)) {
      blankRange(out, j, nl === -1 ? blocked.length : nl);
    }
    ls = nl === -1 ? -1 : nl + 1;
  }
  return out.join("");
}

/** Blank out HTML comments, keeping newlines. */
function blankHtmlComments(text: string): string {
  const out = text.split("");
  for (let i = text.indexOf("<!--"); i !== -1;) {
    const end = text.indexOf("-->", i + 4);
    if (end === -1) break;
    blankRange(out, i, end + 3);
    i = text.indexOf("<!--", end + 3);
  }
  return out.join("");
}

interface Tag {
  /** Offset of the `<`. */
  index: number;
  /** The tag's text, from `<` to its `>`. */
  text: string;
  /** Offset after its `>`. */
  end: number;
}

/**
 * Each `<name …>` tag of `markup` whose name matches `open` (a global regex
 * matching the `<name` part), up to its first `>`. A tag with no `>` ends the
 * scan: no later one has a `>` either.
 */
function tagsOf(markup: string, open: RegExp): Tag[] {
  const tags: Tag[] = [];
  open.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = open.exec(markup))) {
    const close = markup.indexOf(">", m.index + m[0].length);
    if (close === -1) break;
    tags.push({
      index: m.index,
      text: markup.slice(m.index, close + 1),
      end: close + 1,
    });
    open.lastIndex = close + 1;
  }
  return tags;
}

/** The script text of a page, at its own offsets (everything else blanked), so line numbers stay true. */
function pageScriptText(page: string): string {
  const out = page.replace(/[^\n]/g, " ").split("");
  const closing = /<\/script\s*>/gi;
  for (const tag of tagsOf(page, /<script\b/gi)) {
    if (tag.end < closing.lastIndex) continue; // inside the body just copied
    closing.lastIndex = tag.end;
    const close = closing.exec(page);
    if (!close) break;
    for (let i = tag.end; i < close.index; i++) out[i] = page[i]!;
  }
  return out.join("");
}

interface ImportHit {
  specifier: string;
  index: number;
}

const QUOTES = "\"'`";

/** A JS identifier character, `$` included. */
function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\w$]/.test(ch);
}

/** A character an import clause is made of (`a, { b as c }`, `* as d`, newlines). */
function isClauseChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\w$*{}\s,]/.test(ch);
}

function skipSpace(code: string, i: number): number {
  while (i < code.length && /\s/.test(code[i]!)) i++;
  return i;
}

/**
 * The quoted string opening at `at` (`code[at]` is its quote), when it closes
 * on its line and holds none of `forbidden` (each quote). Its text and the
 * offset after its closing quote.
 */
function quotedAt(
  code: string,
  at: number,
  forbidden: string
): { text: string; end: number } | null {
  const quote = code[at]!;
  let i = at + 1;
  while (i < code.length && code[i] !== "\n" && !forbidden.includes(code[i]!)) {
    i++;
  }
  if (i === at + 1 || code[i] !== quote) return null;
  return { text: code.slice(at + 1, i), end: i + 1 };
}

/**
 * The module specifiers a source imports, in source order: `import … from
 * "x"`, `import "x"`, `export … from "x"` and `import("x")`. One pass: each
 * `import` / `export` keyword reads its clause only up to the next keyword.
 */
function importsOf(code: string): ImportHit[] {
  const keywords: number[] = [];
  const re = /import|export/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const before = code[m.index - 1];
    if (before === undefined || !(isWordChar(before) || before === ".")) {
      keywords.push(m.index);
    }
  }
  const hits: ImportHit[] = [];
  for (let k = 0; k < keywords.length; k++) {
    const at = keywords[k]!;
    const limit = keywords[k + 1] ?? code.length;
    const after = at + 6; // both keywords are 6 letters
    const first = skipSpace(code, after);

    // import("x")
    if (code.startsWith("import", at) && code[first] === "(") {
      const q = skipSpace(code, first + 1);
      if (QUOTES.includes(code[q] ?? "\0")) {
        const str = quotedAt(code, q, QUOTES);
        if (str && code[skipSpace(code, str.end)] === ")") {
          hits.push({ specifier: str.text, index: q + 1 });
        }
      }
      continue;
    }

    // import "x" / import … from "x" / export … from "x"
    let j = after;
    while (j < limit && isClauseChar(code[j])) j++;
    if (j >= limit || (code[j] !== '"' && code[j] !== "'")) continue;
    const clause = code.slice(after, j).trimEnd();
    if (clause.trim() !== "" && !clause.endsWith("from")) continue;
    const str = quotedAt(code, j, "\"'");
    if (str) hits.push({ specifier: str.text, index: j + 1 });
  }
  return hits;
}

function isNetworkUrl(value: string): boolean {
  return /^(?:https?:)?\/\//i.test(value.trim());
}

function isInlineUrl(value: string): boolean {
  return /^(?:data|blob):/i.test(value.trim());
}

function originOf(url: string): string | null {
  try {
    return new URL(url.startsWith("//") ? `https:${url}` : url).origin;
  } catch {
    return null;
  }
}

/**
 * The origin a declared `externalHosts` entry opens in the frame's
 * `connect-src`, or null when the frame drops it. Mirror of synap-app
 * `cell-runtime/ViewFrame.tsx` `buildFrameCsp`: an http(s)/ws(s) origin only;
 * a wildcard, a path, a query, credentials or a host with no scheme
 * (`api.vendor.com`) is dropped, so a request to it is blocked at run time.
 * (backend#730 exports this parse as `frameExternalOrigins`,
 * `@synap-core/types/cell-bridge`; read that once it lands.)
 */
function frameOriginOf(host: string): string | null {
  const h = host.trim();
  if (h.includes("*")) return null;
  let u: URL;
  try {
    u = new URL(h);
  } catch {
    return null;
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(u.protocol)) return null;
  if (!u.hostname || u.username || u.password) return null;
  if (u.pathname !== "/" || u.search || u.hash) return null;
  return /[\s'";]/.test(u.origin) ? null : u.origin;
}

/**
 * The value of attribute `name` in one tag's text: quoted (up to the same
 * quote) or bare (up to a space or `>`). The first one only.
 */
function attrOf(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*`, "i").exec(tag);
  if (!m) return null;
  const at = m.index + m[0].length;
  const quote = tag[at];
  if (quote === '"' || quote === "'") {
    const end = tag.indexOf(quote, at + 1);
    return end === -1 ? null : tag.slice(at + 1, end);
  }
  const bare = /^[^\s>"']+/.exec(tag.slice(at));
  return bare ? bare[0] : null;
}

/**
 * Check a cell's stored source against what its frame can mount. Pure: the
 * same input always gives the same findings, in source order.
 */
export function checkCellSource(input: CellSourceCheckInput): CellSourceCheck {
  const refusals: CellSourceFinding<CellSourceRefusalCode>[] = [];
  const advice: CellSourceFinding<CellSourceAdviceCode>[] = [];
  const source = input.source ?? "";
  const isPage = input.mechanism === "iframe";
  const provided = new Set(HOST_PROVIDED_FRAME_SPECIFIERS);
  const refuse = (
    code: CellSourceRefusalCode,
    line: number | null,
    message: string
  ) => refusals.push({ code, line, message, fix: FIX[code] });

  // ── deps: a frame resolves no runtime dependency the host does not provide.
  const remoteDeps = Object.keys(input.deps ?? {}).filter(
    (name) => !provided.has(name)
  );
  if (remoteDeps.length > 0) {
    refuse(
      "runtime_deps",
      null,
      `\`deps\` names ${remoteDeps.join(", ")}: the frame does not load runtime dependencies.`
    );
  }

  // ── code: imports, script and stylesheet loads, requests.
  // Every view below keeps the source's offsets, so one line index serves all.
  const lineAt = lineIndex(source);
  const markup = isPage ? blankHtmlComments(source) : source;
  const code = blankLeadingComments(isPage ? pageScriptText(markup) : source);

  for (const hit of importsOf(code)) {
    const line = lineAt(hit.index);
    const s = hit.specifier;
    if (isInlineUrl(s)) continue;
    if (isNetworkUrl(s)) {
      refuse(
        "network_import",
        line,
        `Line ${line} imports "${s}" from the network.`
      );
    } else if (s.startsWith(".") || s.startsWith("/")) {
      refuse("local_import", line, `Line ${line} imports the file "${s}".`);
    } else if (isPage) {
      refuse(
        "page_import",
        line,
        `Line ${line} imports "${s}", and an HTML page gets no host modules.`
      );
    } else if (!provided.has(s)) {
      refuse(
        "unprovided_import",
        line,
        `Line ${line} imports "${s}", which the host does not provide.`
      );
    }
  }

  // The web and desktop frames refuse any source naming esm.sh, wherever it is
  // (`frameNetworkCodeRefusal`): the import check above may not see it (a URL
  // in a string), so it is its own refusal unless an import already named it.
  const esm = /\bhttps?:\/\/esm\.sh\//i.exec(source);
  if (esm && !refusals.some((r) => /esm\.sh/i.test(r.message))) {
    const line = lineAt(esm.index);
    refuse("esm_sh", line, `Line ${line} names esm.sh.`);
  }

  if (isPage) {
    for (const tag of tagsOf(markup, /<script\b/gi)) {
      const src = attrOf(tag.text, "src");
      if (!src || isInlineUrl(src)) continue;
      const line = lineAt(tag.index);
      refuse("network_script", line, `Line ${line} loads the script "${src}".`);
    }
    for (const tag of tagsOf(markup, /<link\b/gi)) {
      const rel = attrOf(tag.text, "rel") ?? "";
      if (!/\b(?:stylesheet|preload|modulepreload)\b/i.test(rel)) continue;
      const href = attrOf(tag.text, "href") ?? "";
      if (!href || isInlineUrl(href)) continue;
      const line = lineAt(tag.index);
      refuse(
        "network_stylesheet",
        line,
        `Line ${line} loads "${href}" (<link rel="${rel.trim()}">).`
      );
    }
  }

  // CSS `@import` of a remote sheet, in a page's <style> or a module's CSS string.
  const cssImport =
    /@import\s+(?:url\(\s*)?(["']?)((?:https?:)?\/\/[^"')\s;]+)\1/gi;
  let ci: RegExpExecArray | null;
  while ((ci = cssImport.exec(markup))) {
    const line = lineAt(ci.index);
    refuse(
      "network_stylesheet",
      line,
      `Line ${line} imports the stylesheet "${ci[2]}".`
    );
  }

  // Requests to a literal origin the frame may not reach.
  const allowed = new Set(
    isPage
      ? []
      : (input.externalHosts ?? [])
          .map(frameOriginOf)
          .filter((o): o is string => o !== null)
  );
  // A ws(s) request is also allowed by its http(s) origin (CSP matches
  // `https://x` for `wss://x`), never the other way round.
  const reachable = (origin: string) =>
    allowed.has(origin) ||
    (/^wss?:/i.test(origin) && allowed.has(origin.replace(/^ws/i, "http")));
  const request =
    /\b(?:fetch|new\s+(?:WebSocket|EventSource))\s*\(\s*(["'`])((?:https?:|wss?:)?\/\/[^"'`\s]+)\1/g;
  let rq: RegExpExecArray | null;
  while ((rq = request.exec(code))) {
    const url = rq[2]!;
    const origin = originOf(url);
    if (origin && reachable(origin)) continue;
    const line = lineAt(rq.index);
    refuse(
      "network_request",
      line,
      `Line ${line} requests "${url}", an origin this frame may not reach.`
    );
  }

  // ── advice (never a refusal).
  const say = (code: CellSourceAdviceCode, line: number, message: string) =>
    advice.push({ code, line, message, fix: ADVICE_FIX[code] });

  const hex =
    /(?:^|[\s:"'`(,=])(#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4}))(?![\w-])/gi;
  let hx: RegExpExecArray | null;
  let firstHex: { line: number; value: string } | null = null;
  let hexCount = 0;
  while ((hx = hex.exec(markup))) {
    hexCount++;
    if (!firstHex) firstHex = { line: lineAt(hx.index), value: hx[1]! };
  }
  if (firstHex) {
    say(
      "raw_colour",
      firstHex.line,
      `${hexCount} hard-coded colour${hexCount === 1 ? "" : "s"}, first ${firstHex.value} on line ${firstHex.line}.`
    );
  }

  for (const tag of tagsOf(markup, /<img\b/gi)) {
    if (/\balt\s*=/i.test(tag.text)) continue;
    const line = lineAt(tag.index);
    say("image_without_alt", line, `Line ${line} has an image with no alt.`);
  }

  for (const tag of tagsOf(markup, /<(?:div|span|li|td|tr|section)\b/g)) {
    if (!/\bon[cC]lick\b/.test(tag.text) || /\brole\s*=/.test(tag.text)) {
      continue;
    }
    const name = /^<(\w+)/.exec(tag.text)![1];
    const line = lineAt(tag.index);
    say(
      "click_without_button",
      line,
      `Line ${line}: a clickable <${name}> with no role.`
    );
  }

  return { refusals, advice };
}

/** How many reasons a refusal message lists before it counts the rest. */
const MAX_REASONS_SHOWN = 20;

/**
 * One message for a refused write: each reason with its line, then each
 * distinct fix once. What `defineCell` and the cell doors answer with.
 */
export function formatCellSourceRefusal(
  refusals: readonly CellSourceFinding<CellSourceRefusalCode>[]
): string {
  // The first reasons only: a source of a million bad imports must not come
  // back as a million-line error.
  const reasons = refusals
    .slice(0, MAX_REASONS_SHOWN)
    .map((r) => `- ${r.message}`);
  if (refusals.length > MAX_REASONS_SHOWN) {
    reasons.push(`- …and ${refusals.length - MAX_REASONS_SHOWN} more.`);
  }
  const fixes = [...new Set(refusals.map((r) => r.fix))].map((f) => `- ${f}`);
  return [
    "This cell cannot be drawn in a Synap frame, so it was not saved:",
    ...reasons,
    "How to fix it:",
    ...fixes,
  ].join("\n");
}
