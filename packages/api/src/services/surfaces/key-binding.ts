/**
 * A surface WRITE judged as the calling KEY (security review H3, 27 Nov
 * 2026): a key bound to one space (`keyWorkspaceId`) makes, attaches and
 * takes off surfaces in that space only. The write doors (`create.ts`,
 * `attach.ts`) floor both ends for the PERSON behind the key; this adds the
 * key's binding, the same rule the frame read door applies
 * (`keyBindingReaches`): a bound key reaches its own space, never another
 * one and never a pod-wide row.
 *
 * Called by every door that names a key before it calls the write service:
 * Hub `POST /surfaces`, `POST|DELETE /surfaces/attach`, tRPC
 * `surfaces.create|attach|detach`, MCP `synap_create_surface`,
 * `synap_attach_surface` and the doors that create a surface for an object
 * (`attachTo`). With no binding it reads nothing and returns null.
 *
 * Order: the ends are floored for the person FIRST (the write door's own
 * refusal, so a row the caller cannot see reads as missing, never as "in
 * another space"), then each end's space is compared with the binding.
 */

import { db, eq } from "@synap/database";
import { cellInstances, documents, views } from "@synap/database/schema";
import type { SurfaceAnchor, SurfaceRef } from "@synap-core/types/surfaces";
import { checkLinkEndpointVisible } from "../../routers/hub-protocol/rest/link-endpoint-visibility.js";
import {
  anchorWorkspaceId,
  validateSurfaceLink,
  type SurfaceRefusal,
} from "./attach.js";

/** The space a surface lives in (null: pod-wide or personal, or gone). */
export async function surfaceWorkspaceId(
  surface: SurfaceRef
): Promise<string | null> {
  const one = async (q: Promise<Array<{ ws: string | null }>>) =>
    (await q)[0]?.ws ?? null;
  switch (surface.type) {
    case "view":
      return one(
        db
          .select({ ws: views.workspaceId })
          .from(views)
          .where(eq(views.id, surface.id))
          .limit(1)
      );
    case "document":
      return one(
        db
          .select({ ws: documents.workspaceId })
          .from(documents)
          .where(eq(documents.id, surface.id))
          .limit(1)
      );
    case "cell_instance":
      return one(
        db
          .select({ ws: cellInstances.workspaceId })
          .from(cellInstances)
          .where(eq(cellInstances.id, surface.id))
          .limit(1)
      );
  }
}

function offKey(keyWorkspaceId: string, what: string): SurfaceRefusal {
  return {
    status: "refused",
    httpStatus: 403,
    error: `This key is confined to workspace ${keyWorkspaceId}: ${what} is outside it.`,
  };
}

/**
 * Null when the key may make this surface write; otherwise the refusal the
 * door answers with (403, or the person's own 400/404 floor).
 *
 *  - attach / detach: `surface` set — the anchor and the surface must both
 *    be in the key's space;
 *  - create: `surface` absent — the anchor, and the space the body is made
 *    in (`bodyWorkspaceId`, else the anchor's), must be the key's space.
 */
export async function surfaceKeyRefusal(input: {
  keyWorkspaceId: string | null | undefined;
  userId: string;
  anchor: SurfaceAnchor;
  surface?: SurfaceRef;
  bodyWorkspaceId?: string | null;
}): Promise<SurfaceRefusal | null> {
  const bound = input.keyWorkspaceId ?? null;
  if (!bound) return null;
  if (input.surface) {
    const valid = await validateSurfaceLink(
      input.anchor,
      input.surface,
      input.userId
    );
    if (!("ok" in valid)) return valid;
    if (valid.workspaceId !== bound) return offKey(bound, "the object");
    if ((await surfaceWorkspaceId(input.surface)) !== bound) {
      return offKey(bound, "the surface");
    }
    return null;
  }
  const refusal = await checkLinkEndpointVisible(
    input.anchor.kind,
    input.anchor.id,
    input.userId,
    null
  );
  if (refusal) {
    return {
      status: "refused",
      httpStatus: refusal.status,
      error: refusal.error,
    };
  }
  const anchorWs = await anchorWorkspaceId(input.anchor);
  if (anchorWs !== bound) return offKey(bound, "the object");
  if ((input.bodyWorkspaceId ?? anchorWs) !== bound) {
    return offKey(bound, "the space the surface would be made in");
  }
  return null;
}
