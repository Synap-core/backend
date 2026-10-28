/**
 * The console's side of the page bridge (`@synap-core/types/cell-bridge`):
 * one `message` handler per running page. Pure — no React, no tRPC — so its
 * every refusal is testable with a fake window.
 *
 * A message is answered only when ALL hold:
 *   - its `source` is THIS frame's window (`frameWindow()`), so another frame,
 *     a browser extension or the console itself can never ask;
 *   - its `origin` is "null": the opaque origin of the sandboxed srcdoc. A
 *     page that navigated its frame to a real address (https://…) no longer
 *     has it, so the bridge is shut to it even before the host notices;
 *   - it parses as a bridge message.
 * Then: every write is refused; an op outside the shared table is refused;
 * an allowed op is read with only its own params, by `read` (the viewer's
 * session). The answer is posted back to that same window, only while it is
 * still the frame's, with targetOrigin "*" — an opaque-origin frame has no
 * origin to name; what is posted is only the answer the page asked for.
 *
 * A failed read is answered as an ERROR the page can show, never as an empty
 * answer. An answer too large to hand over is an error too, never a cut list.
 */

import {
  CELL_BRIDGE_WRITE_REFUSED,
  cellBridgeUnknownOp,
  isCellBridgeReadOp,
  parseCellBridgeMessage,
  pickBridgeParams,
  type CellBridgeHostMessage,
  type CellBridgeParamValue,
  type CellBridgeReadOp,
} from "@synap-core/types/cell-bridge";

/** What the host posts to: the frame's `contentWindow`. */
export interface BridgeTarget {
  postMessage(message: unknown, targetOrigin: string): void;
}

/** The slice of a `MessageEvent` the host reads. */
export interface BridgeEventLike {
  source: unknown;
  origin: string;
  data: unknown;
}

export interface BridgeHostOptions {
  /** The running frame's window, or null when there is none. Read per message. */
  frameWindow: () => BridgeTarget | null;
  /** One allowed read, as the viewer. Throws on a failed read. */
  read: (
    op: CellBridgeReadOp,
    params: Record<string, CellBridgeParamValue>
  ) => Promise<unknown>;
}

/** The largest answer handed to a page: 1 M characters of JSON. */
export const BRIDGE_MAX_ANSWER_CHARS = 1_000_000;
/** Reads one page may have in flight at once. */
export const BRIDGE_MAX_IN_FLIGHT = 8;

const MAX_ERROR_CHARS = 300;

function errorText(err: unknown): string {
  const message =
    err instanceof Error && err.message.trim()
      ? err.message.trim()
      : "The read failed.";
  return message.length > MAX_ERROR_CHARS
    ? `${message.slice(0, MAX_ERROR_CHARS - 1)}…`
    : message;
}

/**
 * The answer as plain JSON data (dates → strings, no functions, no class
 * instances), or the reason it cannot be handed over.
 */
export function answerMessage(
  id: string,
  data: unknown
): CellBridgeHostMessage {
  let json: string;
  try {
    json = JSON.stringify(data ?? null);
  } catch {
    return {
      type: "synap:query:result",
      id,
      error: "The answer could not be handed to the page.",
    };
  }
  if (json.length > BRIDGE_MAX_ANSWER_CHARS) {
    const mb = (json.length / 1_000_000).toFixed(1);
    return {
      type: "synap:query:result",
      id,
      error: `The answer is too large to hand to the page (${mb} MB). Ask for fewer items.`,
    };
  }
  return { type: "synap:query:result", id, data: JSON.parse(json) };
}

/** The `message` handler for one running page. */
export function createHtmlBridgeHost(options: BridgeHostOptions) {
  let inFlight = 0;
  return async function onMessage(event: BridgeEventLike): Promise<void> {
    const frame = options.frameWindow();
    if (!frame || event.source !== frame) return;
    if (event.origin !== "null") return;
    const msg = parseCellBridgeMessage(event.data);
    if (!msg) return;

    const reply = (message: CellBridgeHostMessage) => {
      // The frame may have been reloaded or torn down while the read ran.
      if (options.frameWindow() !== frame) return;
      frame.postMessage(message, "*");
    };

    if (msg.type === "synap:mutate") {
      reply({
        type: "synap:mutate:result",
        id: msg.id,
        status: "denied",
        error: CELL_BRIDGE_WRITE_REFUSED,
      });
      return;
    }
    if (!isCellBridgeReadOp(msg.operation)) {
      reply({
        type: "synap:query:result",
        id: msg.id,
        error: cellBridgeUnknownOp(msg.operation),
      });
      return;
    }
    if (inFlight >= BRIDGE_MAX_IN_FLIGHT) {
      reply({
        type: "synap:query:result",
        id: msg.id,
        error: "Too many reads at once. Wait for the others to finish.",
      });
      return;
    }
    inFlight += 1;
    try {
      const data = await options.read(
        msg.operation,
        pickBridgeParams(msg.operation, msg.params)
      );
      reply(answerMessage(msg.id, data));
    } catch (err) {
      reply({ type: "synap:query:result", id: msg.id, error: errorText(err) });
    } finally {
      inFlight -= 1;
    }
  };
}
