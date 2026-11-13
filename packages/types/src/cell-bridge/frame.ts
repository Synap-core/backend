/**
 * The frame a stored HTML page runs in: its sandbox, its Content Security
 * Policy, its size cap, and the wrapping that puts the policy FIRST.
 */

import { CELL_BRIDGE_SDK } from "./sdk.js";
import { CELL_FRAME_LINK_DOOR } from "./frame-links.js";
import { frameExternalOrigins } from "./external-origins.js";

/**
 * The iframe `sandbox` value, exactly. Scripts run; nothing else is granted:
 * NEVER `allow-same-origin` (the frame would share the console's origin, its
 * cookies and storage, and could reach into the parent), `allow-forms`,
 * `allow-popups`, `allow-modals` or `allow-top-navigation*`.
 */
export const CELL_FRAME_SANDBOX = "allow-scripts";

/** The largest page a host runs: 2 MB (the desktop's `SANDBOXED_PREVIEW_MAX_BYTES`). */
export const CELL_FRAME_MAX_BYTES = 2 * 1024 * 1024;

/**
 * THE frame policy (decision R3, 3 Nov 2026: one policy everywhere, the
 * desktop's). Every frame that runs stored code, on every client, reads it
 * from here: a stored HTML page (pod admin's `html-frame`, the web and desktop
 * srcdoc frames) and, through `buildCellModuleFrameCsp`, a module cell whose
 * React and kit the host supplies as `blob:` modules (ViewFrame).
 *
 * No remote origin, for anything: no script CDN, no font or style host, no
 * image host. What a page needs it carries inline; what a cell needs the host
 * supplies (React, react-dom, the JSX runtimes, `@synap/kit`). Until 3 Nov this
 * leaf allowed three script CDNs and Google Fonts while the desktop allowed
 * none, so one page ran in pod admin and was refused on the desktop.
 * `frameNetworkLoads` says which stored pages that change stops.
 *
 * It is the desktop's `SRCDOC_CSP` plus an explicit `frame-src 'none'`
 * (which `default-src 'none'` already implies): a host adopting it only
 * tightens.
 */
export const CELL_FRAME_CSP_DIRECTIVES: ReadonlyArray<
  readonly [directive: string, sources: string]
> = [
  ["default-src", "'none'"],
  ["script-src", "'unsafe-inline'"],
  ["style-src", "'unsafe-inline'"],
  ["img-src", "data: blob:"],
  ["font-src", "data:"],
  // The page has NO network path of its own: every read goes through the
  // host bridge (postMessage), answered with the viewer's own permissions.
  ["connect-src", "'none'"],
  ["form-action", "'none'"],
  // base-uri has no default-src fallback: absent, a page could re-point
  // every relative URL with a <base> tag.
  ["base-uri", "'none'"],
  ["frame-src", "'none'"],
];

/** The Content-Security-Policy value the frame's `<meta>` carries. */
export function buildCellFrameCsp(): string {
  return CELL_FRAME_CSP_DIRECTIVES.map(([d, s]) => `${d} ${s}`).join("; ");
}

/**
 * The same policy for a MODULE cell (ViewFrame): the host decodes React, the
 * kit and the cell's own module into `blob:` URLs inside the frame, so
 * `script-src` and `connect-src` add `blob:` (Chromium counts an `import()` of
 * a module URL as a connect). An approved cell's `externalHosts` are added to
 * `connect-src` and `img-src`, and to nothing else. Never a remote script
 * origin. Every other directive is `CELL_FRAME_CSP_DIRECTIVES`, unchanged.
 */
export function buildCellModuleFrameCsp(
  externalHosts: readonly string[] = []
): string {
  const hosts = frameExternalOrigins(externalHosts);
  const extra = hosts.length > 0 ? ` ${hosts.join(" ")}` : "";
  return CELL_FRAME_CSP_DIRECTIVES.map(([d, s]) => {
    if (d === "script-src") return `${d} blob: ${s}`;
    if (d === "img-src") return `${d} ${s}${extra}`;
    if (d === "connect-src") return `${d} blob:${extra}`;
    return `${d} ${s}`;
  }).join("; ");
}

/**
 * What a host may ask of the frame beyond the shared policy. OFF by default,
 * so a host that does not handle the message keeps its frame as it was.
 */
export interface CellFrameOptions {
  /**
   * Hand a clicked link to the host (`synap:navigate`, `frame-links.ts`)
   * instead of letting it navigate the frame itself. Only a host that listens
   * for the message may ask for this: otherwise its links go nowhere.
   */
  links?: boolean;
}

/** The block injected ahead of everything the author wrote. */
export function cellFrameHeadBlock(options: CellFrameOptions = {}): string {
  return (
    `<meta http-equiv="Content-Security-Policy" content="${buildCellFrameCsp()}">` +
    `<script>${CELL_BRIDGE_SDK}</script>` +
    (options.links ? `<script>${CELL_FRAME_LINK_DOOR}</script>` : "")
  );
}

const LEADING_DOCTYPE = /^(\uFEFF?\s*<!doctype[^>]*>)/i;

/**
 * The page as the frame's `srcdoc`: the policy `<meta>` and the SDK FIRST,
 * before any byte the author wrote — only a leading `<!doctype>` stays ahead
 * of them, so the page keeps its rendering mode.
 *
 * Why not "after `<head>`": a search for the author's `<head>` can be fooled
 * (`<!-- <head> -->` before the real one would put the policy in a comment).
 * Writing it first needs no parsing: the HTML parser opens `<html>` and
 * `<head>` for the `<meta>` itself, so the policy is the head's first child
 * and governs everything after it; the author's own `<html>` attributes are
 * merged onto that element and their `<head>` tag is ignored, as the parser
 * always does. A page with no `<head>` (a fragment) gets the same.
 *
 * A policy cannot be loosened from below: a second CSP the page declares is
 * enforced IN ADDITION (both must allow), and removing our `<meta>` from the
 * DOM does not lift a policy already in force.
 */
export function wrapHtmlForFrame(
  html: string,
  options: CellFrameOptions = {}
): string {
  const doctype = LEADING_DOCTYPE.exec(html);
  const head = cellFrameHeadBlock(options);
  if (!doctype) return head + html;
  const lead = doctype[1]!;
  return lead + head + html.slice(lead.length);
}

/** The page's size in bytes, as the cap measures it (UTF-8). */
export function htmlByteLength(html: string): number {
  let bytes = 0;
  for (let i = 0; i < html.length; i += 1) {
    const code = html.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}
