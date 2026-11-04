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
 * acorn), and not a second scanner: every load is read by
 * `@synap-core/types/cell-bridge` `frameMarkupLoads` / `frameModuleLoads`
 * (linear in the source, tripwire `one-frame-policy`), and the declared hosts
 * by `frameExternalOrigins`, the parse the frame's policy uses. This file says
 * what each load means for a cell, and gives the advice. Measured blind
 * spots: an import built at run time (`import(name)`), a URL assembled from
 * parts, a commented-out import that is not at the start of its line (it is
 * still read as an import), and a string that happens to look like an import
 * statement.
 */

import { frameExternalOrigins } from "../cell-bridge/external-origins.js";
import {
  frameEsmShAt,
  frameMarkupLoads,
  frameModuleLoads,
  frameUrlHost,
  frameUrlIsInline,
  frameUrlIsNetwork,
  type FrameLoad,
} from "../cell-bridge/network-loads.js";

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
  | "esm_sh"
  | "external_host";

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

// `--bundle-deps` is right before and after synap-cli#81 makes bundling the
// default (the flag stays accepted there), so the sentence teaches it.
const BUNDLE_FIX =
  "Bundle the library into the source (`synap cell build <entry> --bundle-deps`) and import only what the host provides: react, react-dom, @synap/kit and @synap/view-sdk.";

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
  external_host:
    "Write each host as an origin, its scheme included and nothing after the host: `https://api.vendor.com`. No wildcard, path, query or credentials.",
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

function originOf(url: string): string | null {
  try {
    return new URL(url.startsWith("//") ? `https:${url}` : url).origin;
  } catch {
    return null;
  }
}

/**
 * Check a cell's stored source against what its frame can mount. Pure: the
 * same input always gives the same findings, in source order. Every load is
 * read by THE scanner (`frameMarkupLoads` for a page, `frameModuleLoads` for
 * a module, `@synap-core/types/cell-bridge`), and the declared hosts by THE
 * host rule (`frameExternalOrigins`, the parse the frame's policy uses), so
 * what this refuses is what the frame would block.
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

  // Every view below keeps the source's offsets, so one line index serves all.
  const lineAt = lineIndex(source);
  const markup = isPage ? blankHtmlComments(source) : source;

  // ── hosts: the frame's policy keeps only a clean origin (scheme, host, no
  // path); anything else it drops in silence, so every request to it would be
  // blocked at mount. Refused here, by the same parse. A page reaches no host.
  // A blank entry declares nothing (the writer drops it, `normalizeStringList`).
  const declared = isPage
    ? []
    : (input.externalHosts ?? []).filter((h) => h.trim() !== "");
  for (const host of declared) {
    if (frameExternalOrigins([host]).length === 0) {
      refuse(
        "external_host",
        null,
        `\`externalHosts\` names "${host}", which is not an origin the frame can reach: the frame drops it, so every request to it is blocked.`
      );
    }
  }
  const allowed = new Set(frameExternalOrigins(declared));
  // A ws(s) request is also allowed by its http(s) origin (CSP matches
  // `https://x` for `wss://x`), never the other way round.
  const reachable = (origin: string) =>
    allowed.has(origin) ||
    (/^wss?:/i.test(origin) && allowed.has(origin.replace(/^ws/i, "http")));

  // ── loads, read by THE scanner: imports, script and stylesheet loads,
  // requests.
  const loads = isPage ? frameMarkupLoads(source) : frameModuleLoads(source);
  const byKind = (kind: FrameLoad["kind"]) =>
    loads.filter((l) => l.kind === kind);
  let esmRefused = false;
  const named = (value: string) => {
    if (frameUrlHost(value) === "esm.sh") esmRefused = true;
  };

  for (const hit of byKind("import")) {
    const line = lineAt(hit.index);
    const s = hit.value;
    if (frameUrlIsInline(s)) continue;
    if (frameUrlIsNetwork(s)) {
      named(s);
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

  for (const script of byKind("script")) {
    if (!script.value || frameUrlIsInline(script.value)) continue;
    named(script.value);
    const line = lineAt(script.index);
    refuse(
      "network_script",
      line,
      `Line ${line} loads the script "${script.value}".`
    );
  }
  for (const link of byKind("link")) {
    const rel = link.rel ?? "";
    if (!/\b(?:stylesheet|preload|modulepreload)\b/i.test(rel)) continue;
    if (!link.value || frameUrlIsInline(link.value)) continue;
    named(link.value);
    const line = lineAt(link.index);
    refuse(
      "network_stylesheet",
      line,
      `Line ${line} loads "${link.value}" (<link rel="${rel}">).`
    );
  }
  // CSS `@import` of a remote sheet, in a page's <style> or a module's CSS string.
  for (const sheet of byKind("css-import")) {
    named(sheet.value);
    const line = lineAt(sheet.index);
    refuse(
      "network_stylesheet",
      line,
      `Line ${line} imports the stylesheet "${sheet.value}".`
    );
  }

  // The web and desktop frames refuse any source naming esm.sh, wherever it is
  // (a URL in a string, a comment): its own refusal unless a load named it.
  const esm = frameEsmShAt(source);
  if (esm !== -1 && !esmRefused) {
    const line = lineAt(esm);
    refuse("esm_sh", line, `Line ${line} names esm.sh.`);
  }

  // Requests to a literal origin the frame may not reach.
  for (const rq of byKind("request")) {
    const url = rq.value;
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
