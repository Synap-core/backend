/**
 * THE frame read door: a framed surface's read, checked by the
 * SERVER against what the surface declares, run as the viewer, and logged.
 * tRPC `surfaces.frameRead` and Hub `POST /frame/read` both call `frameRead`.
 *
 * A host (the web ViewFrame, the desktop's frames, pod admin's HTML and
 * module frames, relay, the renderer bundle) forwards each
 * `window.synap.query(op, params)` of a frame here, naming the surface the
 * frame draws: `{kind: "cell", typeKey}`, `{kind: "document", id}`, or
 * `{kind: "draft", draftId}` for a person's own unsaved draft (a preview).
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
 *      html page reads in its own space; a cell or a draft in the space the
 *      host named, which the viewer must be able to read.
 *   6. The space the read runs in is judged as the CALLER, not only the
 *      person: a key bound to one space (`ctx.keyWorkspaceId`) reads in that
 *      space only (a page of another space: 403 `FRAME_SPACE_FORBIDDEN`,
 *      whatever the person may read), and a host-named lens is read with the
 *      key's grant (`canRead` with the caller's principal).
 *
 * PREVIEWS (founder, 2026-11-26, proposal 356c4d9d). A person's OWN unsaved
 * draft (the desktop's Cell Studio) is `{kind: "draft", draftId}`: nothing of
 * it is stored, so it declares nothing and reads live with that person's
 * access, logged `surface_kind = "draft"` (the preview mark) and
 * `declared = false`. The draft id is the host's (one per draft); the first
 * person whose read the door answered for it owns it, and anyone else naming
 * it is refused (403 `FRAME_DRAFT_NOT_YOURS`, logged refused). A marketplace
 * preview of code from outside the pod never comes here: its host answers
 * from a sample dataset. A frame with no surface reads nothing (its host).
 */

import { createHash } from "node:crypto";
import { db, and, eq, getRequestGrant, isNull, ne, or } from "@synap/database";
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
import { canRead, type Principal } from "../../access/door.js";
import { loadReadableDocument } from "../../utils/document-edit-access.js";
import { stableStringify } from "../../utils/stable-stringify.js";
import { runFrameReadOp } from "./frame-read-ops.js";

/** The surface a frame draws, as its host names it. */
export type FrameSurface =
  | { kind: "cell"; typeKey: string }
  | { kind: "document"; id: string }
  | { kind: "draft"; draftId: string };

export const FRAME_SURFACE_KINDS = ["cell", "document", "draft"] as const;

/** Another person's draft: refused, whatever it asks. */
export const FRAME_DRAFT_NOT_YOURS = "FRAME_DRAFT_NOT_YOURS" as const;

