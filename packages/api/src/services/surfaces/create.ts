/**
 * `surfaces.create` — make a surface FOR an object, in one governed act
 * (Surfaces wave P3, plan 187bbb25 §0: "one create door"): the body (a View,
 * Bento, Whiteboard, Document, HTML artifact or Cell) and its `attaches` edge
 * to the anchor.
 *
 * ONE gate for the whole act (`surface/create`, in the ANCHOR's space): an
 * agent's call files ONE proposal that carries the body and the anchor; its
 * approval (`applyCreateSurface`, as the proposal's OWNER) makes both. The
 * body is created under the id reserved at filing (`surfaceId`), so a second
 * approval finds the same row and the same edge.
 *
 * The body-specific doors (`synap_create_view`, `synap_create_document`,
 * `synap_create_cell`) route here when they are given an object to attach to
 * (`attachTo`). Without one, their implied anchor is native (the view's space
 * or project pin, the document's space, an entity's one body) and they keep
 * their own gate, unchanged.
 */

import { randomUUID } from "node:crypto";
import { db, getWorkspaceMembership, isUniqueViolation } from "@synap/database";
import { cellInstances } from "@synap/database/schema";
import {
  CREATABLE_SURFACE_BODIES,
  type CreatableSurfaceBody,
  type CreateSurfaceInput,
  type CreateSurfaceResult,
  type SurfaceAnchor,
  type SurfaceRef,
  type SurfaceSpec,
} from "@synap-core/types/surfaces";
import { buildObjectActionTitle } from "@synap-core/types/vocabulary";
import { checkLinkEndpointVisible } from "../../routers/hub-protocol/rest/link-endpoint-visibility.js";
import type { Context } from "../../context.js";
import { checkPermissionOrPropose } from "../../utils/permission-check.js";
import { assertCellBindable } from "../renderers/renderer-target-checks.js";
import { materializeApprovedDocument } from "../proposals/materialize-approved-document.js";
import { stampAutoApprovedCreate } from "../proposals/stamp-materialized.js";
import {
  anchorWorkspaceId,
  attachedSurfaceOpenUrl,
  detachSlot,
  attachmentMetaProblem,
  insertAttachment,
  surfaceShapeProblem,
  type SurfaceActor,
  type SurfaceDenied,
  type SurfaceRefusal,
} from "./attach.js";

export type CreateOutcome =
  CreateSurfaceResult | SurfaceRefusal | SurfaceDenied;

/** An HTML artifact's page: the same 2 MB cap `synap_create_document` holds. */
export const HTML_SURFACE_MAX_BYTES = 2 * 1024 * 1024;
const TITLE_MAX = 200;

const refuse = (
  httpStatus: SurfaceRefusal["httpStatus"],
  error: string
): SurfaceRefusal => ({ status: "refused", httpStatus, error });

/** The links endpoint type each body is stored as. */
export function surfaceTypeOf(body: CreatableSurfaceBody): SurfaceRef["type"] {
  if (body === "document" || body === "html") return "document";
  if (body === "cell") return "cell_instance";
  return "view";
}

/** One sentence naming what the spec lacks for its body, or null. */
export function surfaceSpecProblem(
  body: CreatableSurfaceBody,
  spec: SurfaceSpec
): string | null {
  switch (body) {
    case "view":
      return spec.viewType !== undefined && typeof spec.viewType !== "string"
        ? "spec.viewType is a view type (table, kanban, list, …)."
        : null;
    case "bento":
    case "whiteboard":
      return null;
    case "document":
      return spec.content === undefined && !spec.url
        ? "A document needs spec.content (markdown) or spec.url (a reference)."
        : null;
    case "html":
      if (typeof spec.content !== "string" || !spec.content.trim()) {
        return "An HTML artifact needs spec.content (the page).";
      }
      return Buffer.byteLength(spec.content, "utf8") > HTML_SURFACE_MAX_BYTES
        ? "An HTML artifact is at most 2 MB."
        : null;
    case "cell":
      return typeof spec.cellKey === "string" && spec.cellKey.trim()
        ? null
        : "A cell needs spec.cellKey (a cell type key: synap_list_widgets).";
  }
}

/**
 * THE governed create: shape → anchor floor → the body's space (the person
 * must be a member of it) → `checkPermissionOrPropose` (`surface/create`) →
 * body + edge.
 */
