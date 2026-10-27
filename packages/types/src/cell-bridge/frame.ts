/**
 * The frame a stored HTML page runs in: its sandbox, its Content Security
 * Policy, its size cap, and the wrapping that puts the policy FIRST.
 */

import { CELL_BRIDGE_SDK } from "./sdk.js";

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
 * Script and font CDNs a page may load from. They serve published packages,
 * not the page's data — but a URL path is still a way out (see the leaf's
 * header, "what it does not cover").
 */
export const CELL_FRAME_SCRIPT_HOSTS = [
  "https://cdnjs.cloudflare.com",
  "https://cdn.jsdelivr.net",
  "https://unpkg.com",
] as const;

/** The policy, directive by directive, in the order it is written. */
export const CELL_FRAME_CSP_DIRECTIVES: ReadonlyArray<
  readonly [directive: string, sources: string]
> = [
  ["default-src", "'none'"],
  ["script-src", `'unsafe-inline' ${CELL_FRAME_SCRIPT_HOSTS.join(" ")}`],
  ["style-src", "'unsafe-inline' https://fonts.googleapis.com"],
  ["font-src", "data: https://fonts.gstatic.com"],
  ["img-src", "data: blob:"],
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

/** The block injected ahead of everything the author wrote. */
export function cellFrameHeadBlock(): string {
  return (
    `<meta http-equiv="Content-Security-Policy" content="${buildCellFrameCsp()}">` +
    `<script>${CELL_BRIDGE_SDK}</script>`
  );
}

const LEADING_DOCTYPE = /^(﻿?\s*<!doctype[^>]*>)/i;

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
export function wrapHtmlForFrame(html: string): string {
  const doctype = LEADING_DOCTYPE.exec(html);
  const head = cellFrameHeadBlock();
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
