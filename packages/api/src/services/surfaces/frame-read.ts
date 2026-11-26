/**
 * THE frame read door (Surfaces P6a): a framed surface's read, checked by the
 * SERVER against what the surface declares, run as the viewer, and logged.
 * tRPC `surfaces.frameRead` and Hub `POST /frame/read` both call `frameRead`.
 *
 * A host (the web ViewFrame, the desktop's frames, pod admin's HTML and
 * module frames, relay, the renderer bundle) forwards each
 * `window.synap.query(op, params)` of a frame here, naming the surface the
 * frame draws: `{kind: "cell", typeKey}` or `{kind: "document", id}`.
 *
 *   1. The op must be in the ceiling (`CELL_BRIDGE_READ_OPS`), its params are
 *      narrowed to the op's own list (`pickBridgeParams`).
 *   2. The surface is loaded AS THE VIEWER: a cell type in the frame's space
 *      (or pod-wide), an html page the viewer may read (`isFramePage`: an
 *      `html` document, or an html-embed cell's source). Not found → 404.
 *   3. Its declaration (`widget_definitions.reads`, `documents.metadata.reads`)
 *      decides: a read outside it is REFUSED (403 `FRAME_READ_UNDECLARED`),
 *      whatever the host checked. A surface that declares nothing is answered
 *      (backward compatible while hosts and authors migrate: a founder-
 *      overridable default) and logged `declared: false`.
 *   4. Every call is logged (`frame_read_log`) BEFORE it is answered or
 *      refused; a log that cannot be written fails the read.
 *   5. The read runs with the viewer's own context (`runFrameReadOp`): the
 *      pod floors it to what this viewer may see. The lens is the door's: an
 *      html page reads in its own space; a cell in the space the host named,
 *      which the viewer must be able to read.
 */

import { createHash } from "node:crypto";
import { db, and, eq, isNull, or } from "@synap/database";
import { frameReadLog, widgetDefinitions } from "@synap/database/schema";
import {
  FRAME_READ_UNDECLARED,
  isCellBridgeReadOp,
  isReadDeclared,
  pickBridgeParams,
  storedDeclaredReads,
  type CellBridgeDeclaredReads,
} from "@synap-core/types/cell-bridge";
import type { Context } from "../../types/context.js";
import { canRead, userPrincipal } from "../../access/door.js";
import { loadReadableDocument } from "../../utils/document-edit-access.js";
import { stableStringify } from "../../utils/stable-stringify.js";
import { runFrameReadOp } from "./frame-read-ops.js";

/** The surface a frame draws, as its host names it. */
export type FrameSurface =
  { kind: "cell"; typeKey: string } | { kind: "document"; id: string };

export const FRAME_SURFACE_KINDS = ["cell", "document"] as const;

/** A refusal of the door, with the HTTP status Hub REST answers. */
export class FrameReadError extends Error {
  constructor(
    readonly status: 400 | 403 | 404,
    readonly code:
      | typeof FRAME_READ_UNDECLARED
      | "FRAME_READ_UNKNOWN_OP"
      | "FRAME_SURFACE_NOT_FOUND"
      | "FRAME_SPACE_FORBIDDEN",
    message: string
  ) {
    super(message);
    this.name = "FrameReadError";
  }
}

/** What the door knows about the surface once loaded. */
interface LoadedSurface {
  key: string;
  /** The space the read runs in. */
  workspaceId: string | null;
  /** null = declares nothing. */
  declared: CellBridgeDeclaredReads | null;
}

async function loadCellSurface(
  typeKey: string,
  workspaceId: string | null
): Promise<LoadedSurface | null> {
  // The most specific active row: the space's own over the pod-wide one
  // (the same resolution as `resolveViewTrust`).
  const rows = await db
    .select({
      workspaceId: widgetDefinitions.workspaceId,
      reads: widgetDefinitions.reads,
    })
    .from(widgetDefinitions)
    .where(
      and(
        eq(widgetDefinitions.typeKey, typeKey),
        eq(widgetDefinitions.isActive, true),
        workspaceId
          ? or(
              eq(widgetDefinitions.workspaceId, workspaceId),
              isNull(widgetDefinitions.workspaceId)
            )
          : isNull(widgetDefinitions.workspaceId)
      )
    );
  const chosen =
    rows.find((r) => r.workspaceId === workspaceId) ?? rows[0] ?? null;
  if (!chosen) return null;
  return {
    key: typeKey,
    workspaceId,
    declared: storedDeclaredReads(chosen.reads),
  };
}

