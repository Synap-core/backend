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
 *      The host loop that applies these rules is here too, written once
 *      (`createCellBridgeHost`, `host.ts`): pod admin's and the desktop's
 *      HTML pages both run it, each with its own frame and read door.
 *   4. Read-only for a PAGE. A host of a stored HTML page (pod admin's and
 *      the desktop's) refuses every `synap:mutate` (`CELL_BRIDGE_WRITE_REFUSED`).
 *      A MODULE frame (`module-frame.ts`, its host `frame-host.ts`) may ask
 *      the typed writes of `write-ops.ts` (create / update / delete an
 *      entity, create a relation); the host checks the payload, stamps the
 *      frame's identity and its own lens, and sends it to the pod's governed
 *      door, which decides (applied, proposed or denied).
 *   5. Nothing secret crosses: no token, no pod URL, no key is sent into the
 *      frame — only the answer to what the page asked.
 *   6. Opening an object: `window.synap.open(kind, id)` posts
 *      `synap:surface:open` with the object's kind and id only
 *      (`parseFrameOpen`, `frame-links.ts`); the host opens it through its own
 *      route table. No address crosses, in either direction.
 *   7. Tokens, when a host hands them in (the `tokens` option of
 *      `wrapHtmlForFrame`, built by `frameTokensCss`): the host's `--synap-*`
 *      values in the reader's theme, as the frame's first style.
 *   8. Links, when a host asks (the `links` option of `wrapHtmlForFrame`,
 *      `frame-links.ts`). A clicked http(s) link does NOT navigate the frame:
 *      the frame posts `synap:navigate` and the host decides (`resolveFrameLink`):
 *      a console `/open/…` link in the reader's own tab, anything else in a new
 *      tab with `noopener`, nothing without a recent user activation. OFF by
 *      default: a host that does not handle the message keeps its frame as it
 *      was.
 *
 * WHAT IT DOES NOT COVER (measured limits, not wishes)
 *   - A page can still LEAK what it read, through a URL: by navigating its
 *     OWN frame to an outside address (CSP has no navigation directive; the
 *     sandbox only stops navigating the host). A host can detect the frame
 *     leaving (a second `load`) and tear it down — after the request left.
 *     The link door (6) stops a CLICKED link from doing this; a script that
 *     assigns `location` itself still can.
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
  projectPillarsAnswer,
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
  FRAME_TOKEN_PREFIX,
  buildCellFrameCsp,
  buildCellModuleFrameCsp,
  cellFrameHeadBlock,
  frameTokensCss,
  htmlByteLength,
  wrapHtmlForFrame,
  type CellFrameOptions,
} from "./frame.js";
export {
  CELL_FRAME_LINK_DOOR,
  FRAME_NAVIGATE_TYPE,
  FRAME_OPEN_KINDS,
  FRAME_SURFACE_OPEN_TYPE,
  parseFrameNavigate,
  parseFrameOpen,
  resolveFrameLink,
  type FrameLinkAction,
  type FrameNavigateMessage,
  type FrameOpenKind,
  type FrameOpenMessage,
} from "./frame-links.js";
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
export {
  CELL_BRIDGE_MAX_ANSWER_CHARS,
  CELL_BRIDGE_MAX_IN_FLIGHT,
  cellBridgeAnswer,
  cellBridgeErrorText,
  createCellBridgeHost,
  type CellBridgeEventLike,
  type CellBridgeHostOptions,
  type CellBridgeTarget,
} from "./host.js";
export { CELL_BRIDGE_SDK } from "./sdk.js";
export { narrowHomeToSpace } from "./home-lens.js";
export {
  FRAME_BLOB_URLS_SCRIPT,
  FRAME_IMPORT_MAP_SCRIPT,
  FRAME_INIT_QUEUE_SCRIPT,
} from "./frame-scripts.js";
export { SYNAP_VIEW_SDK, SYNAP_WIDGET_SDK } from "./frame-sdks.js";
export {
  CELL_FRAME_MOUNT_TIMEOUT_MS,
  CELL_FRAME_READY_TIMEOUT_MS,
  CELL_MODULE_FRAME_SANDBOX,
  buildCellModuleFrameSrcdoc,
  cellModuleHostModulesRefusal,
  cellModuleNeedsJsxDev,
  cellModuleNeedsKit,
  cellModuleNetworkRefusal,
  utf8ToBase64,
  type CellFrameHostModules,
  type CellFrameInitContext,
  type CellFrameModuleInputs,
  type CellFrameQueryHint,
  type CellFrameWorkspaceScope,
  type CellModuleFrameInput,
} from "./module-frame.js";
export {
  CELL_FRAME_MAX_ERROR_CHARS,
  CELL_FRAME_MAX_HEIGHT,
  CELL_FRAME_MAX_TOAST_CHARS,
  parseCellFrameMessage,
  type CellFrameHostMessage,
  type CellFrameNavigationTarget,
  type CellFrameSurfaceRequest,
} from "./messages.js";
export {
  CELL_BRIDGE_MAX_PROPERTIES_CHARS,
  CELL_BRIDGE_MAX_PROPERTY_KEYS,
  CELL_BRIDGE_MAX_WRITE_STRING,
  CELL_BRIDGE_WRITE_NEEDS_TYPE,
  CELL_BRIDGE_WRITE_OPS,
  CELL_BRIDGE_WRITE_OP_NAMES,
  cellBridgeUnknownWrite,
  cellBridgeWriteRefusal,
  isCellBridgeWriteOp,
  pickBridgeWritePayload,
  type CellBridgeJsonValue,
  type CellBridgeMutateResult,
  type CellBridgeWriteOp,
  type CellBridgeWritePayload,
} from "./write-ops.js";
export {
  CELL_FRAME_NO_READS,
  CELL_FRAME_NO_WRITES,
  createCellFrameHost,
  type CellFrameHostOptions,
  type CellFrameIdentity,
  type CellFrameLens,
  type CellFrameStatus,
  type CellFrameWriteRequest,
} from "./frame-host.js";