/** A refusal of the door, with the HTTP status Hub REST answers. */
export class FrameReadError extends Error {
  constructor(
    readonly status: 400 | 403 | 404,
    readonly code:
      | typeof FRAME_READ_UNDECLARED
      | typeof FRAME_DRAFT_NOT_YOURS
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

/** A cell type as the catalog stores it (what the door and inspect read). */
export interface ResolvedCellType {
  typeKey: string;
  workspaceId: string | null;
  rendererType: string;
  rendererSource: string | null;
  source: string | null;
  reads: unknown;
}

/**
 * THE cell-type resolution of a frame: the most specific active row, the
 * space's own over the pod-wide one (the same resolution as
 * `resolveViewTrust`). With no space, the pod-wide row only. The frame read
 * door and the surface inspect both read a cell type here.
 */
export async function resolveCellType(
  typeKey: string,
  workspaceId: string | null
): Promise<ResolvedCellType | null> {
  const rows = await db
    .select({
      typeKey: widgetDefinitions.typeKey,
      workspaceId: widgetDefinitions.workspaceId,
      rendererType: widgetDefinitions.rendererType,
      rendererSource: widgetDefinitions.rendererSource,
      source: widgetDefinitions.source,
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
  return rows.find((r) => r.workspaceId === workspaceId) ?? rows[0] ?? null;
}

async function loadCellSurface(
  typeKey: string,
  workspaceId: string | null
): Promise<LoadedSurface | null> {
  const chosen = await resolveCellType(typeKey, workspaceId);
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

/**
 * A person's own unsaved draft (a preview): nothing stored, so it declares
 * nothing and reads in the host's lens. It is `mine: false` when the door
 * already answered another person's read for this draft id.
 */
async function loadDraftSurface(
  userId: string,
  draftId: string,
  workspaceId: string | null
): Promise<LoadedSurface & { mine: boolean }> {
  const [other] = await db
    .select({ userId: frameReadLog.userId })
    .from(frameReadLog)
    .where(
      and(
        eq(frameReadLog.surfaceKind, "draft"),
        eq(frameReadLog.surfaceKey, draftId),
        eq(frameReadLog.allowed, true),
        ne(frameReadLog.userId, userId)
      )
    )
    .limit(1);
  return { key: draftId, workspaceId, declared: null, mine: !other };
}

/**
 * The caller as the access door judges it: the person, the acting agent, the
 * calling key's grant (entered by the key-auth door for this request) and the
 * space the key is bound to. A person's own session has no key: no grant, no
 * binding. Shared with `inspect.ts`, so both doors floor on the same caller.
 */
export function callerPrincipal(ctx: {
  userId: string;
  agentUserId?: string | null;
  keyWorkspaceId?: string | null;
}): Principal {
  return {
    userId: ctx.userId,
    ...(ctx.agentUserId ? { agentUserId: ctx.agentUserId } : {}),
    grant: getRequestGrant() ?? null,
    ...(ctx.keyWorkspaceId
      ? { key: { userId: ctx.userId, workspaceId: ctx.keyWorkspaceId } }
      : {}),
  };
}

/**
 * Does the caller's key reach `workspaceId`? A key bound to one space reaches
 * that space only (never a pod-wide row: null is another space). No binding:
 * yes, the person's floor and the key's grant judge the rest.
 */
export function keyBindingReaches(
  principal: Principal,
  workspaceId: string | null
): boolean {
  const bound = principal.key?.workspaceId ?? null;
  return !bound || bound === workspaceId;
}

/**
 * May the caller read in the host-named lens `workspaceId`? The key's binding,
 * then `canRead` with the caller's principal (membership, and the key's grant
 * when there is one). null with no binding: the caller's own floor.
 */
export async function callerReadsLens(
  principal: Principal,
  workspaceId: string | null
): Promise<boolean> {
  if (!keyBindingReaches(principal, workspaceId)) return false;
  if (!workspaceId) return true;
  return canRead(principal, { workspace: workspaceId });
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
  const principal = callerPrincipal({
    userId,
    agentUserId: ctx.agentUserId,
    keyWorkspaceId: ctx.keyWorkspaceId,
  });

  let surface: LoadedSurface | null;
  let notYours = false;
  if (input.surface.kind === "document") {
    surface = await loadPageSurface(userId, input.surface.id);
    // A page reads in its own space: a key bound to another space does not
    // reach it, whatever the person behind it may read. (The page itself was
    // loaded through `scopedDb`, so the key's grant already floors it.)
    if (surface && !keyBindingReaches(principal, surface.workspaceId)) {
      throw new FrameReadError(
        403,
        "FRAME_SPACE_FORBIDDEN",
        "This page is in another space than the one this key is bound to."
      );
    }
  } else {
    // A cell or a draft reads in the host's lens, which the caller must read.
    const lens = input.workspaceId ?? null;
    if (!(await callerReadsLens(principal, lens))) {
      throw new FrameReadError(
        403,
        "FRAME_SPACE_FORBIDDEN",
        "You cannot read this space."
      );
    }
    if (input.surface.kind === "cell") {
      surface = await loadCellSurface(input.surface.typeKey, lens);
    } else {
      const draft = await loadDraftSurface(userId, input.surface.draftId, lens);
      notYours = !draft.mine;
      surface = draft;
    }
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
    !notYours &&
    (surface.declared === null || isReadDeclared(surface.declared, op, params));

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

  if (notYours) {
    throw new FrameReadError(
      403,
      FRAME_DRAFT_NOT_YOURS,
      "This draft is another person's, so the pod refuses its reads."
    );
  }
  if (!allowed) {
    throw new FrameReadError(
      403,
      FRAME_READ_UNDECLARED,
      `This ${input.surface.kind === "cell" ? "cell" : "page"} does not declare the read "${op}" with these params, so the pod refuses it.`
    );
  }
  return runFrameReadOp(ctx, op, params, surface.workspaceId);
}
