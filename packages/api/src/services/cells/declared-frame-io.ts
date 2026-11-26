/**
 * The `reads` / `writes` a create door takes for a framed surface (a cell
 * type, an HTML page), checked against the ceiling BEFORE anything is filed:
 * a declaration outside `CELL_BRIDGE_READ_OPS` / `CELL_BRIDGE_WRITE_OPS` is
 * refused with its reason, never stored and never carried into a proposal a
 * person would approve. One parser per door shape (`parseDeclaredReads`,
 * `@synap-core/types/cell-bridge`); `defineCell` runs it again as the one
 * writer.
 *
 * `undefined` = the caller said nothing (omit-is-silence on update);
 * `null` = clear (back to undeclared).
 */

import {
  parseDeclaredReads,
  parseDeclaredWrites,
  type CellBridgeDeclaredReads,
  type CellBridgeDeclaredWrites,
} from "@synap-core/types/cell-bridge";

export type DeclaredFrameIo =
  | {
      ok: true;
      reads?: CellBridgeDeclaredReads | null;
      writes?: CellBridgeDeclaredWrites | null;
    }
  | { ok: false; error: string };

export function readDeclaredFrameIo(raw: {
  reads?: unknown;
  writes?: unknown;
}): DeclaredFrameIo {
  const out: {
    ok: true;
    reads?: CellBridgeDeclaredReads | null;
    writes?: CellBridgeDeclaredWrites | null;
  } = { ok: true };
  if (raw.reads !== undefined) {
    if (raw.reads === null) out.reads = null;
    else {
      const parsed = parseDeclaredReads(raw.reads);
      if (!parsed.ok) return parsed;
      out.reads = parsed.value;
    }
  }
  if (raw.writes !== undefined) {
    if (raw.writes === null) out.writes = null;
    else {
      const parsed = parseDeclaredWrites(raw.writes);
      if (!parsed.ok) return parsed;
      out.writes = parsed.value;
    }
  }
  return out;
}

/** The declared fields to spread into a proposal payload or a write input. */
export function declaredFrameIoFields(
  io: Extract<DeclaredFrameIo, { ok: true }>
): {
  reads?: CellBridgeDeclaredReads | null;
  writes?: CellBridgeDeclaredWrites | null;
} {
  return {
    ...(io.reads !== undefined ? { reads: io.reads } : {}),
    ...(io.writes !== undefined ? { writes: io.writes } : {}),
  };
}