export async function createSurface(
  actor: SurfaceActor,
  input: CreateSurfaceInput,
  /**
   * `replaceSlot`: the new surface becomes THE one in its `slot` (the
   * object's earlier attachments in that slot are taken off when it lands).
   * Used by the aliased per-object look doors, where a slot holds one look.
   */
  options: { replaceSlot?: boolean } = {}
): Promise<CreateOutcome> {
  const shape = surfaceShapeProblem(input.anchor);
  if (shape) return refuse(400, shape);
  if (!(CREATABLE_SURFACE_BODIES as readonly string[]).includes(input.body)) {
    return refuse(
      400,
      `body must be one of: ${CREATABLE_SURFACE_BODIES.join(", ")}.`
    );
  }
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title || title.length > TITLE_MAX) {
    return refuse(400, `title is text of 1 to ${TITLE_MAX} characters.`);
  }
  const spec = input.spec ?? {};
  const specProblem = surfaceSpecProblem(input.body, spec);
  if (specProblem) return refuse(400, specProblem);
  const metaProblem = attachmentMetaProblem(input);
  if (metaProblem) return refuse(400, metaProblem);

  const anchorRefusal = await checkLinkEndpointVisible(
    input.anchor.kind,
    input.anchor.id,
    actor.userId,
    null
  );
  if (anchorRefusal) return refuse(anchorRefusal.status, anchorRefusal.error);
  const anchorWs = await anchorWorkspaceId(input.anchor);
  const bodyWs = spec.workspaceId ?? anchorWs;
  const bodyProblem = await bodySpaceProblem(
    input.body,
    spec,
    bodyWs,
    actor.userId
  );
  if (bodyProblem) return bodyProblem;

  const surfaceId = randomUUID();
  const data: Record<string, unknown> = {
    title: buildObjectActionTitle({
      action: "create",
      objectKind:
        surfaceTypeOf(input.body) === "cell_instance"
          ? "cell"
          : surfaceTypeOf(input.body),
      objectName: title,
    }),
    name: title,
    anchor: input.anchor,
    body: input.body,
    spec,
    surfaceId,
    bodyWorkspaceId: bodyWs,
    ...(input.slot ? { slot: input.slot } : {}),
    ...(input.label?.trim() ? { label: input.label.trim() } : {}),
    ...(options.replaceSlot && input.slot ? { replaceSlot: true } : {}),
  };
  const perm = await checkPermissionOrPropose({
    userId: actor.userId,
    agentUserId: actor.agentUserId ?? undefined,
    workspaceId: anchorWs,
    subjectType: "surface",
    action: "create",
    ...(actor.sessionId ? { sessionId: actor.sessionId } : {}),
    ...(actor.reasoning?.trim() ? { reasoning: actor.reasoning.trim() } : {}),
    data,
  });
  if ("denied" in perm && perm.denied) {
    return { status: "denied", reason: perm.reason };
  }
  if ("proposalId" in perm) {
    return {
      status: "proposed",
      proposalId: perm.proposalId,
      ...(perm.reviewPath ? { reviewPath: perm.reviewPath } : {}),
      ...(perm.reviewUrl ? { reviewUrl: perm.reviewUrl } : {}),
    };
  }
  const receiptId = "granted" in perm ? perm.autoApprovedProposalId : undefined;
  const applied = await applyCreateSurface({
    ownerUserId: actor.userId,
    agentUserId: actor.agentUserId ?? null,
    data,
    proposalId: receiptId ?? null,
  });
  if (!applied.ok) return refuse(400, applied.why);
  await stampAutoApprovedCreate({
    receiptId,
    record: { linkIds: [applied.linkId] },
    door: actor.door,
  });
  return {
    status: "created",
    surface: applied.surface,
    openUrl: attachedSurfaceOpenUrl(input.anchor, applied.surface.id),
  };
}

/**
 * The space a new body is stored in must be one the person is a member of;
 * a cell lives in a space, always. Refusal or null.
 */
async function bodySpaceProblem(
  body: CreatableSurfaceBody,
  spec: SurfaceSpec,
  bodyWs: string | null,
  userId: string
): Promise<SurfaceRefusal | null> {
  if (bodyWs && !(await getWorkspaceMembership(db, bodyWs, userId))) {
    return refuse(403, `Access denied to workspace ${bodyWs}`);
  }
  if (body === "cell") {
    if (!bodyWs) {
      return refuse(
        400,
        "A cell lives in a space: this object has none, so pass spec.workspaceId."
      );
    }
    try {
      await assertCellBindable({
        cellKey: spec.cellKey!.trim(),
        workspaceId: bodyWs,
        userId,
      });
    } catch (err) {
      return refuse(400, err instanceof Error ? err.message : String(err));
    }
  }
  return null;
}

/**
 * Make the body and its edge, as `ownerUserId` (the person the create is for:
 * the caller on a direct path, the proposal's owner on approval). Re-floors
 * the anchor and the body's space against today's rows. Idempotent: the body
 * is written under the reserved `surfaceId`, the edge on its unique index.
 */
export async function applyCreateSurface(input: {
  ownerUserId: string | null | undefined;
  agentUserId?: string | null;
  data: Record<string, unknown>;
  proposalId: string | null;
}): Promise<
  { ok: true; surface: SurfaceRef; linkId: string } | { ok: false; why: string }
