/**
 * cell-bridge — the ONE contract between a stored HTML page running in an
 * isolated frame and the surface that hosts it (the pod console first; the
 * desktop's ViewFrame speaks the same messages for reads). Pure and dependency-free: no
 * React, no DOM, no fetch — a host imports the rules and does the I/O.
 *
 * SECURITY MODEL
 *   1. Isolation. The page runs in `<iframe sandbox="allow-scripts" srcdoc>`
 *      (`CELL_FRAME_SANDBOX`): an OPAQUE origin, so it cannot read the host's
 *      cookies, storage or DOM, cannot open windows, submit forms, show
 *      dialogs or navigate the host.
 *   2. No network of its own. A CSP `<meta>` written before any byte of the
 *      page (`wrapHtmlForFrame`) is THE frame policy (decision R3, the
 *      desktop's): `connect-src 'none'`, `form-action 'none'`, `base-uri
 *      'none'`, `frame-src 'none'`, scripts and styles inline only, images from `data:`/`blob:`,
 *      fonts from `data:`. No remote origin for anything: no CDN. A module
 *      cell's frame (`buildCellModuleFrameCsp`) adds only `blob:` and the
 *      cell's approved hosts. A page that loads code from a URL cannot run,
 *      and says so (`frameNetworkCodeRefusal`).
 *   3. One data path: the bridge. The page asks `window.synap.query(op,
 *      params)` (`CELL_BRIDGE_SDK`); the host answers ONLY a message whose
 *      source is that frame's window, ONLY an op in `CELL_BRIDGE_READ_OPS`,
 *      with ONLY that op's params (`pickBridgeParams`), and with the
 *      viewer's OWN session — the pod floors every read to what this viewer
 *      may see. The host stamps the lens (the page's space); the page never
 *      chooses it.
 *   4. Read-only HERE. A host on this contract (the pod console's HTML pages)
 *      refuses every `synap:mutate` (`CELL_BRIDGE_WRITE_REFUSED`). The desktop
 *      and phone hosts of MODULE cells are not read-only: they answer
 *      `SynapWidget.mutate` (create / update / delete an entity, create a
 *      relation) through the viewer's own session, each write governed by the
 *      pod (browser `createViewFrameHandlers.ts`, relay `useCellFrameHandlers.ts`).
 *   5. Nothing secret crosses: no token, no pod URL, no key is sent into the
 *      frame — only the answer to what the page asked.
 *
 * WHAT IT DOES NOT COVER (measured limits, not wishes)
 *   - A page can still LEAK what it read, through a URL: by navigating its
 *     OWN frame to an outside address (CSP has no navigation directive; the
 *     sandbox only stops navigating the host). A host can detect the frame
 *     leaving (a second `load`) and tear it down — after the request left.
 *     DNS prefetch and WebRTC are outside CSP in some browsers too.
 *   - What the page SHOWS is the author's: a page can present data falsely.
 *   - Writes from a page on this contract: none. The module-cell hosts
 *     above write through the pod's governed doors, never around them.
 */

export {
  CELL_BRIDGE_READ_OPS,
  CELL_BRIDGE_READ_OP_NAMES,
  CELL_BRIDGE_SPACE_READ_OPS,
  cellBridgeReadRefusal,
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
  buildCellFrameCsp,
  buildCellModuleFrameCsp,
  cellFrameHeadBlock,
  htmlByteLength,
  wrapHtmlForFrame,
} from "./frame.js";
export { frameExternalOrigins } from "./external-origins.js";
export {
  frameEsmShAt,
  frameMarkupLoads,
  frameModuleLoads,
  frameNetworkAssetsNotice,
  frameNetworkCodeRefusal,
  frameNetworkLoads,
  frameUrlHost,
  frameUrlIsInline,
  frameUrlIsNetwork,
  type FrameLoad,
  type FrameLoadKind,
  type FrameNetworkLoads,
} from "./network-loads.js";
export { CELL_BRIDGE_SDK } from "./sdk.js";
export { narrowHomeToSpace } from "./home-lens.js";
