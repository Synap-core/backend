/**
 * cell-bridge — the ONE contract between a stored HTML page running in an
 * isolated frame and the surface that hosts it (the pod console first; the
 * desktop's ViewFrame speaks the same messages). Pure and dependency-free: no
 * React, no DOM, no fetch — a host imports the rules and does the I/O.
 *
 * SECURITY MODEL
 *   1. Isolation. The page runs in `<iframe sandbox="allow-scripts" srcdoc>`
 *      (`CELL_FRAME_SANDBOX`): an OPAQUE origin, so it cannot read the host's
 *      cookies, storage or DOM, cannot open windows, submit forms, show
 *      dialogs or navigate the host.
 *   2. No network of its own. A CSP `<meta>` written before any byte of the
 *      page (`wrapHtmlForFrame`) sets `connect-src 'none'`, `form-action
 *      'none'`, `frame-src 'none'`, images from `data:`/`blob:` only, scripts
 *      only inline or from three public CDNs, styles/fonts only inline or
 *      Google Fonts.
 *   3. One data path: the bridge. The page asks `window.synap.query(op,
 *      params)` (`CELL_BRIDGE_SDK`); the host answers ONLY a message whose
 *      source is that frame's window, ONLY an op in `CELL_BRIDGE_READ_OPS`,
 *      with ONLY that op's params (`pickBridgeParams`), and with the
 *      viewer's OWN session — the pod floors every read to what this viewer
 *      may see. The host stamps the lens (the page's space); the page never
 *      chooses it.
 *   4. Read-only. Every `synap:mutate` is refused (`CELL_BRIDGE_WRITE_REFUSED`).
 *   5. Nothing secret crosses: no token, no pod URL, no key is sent into the
 *      frame — only the answer to what the page asked.
 *
 * WHAT IT DOES NOT COVER (measured limits, not wishes)
 *   - A page can still LEAK what it read, through a URL: a script `src` on one
 *     of the allowed CDNs, a Google Fonts stylesheet URL, or by navigating its
 *     OWN frame to an outside address (CSP has no navigation directive; the
 *     sandbox only stops navigating the host). A host can detect the frame
 *     leaving (a second `load`) and tear it down — after the request left.
 *     DNS prefetch and WebRTC are outside CSP in some browsers too.
 *   - What the page SHOWS is the author's: a page can present data falsely.
 *   - The CDN scripts themselves are trusted as published.
 *   - Writes: none yet. They come later through the proposal door, never
 *     directly.
 */

export {
  CELL_BRIDGE_READ_OPS,
  CELL_BRIDGE_READ_OP_NAMES,
  isCellBridgeReadOp,
  pickBridgeParams,
  type CellBridgeParamValue,
  type CellBridgeReadOp,
} from "./read-ops.js";
export {
  CELL_BRIDGE_WRITE_REFUSED,
  cellBridgeUnknownOp,
  parseCellBridgeMessage,
  type CellBridgeFrameMessage,
  type CellBridgeHostMessage,
} from "./protocol.js";
export {
  CELL_FRAME_CSP_DIRECTIVES,
  CELL_FRAME_MAX_BYTES,
  CELL_FRAME_SANDBOX,
  CELL_FRAME_SCRIPT_HOSTS,
  buildCellFrameCsp,
  cellFrameHeadBlock,
  htmlByteLength,
  wrapHtmlForFrame,
} from "./frame.js";
export { CELL_BRIDGE_SDK } from "./sdk.js";
export { narrowHomeToSpace } from "./home-lens.js";