> {
  const d = input.data;
  const anchor = d.anchor as SurfaceAnchor | undefined;
  const body = d.body as CreatableSurfaceBody | undefined;
  const surfaceId = typeof d.surfaceId === "string" ? d.surfaceId : null;
  const name = typeof d.name === "string" ? d.name : null;
  const spec = (d.spec ?? {}) as SurfaceSpec;
  if (
    !anchor ||
    surfaceShapeProblem(anchor) ||
    !body ||
    !(CREATABLE_SURFACE_BODIES as readonly string[]).includes(body) ||
    !surfaceId ||
    !name
  ) {
    return {
      ok: false,
      why: "the proposal does not name an object, a body and a title.",
    };
  }
  const owner = input.ownerUserId;
  if (!owner) {
    return {
      ok: false,
      why: "the proposal records no owner (subject_user_id), so whose object this is cannot be established.",
    };
  }
  const anchorRefusal = await checkLinkEndpointVisible(
    anchor.kind,
    anchor.id,
    owner,
    null
  );
  if (anchorRefusal) {
    return {
      ok: false,
      why: `${anchorRefusal.error}. The object must still exist and be visible to the proposal's owner.`,
    };
  }
  const bodyWs =
    typeof d.bodyWorkspaceId === "string" ? d.bodyWorkspaceId : null;
  const bodyProblem = await bodySpaceProblem(body, spec, bodyWs, owner);
  if (bodyProblem) return { ok: false, why: bodyProblem.error };

  const surface: SurfaceRef = { type: surfaceTypeOf(body), id: surfaceId };
  const made = await makeBody({
    body,
    id: surfaceId,
    name,
    spec,
    workspaceId: bodyWs,
    owner,
    agentUserId: input.agentUserId ?? null,
    proposalId: input.proposalId,
  });
  if (!made.ok) return made;
  if (d.replaceSlot === true && typeof d.slot === "string") {
    await detachSlot(anchor, d.slot, owner, {
      agentUserId: input.agentUserId,
      proposalId: input.proposalId,
    });
  }
  const written = await insertAttachment({
    anchor,
    surface,
    workspaceId: await anchorWorkspaceId(anchor),
    createdBy: owner,
    meta: {
      slot: typeof d.slot === "string" ? d.slot : undefined,
      label: typeof d.label === "string" ? d.label : undefined,
    },
    attribution: {
      agentUserId: input.agentUserId,
      proposalId: input.proposalId,
    },
  });
  return { ok: true, surface, linkId: written.linkId };
}

/** The body, through each body's own write path, as the owner. */
async function makeBody(input: {
  body: CreatableSurfaceBody;
  id: string;
  name: string;
  spec: SurfaceSpec;
  workspaceId: string | null;
  owner: string;
  agentUserId: string | null;
  proposalId: string | null;
}): Promise<{ ok: true } | { ok: false; why: string }> {
  const { body, id, name, spec, workspaceId, owner } = input;
  try {
    switch (body) {
      case "view":
      case "bento":
      case "whiteboard": {
        // The view door, as the owner (the `view/create` executor's caller):
        // its own validation, canvas document, events and session artifact.
        const { viewsRouter } = await import("../../routers/views.js");
        const membership = workspaceId
          ? await getWorkspaceMembership(db, workspaceId, owner)
          : null;
        const caller = viewsRouter.createCaller({
          db,
          authenticated: true,
          userId: owner,
          workspaceId,
          workspaceRole: membership?.role ?? "owner",
        } as unknown as Context);
        const type = body === "view" ? (spec.viewType ?? "table") : body;
        const res = (await caller.create({
          id,
          name,
          type,
          ...(workspaceId ? { workspaceId } : {}),
          ...(spec.config ? { config: spec.config } : {}),
        } as Parameters<typeof caller.create>[0])) as { status?: string };
        if (res?.status === "proposed") {
          return {
            ok: false,
            why: "the view door asked for its own review in this space; create the view first, then attach it.",
          };
        }
        return { ok: true };
      }
      case "document":
      case "html":
        await materializeApprovedDocument({
          documentId: id,
          title: name,
          type: body === "html" ? "html" : "markdown",
          content: spec.content ?? "",
          url: body === "document" ? (spec.url ?? null) : null,
          userId: owner,
          workspaceId,
          sourceProposalId: input.proposalId,
        });
        return { ok: true };
      case "cell":
        await db
          .insert(cellInstances)
          .values({
            id,
            workspaceId: workspaceId!,
            userId: owner,
            cellType: spec.cellKey!.trim(),
            config: spec.props ?? {},
            name,
            createdByKind: input.agentUserId ? "agent" : "user",
            trustLevel: input.agentUserId ? "generated" : "trusted",
          })
          .onConflictDoNothing({ target: cellInstances.id });
        return { ok: true };
    }
  } catch (err) {
    // A second approval: the reserved id is already the body.
    if (isUniqueViolation(err)) return { ok: true };
    return { ok: false, why: err instanceof Error ? err.message : String(err) };
  }
}
