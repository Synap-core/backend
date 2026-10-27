/**
 * The messages between a framed page and its host — a port of the desktop's
 * ViewFrame protocol (synap-app `packages/web/src/cell-runtime/
 * iframe-protocol.ts`: `synap:query` / `synap:mutate` with an `id`, answered
 * by `synap:query:result` / `synap:mutate:result` carrying the same `id`).
 *
 * Only the read path and the write REFUSAL are here: a host of this version
 * answers reads and refuses every write (writes come later, through the
 * proposal door).
 */

/** Frame → host. */
export type CellBridgeFrameMessage =
  | {
      type: "synap:query";
      id: string;
      operation: string;
      params: unknown;
    }
  | {
      type: "synap:mutate";
      id: string;
      operation: string;
      payload: unknown;
    };

/** Host → frame. Exactly one of `data` / `error` is meaningful. */
export type CellBridgeHostMessage =
  | { type: "synap:query:result"; id: string; data?: unknown; error?: string }
  | {
      type: "synap:mutate:result";
      id: string;
      status: "denied";
      error: string;
    };

const MAX_ID_LENGTH = 100;
const MAX_OPERATION_LENGTH = 100;

/**
 * A frame message, validated, or null. Anything else — another library's
 * message, a malformed id, an unknown type — is not ours and is ignored.
 */
export function parseCellBridgeMessage(
  data: unknown
): CellBridgeFrameMessage | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const msg = data as Record<string, unknown>;
  if (msg.type !== "synap:query" && msg.type !== "synap:mutate") return null;
  const { id, operation } = msg;
  if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_LENGTH) {
    return null;
  }
  if (
    typeof operation !== "string" ||
    operation.length === 0 ||
    operation.length > MAX_OPERATION_LENGTH
  ) {
    return null;
  }
  return msg.type === "synap:query"
    ? { type: "synap:query", id, operation, params: msg.params }
    : { type: "synap:mutate", id, operation, payload: msg.payload };
}

/** What a page reads when it asks for a change: v1 is read-only. */
export const CELL_BRIDGE_WRITE_REFUSED =
  "This page can only read. Changes are made in the Synap app.";

/** What a page reads when it asks for an op outside the table. */
export function cellBridgeUnknownOp(operation: string): string {
  return `"${operation}" is not something a page can read.`;
}
