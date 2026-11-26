/**
 * Pod admin's frames read through THE frame read door (Surfaces P6a):
 * `surfaces.frameRead`, the tRPC twin of Hub `POST /api/hub/frame/read`.
 * Every `synap:query` of a running frame (a stored HTML page, an HTML cell,
 * a module cell) is forwarded there with the surface the frame draws; the
 * pod checks it against what that surface declares, runs it as the viewer
 * and logs it. The console no longer maps an op to a procedure itself.
 *
 * The lens is the door's: a cell reads in the host's space (`workspaceId`),
 * a page in its own space (the door ignores any other). The params go as the
 * frame host picked them; never a `workspaceId` or `projectId` among them.
 *
 * A refusal (403 `FRAME_READ_UNDECLARED` / `FRAME_SPACE_FORBIDDEN`, 400
 * `FRAME_READ_UNKNOWN_OP`, 404) throws: the frame host answers the frame with
 * the error, never with an empty answer.
 */

import {
  CELL_FRAME_NO_READS,
  type CellBridgeParamValue,
  type CellBridgeReadOp,
} from "@synap-core/types/cell-bridge";
import type { BridgeClient } from "./html-bridge-reads";

/** The surface a frame draws, as the door names it. */
export type FrameSurface =
  { kind: "cell"; typeKey: string } | { kind: "document"; id: string };

export type FrameRead = (
  op: CellBridgeReadOp,
  params: Record<string, CellBridgeParamValue>
) => Promise<unknown>;

/** One frame read, through the door. */
export function readThroughFrameDoor(
  client: BridgeClient,
  surface: FrameSurface,
  op: CellBridgeReadOp,
  params: Record<string, CellBridgeParamValue>,
  lens: { workspaceId: string | null }
): Promise<unknown> {
  return client.surfaces.frameRead.query({
    surface,
    op,
    params,
    // A cell reads in the host's lens; a page reads in its own space.
    ...(surface.kind === "cell" ? { workspaceId: lens.workspaceId } : {}),
  });
}

/**
 * The read a frame host hands its bridge. A frame whose surface the host
 * cannot name cannot be checked by the door, so it reads nothing: every read
 * is answered with the frame's "cannot read here" error.
 */
export function frameReadFor(
  client: BridgeClient,
  surface: FrameSurface | null | undefined,
  lens: { workspaceId: string | null }
): FrameRead {
  if (!surface) {
    return async () => {
      throw new Error(CELL_FRAME_NO_READS);
    };
  }
  return (op, params) =>
    readThroughFrameDoor(client, surface, op, params, lens);
}
