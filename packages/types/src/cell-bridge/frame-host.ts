/**
 * The host's side of a MODULE frame: one `message` handler per running frame.
 * ONE implementation for every host (the desktop's ViewFrame, pod admin's
 * module frame); each host supplies only its frame's window, its lens, the
 * frame's identity, its read and write doors, and what to do with the
 * frame's requests (`on.*`). Pure, like the rest of this leaf: no React, no
 * DOM types, no fetch, so every rule is testable with a fake window.
 *
 * Ported from synap-app `ViewFrame.tsx` (its message switch) with the page
 * host's rules (`createCellBridgeHost`, `host.ts`), which are now the rules
 * of both:
 *
 * A message is handled only when ALL hold:
 *   - its `source` is THIS frame's window (`frameWindow()`);
 *   - its `origin` is "null": the opaque origin of the sandboxed srcdoc;
 *   - it parses (`parseCellFrameMessage`).
 *
 * Then:
 *   - `synap:ready` → `synap:init` once, with the host's context (`init()`).
 *     One load sends ready twice (the init queue, then the SDK's onInit), so a
 *     repeat is ignored. A srcdoc reload keeps the same `contentWindow`, so
 *     this host cannot tell one load from the next: ONE host per frame load —
 *     a host that reloads its frame makes a new host (ViewFrame, pod admin's
 *     module frame);
 *   - `synap:mounted` → `on.status({ state: "ready" })`, once;
 *   - `synap:error` → `on.status({ state: "error", message })`;
 *   - `synap:resize` → `on.resize(height)`;
 *   - a read: only an op of `CELL_BRIDGE_READ_OPS`, refused when it reads one
 *     space and the frame has none (`cellBridgeReadRefusal`), with only its
 *     own params (`pickBridgeParams`), at most 8 in flight, an answer of at
 *     most 1 M characters (`cellBridgeAnswer`); a failed read is an ERROR;
 *   - a write: refused for a page and for a frame without a type
 *     (`cellBridgeWriteRefusal`), only an op of `CELL_BRIDGE_WRITE_OPS` with a
 *     checked payload (`pickBridgeWritePayload`), stamped by the HOST with
 *     `viewContext`, `source: "user"` and its lens; the frame reads what the
 *     pod answered (approved, proposed or denied), never an optimistic yes;
 *   - navigate, toast, open-panel, surface:open, context-update → `on.*`.
 *
 * Every answer is posted to that same window, only while it is still the
 * frame's, with targetOrigin "*" (an opaque-origin frame has no origin to
 * name; what is posted is only what the frame asked for).
 */

import {
  CELL_BRIDGE_MAX_IN_FLIGHT,
  cellBridgeAnswer,
  cellBridgeErrorText,
  type CellBridgeEventLike,
  type CellBridgeTarget,
} from "./host.js";
import { cellBridgeUnknownOp, type CellBridgeHostMessage } from "./protocol.js";
import {
  cellBridgeReadRefusal,
  isCellBridgeReadOp,
  pickBridgeParams,
  type CellBridgeParamValue,
  type CellBridgeReadOp,
} from "./read-ops.js";
import {
  cellBridgeWriteRefusal,
  pickBridgeWritePayload,
  type CellBridgeMutateResult,
  type CellBridgeWriteOp,
  type CellBridgeWritePayload,
} from "./write-ops.js";
import {
  parseCellFrameMessage,
  type CellFrameNavigationTarget,
  type CellFrameSurfaceRequest,
  type CellFrameErrorReason,
} from "./messages.js";
import type { CellFrameInitContext } from "./module-frame.js";

/** The lens the host stamps on every read and write: never the frame's. */
export interface CellFrameLens {
  workspaceId: string | null;
  projectId?: string | null;
}

/** Who the frame is: what the pod resolves a write's trust from. */
export interface CellFrameIdentity {
  /** The cell's type key (`cell:<package>:<key>`); a frame with none cannot write. */
  typeKey?: string;
  /** The view the frame draws, when it draws one. */
  viewId?: string;
}

/** One write as the host sends it to the pod: checked, and stamped by the host. */
export type CellFrameWriteRequest = {
  [Op in CellBridgeWriteOp]: {
    op: Op;
    payload: CellBridgeWritePayload<Op>;
    viewContext: { typeKey: string; viewId?: string };
    source: "user";
    lens: CellFrameLens;
  };
}[CellBridgeWriteOp];

/** A frame's state, as the host draws it. */
export type CellFrameStatus =
  | { state: "ready" }
  | { state: "error"; message: string; reason?: CellFrameErrorReason };

export interface CellFrameHostOptions {
  /** The running frame's window, or null when there is none. Read per message. */
  frameWindow: () => CellBridgeTarget | null;
  /** `module` (default) writes through the governed doors; `page` refuses every write. */
  mechanism?: "module" | "page";
  lens: CellFrameLens;
  identity: CellFrameIdentity;
  /** The context `synap:init` carries, read when the frame says ready (the theme is current then). */
  init: () => Omit<CellFrameInitContext, "sdkVersion">;
  /** One allowed read, as the viewer. Throws on a failed read. Absent: every read is refused. */
  read?: (
    op: CellBridgeReadOp,
    params: Record<string, CellBridgeParamValue>
  ) => Promise<unknown>;
  /** One checked write, through the pod's governed door. Absent: every write is denied. */
  write?: (request: CellFrameWriteRequest) => Promise<CellBridgeMutateResult>;
  on?: {
    status?: (status: CellFrameStatus) => void;
    resize?: (height: number) => void;
    navigate?: (target: CellFrameNavigationTarget) => void;
    toast?: (message: string, level: "info" | "error") => void;
    openPanel?: (
      panelType: "entity" | "view" | "document",
      resourceId: string
    ) => void;
    openSurface?: (surface: CellFrameSurfaceRequest) => void;
    contextUpdate?: (meta: Record<string, unknown>) => void;
  };
}

