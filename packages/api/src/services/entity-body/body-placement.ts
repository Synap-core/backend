/**
 * Where a document created AS AN ENTITY'S BODY is filed — a part follows its
 * whole (founder decision 22226da5, 2026-11-09).
 *
 * The create doors that take `entityId` (MCP `synap_create_document`, Hub
 * REST `POST /documents`) filed the new document in the caller's requested
 * space, usually none: an agent's body landed pod-wide while its entity sat in
 * a space, and a key limited to that space got not_found on the body of a
 * record it reads. The body now lands where its entity lives:
 *   - an entity stored in a space → that space;
 *   - a pod-wide entity filed for a space (`home_workspace_id`) → that space;
 *   - a pod-wide entity with no home → the requested space, as before.
 *
 * A requested space that differs is NOT honoured and NOT refused: on these
 * doors the requested space is mostly the ambient lens (the MCP URL lens is
 * injected into every call, an agent's focus fills it), so refusing would
 * fail ordinary attaches. The entity wins and the receipt says so
 * (`warning`). A key BOUND to a space is a confinement, not a lens: a body
 * for an entity of another space is refused (`resolveConfinedWorkspace`).
 *
 * The read rule (`spaceEntityBodyDocumentWhere`, access/grant-read.ts) makes
 * a body readable by its entity's readers wherever it was stored; this keeps
 * new bodies where the read rule is not needed.
 */

import { resolveConfinedWorkspace } from "../../routers/hub-protocol/confine-workspace.js";

export interface BodyTargetEntity {
  id: string;
  workspaceId: string | null;
  homeWorkspaceId: string | null;
}

export interface BodyPlacement {
  /** The space the body document is filed in (`null` = pod-wide). */
  workspaceId: string | null;
  /** Set when the requested space was not used: say it on the receipt. */
  warning?: string;
}

export function bodyPlacementFor(
  entity: BodyTargetEntity,
  requested: string | null | undefined,
  key: { keyType?: string | null; keyWorkspaceId?: string | null } = {}
): BodyPlacement {
  const whole = entity.workspaceId ?? entity.homeWorkspaceId ?? null;
  if (whole === null) return { workspaceId: requested ?? null };
  // Throws FORBIDDEN when a key bound to another space would file here.
  resolveConfinedWorkspace(key.keyType, key.keyWorkspaceId, whole);
  if (requested && requested !== whole) {
    return {
      workspaceId: whole,
      warning: `The document was filed in space ${whole}, where record ${entity.id} lives, not in ${requested}: a body lives with its record.`,
    };
  }
  return { workspaceId: whole };
}

/** Add the placement's warning to a create receipt's `warnings`. */
export function withPlacementWarning<T>(
  receipt: T,
  placement: BodyPlacement | undefined
): T {
  if (!placement?.warning || !receipt || typeof receipt !== "object")
    return receipt;
  const r = receipt as Record<string, unknown>;
  const prior = Array.isArray(r.warnings) ? (r.warnings as unknown[]) : [];
  return { ...r, warnings: [...prior, placement.warning] } as T;
}
