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

/** The 1-based line of `index` in `text`. */
function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

/**
 * Blank out comments that open a line (`// …`, and `/* … *\/` blocks that open
 * a line), keeping every newline so line numbers stay true. Comments after
 * code on the same line are kept: a URL's `//` cannot be told from one
 * without a parser.
 */
function blankLeadingComments(text: string): string {
  return text
    .replace(/(^|\n)([ \t]*)\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|\n)([ \t]*)\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
}

/** Blank out HTML comments, keeping newlines. */
function blankHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
}

/** The script text of a page, at its own offsets (everything else blanked), so line numbers stay true. */
function pageScriptText(page: string): string {
  const out = page.replace(/[^\n]/g, " ").split("");
  const re = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(page))) {
    const body = m[1] ?? "";
    const start = m.index + m[0].indexOf(">") + 1;
    for (let i = 0; i < body.length; i++) out[start + i] = body[i]!;
  }
  return out.join("");
}

const STATIC_IMPORT =
  /(?:^|[^\w$.])(?:import|export)\s*(?:[\w$*{}\s,]*?\s*from\s*)?(["'])([^"'\n]+)\1/g;
const DYNAMIC_IMPORT = /(?:^|[^\w$.])import\s*\(\s*(["'`])([^"'`\n]+)\1\s*\)/g;

interface ImportHit {
  specifier: string;
  index: number;
}

function importsOf(code: string): ImportHit[] {
  const hits: ImportHit[] = [];
  for (const re of [STATIC_IMPORT, DYNAMIC_IMPORT]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code))) {
      const specifier = m[2]!;
      hits.push({ specifier, index: m.index + m[0].indexOf(specifier) });
    }
  }
  return hits.sort((a, b) => a.index - b.index);
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
  const markup = isPage ? blankHtmlComments(source) : source;
  const code = blankLeadingComments(isPage ? pageScriptText(markup) : source);

  for (const hit of importsOf(code)) {
    const line = lineAt(code, hit.index);
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
    const line = lineAt(source, esm.index);
    refuse("esm_sh", line, `Line ${line} names esm.sh.`);
  }

  if (isPage) {
    const scriptSrc = /<script\b[^>]*?\bsrc\s*=\s*(["']?)([^"'\s>]+)\1/gi;
    let m: RegExpExecArray | null;
    while ((m = scriptSrc.exec(markup))) {
      const src = m[2]!;
      if (isInlineUrl(src)) continue;
      const line = lineAt(markup, m.index);
      refuse("network_script", line, `Line ${line} loads the script "${src}".`);
    }
    const link = /<link\b[^>]*>/gi;
    while ((m = link.exec(markup))) {
      const tag = m[0];
      const rel = /\brel\s*=\s*(["']?)([^"'>]+)\1/i.exec(tag)?.[2] ?? "";
      if (!/\b(?:stylesheet|preload|modulepreload)\b/i.test(rel)) continue;
      const href = /\bhref\s*=\s*(["']?)([^"'\s>]+)\1/i.exec(tag)?.[2] ?? "";
      if (!href || isInlineUrl(href)) continue;
      const line = lineAt(markup, m.index);
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
    const line = lineAt(markup, ci.index);
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
          // A declared host may carry no scheme (`api.vendor.com`).
          .map((h) => originOf(h) ?? originOf(`https://${h}`))
          .filter((o): o is string => o !== null)
  );
  const request =
    /\b(?:fetch|new\s+(?:WebSocket|EventSource))\s*\(\s*(["'`])((?:https?:|wss?:)?\/\/[^"'`\s]+)\1/g;
  let rq: RegExpExecArray | null;
  while ((rq = request.exec(code))) {
    const url = rq[2]!;
    const origin = originOf(url.replace(/^ws/i, "http"));
    if (origin && allowed.has(origin)) continue;
    const line = lineAt(code, rq.index);
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
    if (!firstHex) firstHex = { line: lineAt(markup, hx.index), value: hx[1]! };
  }
  if (firstHex) {
    say(
      "raw_colour",
      firstHex.line,
      `${hexCount} hard-coded colour${hexCount === 1 ? "" : "s"}, first ${firstHex.value} on line ${firstHex.line}.`
    );
  }

  const img = /<img\b[^>]*>/gi;
  let im: RegExpExecArray | null;
  while ((im = img.exec(markup))) {
    if (/\balt\s*=/i.test(im[0])) continue;
    const line = lineAt(markup, im.index);
    say("image_without_alt", line, `Line ${line} has an image with no alt.`);
  }

  const clickable = /<(div|span|li|td|tr|section)\b[^>]*\bon[cC]lick\b[^>]*>/g;
  let ck: RegExpExecArray | null;
  while ((ck = clickable.exec(markup))) {
    if (/\brole\s*=/.test(ck[0])) continue;
    const line = lineAt(markup, ck.index);
    say(
      "click_without_button",
      line,
      `Line ${line}: a clickable <${ck[1]}> with no role.`
    );
  }

  return { refusals, advice };
}

/**
 * One message for a refused write: each reason with its line, then each
 * distinct fix once. What `defineCell` and the cell doors answer with.
 */
export function formatCellSourceRefusal(
  refusals: readonly CellSourceFinding<CellSourceRefusalCode>[]
): string {
  const reasons = refusals.map((r) => `- ${r.message}`);
  const fixes = [...new Set(refusals.map((r) => r.fix))].map((f) => `- ${f}`);
  return [
    "This cell cannot be drawn in a Synap frame, so it was not saved:",
    ...reasons,
    "How to fix it:",
    ...fixes,
  ].join("\n");
}