/** What a frame reads when its host has no read door. */
export const CELL_FRAME_NO_READS = "This view cannot read here.";
/** What a frame reads when its host has no write door. */
export const CELL_FRAME_NO_WRITES = "This view cannot make changes here.";
const BUSY = "Too many requests at once. Wait for the others to finish.";
const STATUSES = new Set<unknown>(["approved", "proposed", "denied"]);

/** The pod's answer to a write as plain JSON for the frame, or a denial. */
function mutateAnswer(
  id: string,
  result: CellBridgeMutateResult
): CellBridgeHostMessage {
  const status = STATUSES.has(result?.status) ? result.status : "denied";
  const message: Extract<
    CellBridgeHostMessage,
    { type: "synap:mutate:result" }
  > = { type: "synap:mutate:result", id, status };
  if (result?.data !== undefined) {
    const answered = cellBridgeAnswer(id, result.data);
    if (answered.error !== undefined)
      return {
        type: "synap:mutate:result",
        id,
        status: "denied",
        error: answered.error,
      };
    message.data = answered.data;
  }
  if (typeof result?.proposalId === "string")
    message.proposalId = result.proposalId;
  if (typeof result?.error === "string" && result.error.trim())
    message.error = cellBridgeErrorText(new Error(result.error));
  else if (status === "denied" && !STATUSES.has(result?.status))
    message.error = "The pod did not say whether the change was made.";
  return message;
}

/** The `message` handler for one running module frame (one per frame load). */
export function createCellFrameHost(options: CellFrameHostOptions) {
  let inFlight = 0;
  let ready = false;
  let mounted = false;
  const mechanism = options.mechanism ?? "module";
  const on = options.on ?? {};

  return async function onMessage(event: CellBridgeEventLike): Promise<void> {
    const frame = options.frameWindow();
    if (!frame || event.source !== frame) return;
    if (event.origin !== "null") return;
    const msg = parseCellFrameMessage(event.data);
    if (!msg) return;

    const post = (message: unknown) => {
      // The frame may have been reloaded or torn down meanwhile.
      if (options.frameWindow() !== frame) return;
      frame.postMessage(message, "*");
    };

    switch (msg.type) {
      case "synap:ready":
        if (ready) return;
        ready = true;
        post({
          type: "synap:init",
          config: {},
          context: { ...options.init(), sdkVersion: "2" },
        });
        return;
      case "synap:mounted":
        if (mounted) return;
        mounted = true;
        on.status?.({ state: "ready" });
        return;
      case "synap:error":
        on.status?.({
          state: "error",
          message: msg.message,
          ...(msg.reason ? { reason: msg.reason } : {}),
        });
        return;
      case "synap:resize":
        on.resize?.(msg.height);
        return;
      case "synap:navigate":
        on.navigate?.(msg.target);
        return;
      case "synap:toast":
        on.toast?.(msg.message, msg.level);
        return;
      case "synap:open-panel":
        on.openPanel?.(msg.panelType, msg.resourceId);
        return;
      case "synap:surface:open":
        on.openSurface?.(msg.surface);
        return;
      case "synap:context-update":
        on.contextUpdate?.(msg.meta);
        return;
      case "synap:query": {
        const fail = (error: string) =>
          post({ type: "synap:query:result", id: msg.id, error });
        if (!isCellBridgeReadOp(msg.operation)) {
          fail(cellBridgeUnknownOp(msg.operation));
          return;
        }
        const refusal = cellBridgeReadRefusal(msg.operation, options.lens);
        if (refusal) {
          fail(refusal);
          return;
        }
        if (!options.read) {
          fail(CELL_FRAME_NO_READS);
          return;
        }
        if (inFlight >= CELL_BRIDGE_MAX_IN_FLIGHT) {
          fail(BUSY);
          return;
        }
        inFlight += 1;
        try {
          const data = await options.read(
            msg.operation,
            pickBridgeParams(msg.operation, msg.params)
          );
          post(cellBridgeAnswer(msg.id, data));
        } catch (err) {
          fail(cellBridgeErrorText(err));
        } finally {
          inFlight -= 1;
        }
        return;
      }
      case "synap:mutate": {
        const deny = (error: string) =>
          post({
            type: "synap:mutate:result",
            id: msg.id,
            status: "denied",
            error,
          });
        const refusal = cellBridgeWriteRefusal(msg.operation, {
          mechanism,
          identity: options.identity,
        });
        if (refusal) {
          deny(refusal);
          return;
        }
        const op = msg.operation as CellBridgeWriteOp;
        const picked = pickBridgeWritePayload(op, msg.payload);
        if (!picked.ok) {
          deny(picked.error);
          return;
        }
        if (!options.write) {
          deny(CELL_FRAME_NO_WRITES);
          return;
        }
        if (inFlight >= CELL_BRIDGE_MAX_IN_FLIGHT) {
          deny(BUSY);
          return;
        }
        const { typeKey, viewId } = options.identity;
        inFlight += 1;
        try {
          const result = await options.write({
            op,
            payload: picked.payload,
            viewContext: { typeKey: typeKey!, ...(viewId ? { viewId } : {}) },
            source: "user",
            lens: { ...options.lens },
          } as CellFrameWriteRequest);
          post(mutateAnswer(msg.id, result));
        } catch (err) {
          deny(cellBridgeErrorText(err));
        } finally {
          inFlight -= 1;
        }
        return;
      }
    }
  };
}