/**
 * A document that runs as a page in a frame: an `html` document, or the
 * source of an html-embed cell, which `cellInstances.createHtmlCell` (tRPC and
 * Hub REST) stores as a `text` document with mime type `text/html`. Nothing
 * wider: any other text document (markdown, plain text) is not a page.
 */
export function isFramePage(doc: {
  type: string | null;
  mimeType: string | null;
}): boolean {
  return (
    doc.type === "html" || (doc.type === "text" && doc.mimeType === "text/html")
  );
}

async function loadPageSurface(
  userId: string,
  documentId: string
): Promise<LoadedSurface | null> {
  let doc: Awaited<ReturnType<typeof loadReadableDocument>>;
  try {
    doc = await loadReadableDocument(userId, documentId);
  } catch (err) {
    // Only "not readable by this viewer" is a not-found; a failed read throws.
    if ((err as { code?: string }).code === "NOT_FOUND") return null;
    throw err;
  }
  if (!isFramePage(doc) || doc.deletedAt) return null;
  const metadata = (doc.metadata ?? null) as Record<string, unknown> | null;
  return {
    key: doc.id,
    // A page reads in its own space: the host cannot choose another.
    workspaceId: doc.workspaceId ?? null,
    declared: storedDeclaredReads(metadata?.reads),
  };
}

/** sha256 of the forwarded params, canonical (sorted keys). */
export function frameParamsHash(params: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(params)).digest("hex");
}

/**
 * Read `op` for the frame drawing `surface`, as the viewer in `ctx`.
 * `workspaceId` is the host's lens (used for a cell; a page reads in its own
 * space). Throws `FrameReadError` for a refusal; a failed read throws as is.
 */
export async function frameRead(
  ctx: Context,
  input: {
    surface: FrameSurface;
    op: string;
    params?: unknown;
    workspaceId?: string | null;
  }
): Promise<unknown> {
  const userId = ctx.userId;
  if (!userId) {
    throw new FrameReadError(403, "FRAME_SPACE_FORBIDDEN", "Sign in to read.");
  }
  const { op } = input;
  if (!isCellBridgeReadOp(op)) {
    throw new FrameReadError(
      400,
      "FRAME_READ_UNKNOWN_OP",
      `"${String(op)}" is not a read a frame can ask for.`
    );
  }
  const params = pickBridgeParams(op, input.params ?? {});

  let surface: LoadedSurface | null;
  if (input.surface.kind === "cell") {
    const lens = input.workspaceId ?? null;
    if (lens && !(await canRead(userPrincipal(userId), { workspace: lens }))) {
      throw new FrameReadError(
        403,
        "FRAME_SPACE_FORBIDDEN",
        "You cannot read this space."
      );
    }
    surface = await loadCellSurface(input.surface.typeKey, lens);
  } else {
    surface = await loadPageSurface(userId, input.surface.id);
  }
  if (!surface) {
    throw new FrameReadError(
      404,
      "FRAME_SURFACE_NOT_FOUND",
      "Nothing to read for: this cell or page was not found."
    );
  }

  const declared = surface.declared !== null;
  const allowed =
    surface.declared === null || isReadDeclared(surface.declared, op, params);

  // Logged before anything is answered: a refused read is a fact too.
  await db.insert(frameReadLog).values({
    userId,
    workspaceId: surface.workspaceId,
    surfaceKind: input.surface.kind,
    surfaceKey: surface.key,
    op,
    paramsHash: frameParamsHash(params),
    allowed,
    declared,
  });

  if (!allowed) {
    throw new FrameReadError(
      403,
      FRAME_READ_UNDECLARED,
      `This ${input.surface.kind === "cell" ? "cell" : "page"} does not declare the read "${op}" with these params, so the pod refuses it.`
    );
  }
  return runFrameReadOp(ctx, op, params, surface.workspaceId);
}
