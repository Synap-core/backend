/**
 * ATTACHED surfaces — the ONE write door and the ONE reader of
 * `<anchor> --attaches--> view | document | cell_instance` (Surfaces wave P3,
 * plan 187bbb25 §0 "Where attached lives", founder decision 23 Nov 2026).
 *
 * An object (entity · profile · workspace · project · track · playbook ·
 * session) carries 0..n extra surfaces beside its kind's look (`renders`,
 * kind-level) and its one body. Each is a `links` row whose metadata is
 * `AttachmentMeta {position, slot?, label?}`; one surface may hang on several
 * objects.
 *
 * Every door goes through here: tRPC `surfaces.attach | detach`, MCP
 * `synap_attach_surface`, Hub `POST | DELETE /surfaces/attach`, the create
 * door (`create.ts`) once it made the body, the aliased `entities.
 * setEntityRenderer` and the per-object targets of
 * `synap_promote_cell_to_renderer`. Order:
 *
 *   validate → BOTH ends floored for the acting person (an invisible id and a
 *   missing one get the same refusal) → `checkPermissionOrPropose`
 *   (`surface/attach` | `surface/detach`, in the ANCHOR's space) → write →
 *   `link.<action>.completed`.
 *
 * An agent's call is a proposal (the doors are `disruptive`: a screen on an
 * object everyone who opens it sees); its approval re-runs the same floor as
 * the proposal's OWNER against today's rows (`applyApprovedSurfaceLink`).
 *
 * The reader (`readAttachedSurfaces`) floors each surface for the READER
 * through its own table's rule: a co-worker who cannot see the view attached
 * to a shared deal does not see that row.
 */

import { db, and, eq, inArray } from "@synap/database";
import {
  cellInstances,
  documents,
  entities,
  focusSessions,
  links,
  playbooks,
  profiles,
  projectTracks,
  projects,
  views,
} from "@synap/database/schema";
import { sql as drizzleSql } from "drizzle-orm";
import {
  ANCHOR_KINDS,
  ATTACHABLE_SURFACE_TYPES,
  ATTACHMENT_LABEL_MAX,
  type AnchorKind,
  type AttachmentMeta,
  type AttachSurfaceResult,
  type DetachSurfaceResult,
  type SurfaceAnchor,
  type SurfaceRef,
  type SurfaceRow,
} from "@synap-core/types/surfaces";
import { buildObjectActionTitle } from "@synap-core/types/vocabulary";
import { isLikelyUUID } from "@synap-core/types/proposals";
import { createLogger } from "@synap-core/core";
import { RENDERER_SLOTS } from "../profiles/renderer-slots.js";
import { scopedDb } from "../../access/scoped-db.js";
import type { AccessContext } from "../../access/context.js";
import { checkLinkEndpointsVisible } from "../../routers/hub-protocol/rest/link-endpoint-visibility.js";
import { checkPermissionOrPropose } from "../../utils/permission-check.js";
import { openLink } from "../../utils/deep-links.js";
import { recordLinkMutation } from "../links/dependency-links.js";
import { stampAutoApprovedCreate } from "../proposals/stamp-materialized.js";

const logger = createLogger({ module: "surfaces-attach" });

export const ATTACHES_LINK_TYPE = "attaches" as const;

/** Who acts, and how the write is attributed. */
export interface SurfaceActor {
  /** The acting PERSON (an agent's linked user on an agent door). */
  userId: string;
  /** Set on an agent door: the write is governed as that agent. */
  agentUserId?: string | null;
  sessionId?: string | null;
  reasoning?: string;
  /** The door, for the undo receipt's log line. */
  door: string;
}

/** A refusal before anything was filed or written. */
export interface SurfaceRefusal {
  status: "refused";
  httpStatus: 400 | 403 | 404;
  error: string;
}
export interface SurfaceDenied {
  status: "denied";
  reason: string;
}

export type AttachOutcome =
  AttachSurfaceResult | SurfaceRefusal | SurfaceDenied;
export type DetachOutcome =
  DetachSurfaceResult | SurfaceRefusal | SurfaceDenied;

const refuse = (
  httpStatus: SurfaceRefusal["httpStatus"],
  error: string
): SurfaceRefusal => ({ status: "refused", httpStatus, error });

// ── Shape checks ───────────────────────────────────────────────────────────

export function isAnchorKind(kind: unknown): kind is AnchorKind {
  return (
    typeof kind === "string" &&
    (ANCHOR_KINDS as readonly string[]).includes(kind)
  );
}

function isSurfaceType(type: unknown): type is SurfaceRef["type"] {
  return (
    typeof type === "string" &&
    (ATTACHABLE_SURFACE_TYPES as readonly string[]).includes(type)
  );
}

/** One sentence naming what is wrong with an anchor or a surface, or null. */
export function surfaceShapeProblem(
  anchor: SurfaceAnchor,
  surface?: SurfaceRef
): string | null {
  if (!isAnchorKind(anchor?.kind)) {
    return `anchor.kind must be one of: ${ANCHOR_KINDS.join(", ")}.`;
  }
  if (!isLikelyUUID(anchor.id)) {
    return `anchor.id must be the ${anchor.kind}'s id (a uuid).`;
  }
  if (surface === undefined) return null;
  if (!isSurfaceType(surface?.type)) {
    return `surface.type must be one of: ${ATTACHABLE_SURFACE_TYPES.join(", ")}.`;
  }
  if (!isLikelyUUID(surface.id)) {
    return `surface.id must be the ${surface.type}'s id (a uuid).`;
  }
  return null;
}

/**
 * The metadata an attachment keeps: `slot` one of the renderer slots, `label`
 * trimmed and bounded, `position` a whole number from 0. Returns the sentence
 * that names what is wrong instead.
 */
export function attachmentMetaProblem(input: {
  slot?: unknown;
  label?: unknown;
  position?: unknown;
}): string | null {
  if (
    input.slot !== undefined &&
    input.slot !== null &&
    !(RENDERER_SLOTS as readonly string[]).includes(input.slot as string)
  ) {
    return `slot must be one of: ${RENDERER_SLOTS.join(", ")}.`;
  }
  if (
    input.label !== undefined &&
    input.label !== null &&
    (typeof input.label !== "string" ||
      input.label.trim().length > ATTACHMENT_LABEL_MAX)
  ) {
    return `label is text of at most ${ATTACHMENT_LABEL_MAX} characters.`;
  }
  if (
    input.position !== undefined &&
    input.position !== null &&
    (!Number.isInteger(input.position) || (input.position as number) < 0)
  ) {
    return "position is a whole number from 0.";
  }
  return null;
}

// ── The anchor's space ─────────────────────────────────────────────────────

/**
 * The space an anchor lives in — where the attachment is stamped and where
 * governance judges it. Read AFTER the endpoint floor passed, so it never
 * names a row the caller cannot see. NULL for a pod-wide object.
 */
export async function anchorWorkspaceId(
  anchor: SurfaceAnchor
): Promise<string | null> {
  const one = async (q: Promise<Array<{ ws: string | null }>>) =>
    (await q)[0]?.ws ?? null;
  switch (anchor.kind) {
    case "workspace":
      return anchor.id;
    case "entity":
      return one(
        db
          .select({ ws: entities.workspaceId })
          .from(entities)
          .where(eq(entities.id, anchor.id))
          .limit(1)
      );
    case "project":
      return one(
        db
          .select({ ws: projects.workspaceId })
          .from(projects)
          .where(eq(projects.id, anchor.id))
          .limit(1)
      );
    case "track":
      return one(
        db
          .select({ ws: projects.workspaceId })
          .from(projectTracks)
          .innerJoin(projects, eq(projects.id, projectTracks.projectId))
          .where(eq(projectTracks.id, anchor.id))
          .limit(1)
      );
    case "playbook":
      return one(
        db
          .select({ ws: playbooks.workspaceId })
          .from(playbooks)
          .where(eq(playbooks.id, anchor.id))
          .limit(1)
      );
    case "session":
      return one(
        db
          .select({ ws: focusSessions.workspaceId })
          .from(focusSessions)
          .where(eq(focusSessions.id, anchor.id))
          .limit(1)
      );
    case "profile":
      return one(
        db
          .select({ ws: profiles.workspaceId })
          .from(profiles)
          .where(eq(profiles.id, anchor.id))
          .limit(1)
      );
  }
}

/**
 * Both ends must be objects the acting person can see (the links endpoint
 * floor, one canonical read rule per type). Returns the anchor's space, or the
 * refusal (an invisible and a missing id read the same).
 */
export async function validateSurfaceLink(
  anchor: SurfaceAnchor,
  surface: SurfaceRef,
  userId: string
): Promise<{ ok: true; workspaceId: string | null } | SurfaceRefusal> {
  const shape = surfaceShapeProblem(anchor, surface);
  if (shape) return refuse(400, shape);
  const refusal = await checkLinkEndpointsVisible(
    {
      fromType: anchor.kind,
      fromId: anchor.id,
      toType: surface.type,
      toId: surface.id,
    },
    userId,
    null
  );
  if (refusal) return refuse(refusal.status, refusal.error);
  return { ok: true, workspaceId: await anchorWorkspaceId(anchor) };
}

// ── The link URL ──────────────────────────────────────────────────────────

/** Anchor kinds the pod's typed `/open/<kind>/<id>` route serves. */
const OPENABLE_ANCHOR_KINDS: ReadonlySet<AnchorKind> = new Set([
  "entity",
  "workspace",
  "project",
  "track",
  "playbook",
  "session",
]);

/**
 * Where an attached surface opens: the object's page on that surface,
 * `/open/<kind>/<id>?surface=<surfaceId>`. A kind (profile) the typed route
 * does not serve opens the surface's own page.
 */
export function attachedSurfaceOpenUrl(
  anchor: SurfaceAnchor,
  surfaceId: string
): string {
  return OPENABLE_ANCHOR_KINDS.has(anchor.kind)
    ? openLink(anchor.id, { kind: anchor.kind, surface: surfaceId })
    : openLink(surfaceId);
}

// ── The store write ────────────────────────────────────────────────────────

const edgeWhere = (anchor: SurfaceAnchor, surface: SurfaceRef) =>
  and(
    eq(links.fromType, anchor.kind),
    eq(links.fromId, anchor.id),
    eq(links.toType, surface.type),
    eq(links.toId, surface.id),
    eq(links.linkType, ATTACHES_LINK_TYPE)
  );

/** After the object's last attached surface. */
async function nextPosition(anchor: SurfaceAnchor): Promise<number> {
  const [row] = await db
    .select({
      n: drizzleSql<number>`count(*)::int`,
    })
    .from(links)
    .where(
      and(
        eq(links.fromType, anchor.kind),
        eq(links.fromId, anchor.id),
        eq(links.linkType, ATTACHES_LINK_TYPE)
      )
    );
  return Number(row?.n ?? 0);
}

/**
 * THE store write of an attachment. Callers have ALREADY floored both ends and
 * passed the gate (this does no authorization). Idempotent on the unique
 * edge: an existing attachment is reported, never duplicated, its metadata
 * left as it is.
 */
export async function insertAttachment(input: {
  anchor: SurfaceAnchor;
  surface: SurfaceRef;
  workspaceId: string | null;
  createdBy: string;
  meta: { slot?: string | null; label?: string | null; position?: number };
  attribution?: { agentUserId?: string | null; proposalId?: string | null };
}): Promise<{ linkId: string; inserted: boolean }> {
  const metadata: AttachmentMeta = {
    position: input.meta.position ?? (await nextPosition(input.anchor)),
    ...(input.meta.slot ? { slot: input.meta.slot } : {}),
    ...(input.meta.label?.trim() ? { label: input.meta.label.trim() } : {}),
  };
  const [created] = await db
    .insert(links)
    .values({
      workspaceId: input.workspaceId,
      fromType: input.anchor.kind,
      fromId: input.anchor.id,
      toType: input.surface.type,
      toId: input.surface.id,
      // The literal, not the constant: `links-type-ssot` finds producers by it.
      linkType: "attaches",
      metadata,
      createdBy: input.createdBy,
    })
    .onConflictDoNothing({
      target: [
        links.fromType,
        links.fromId,
        links.toType,
        links.toId,
        links.linkType,
      ],
    })
    .returning({ id: links.id });
  if (created) {
    recordLinkMutation(
      "create",
      {
        id: created.id,
        workspaceId: input.workspaceId,
        fromType: input.anchor.kind,
        fromId: input.anchor.id,
        toType: input.surface.type,
        toId: input.surface.id,
        linkType: ATTACHES_LINK_TYPE,
      },
      input.createdBy,
      input.attribution ?? {}
    );
    return { linkId: created.id, inserted: true };
  }
  const [existing] = await db
    .select({ id: links.id })
    .from(links)
    .where(edgeWhere(input.anchor, input.surface))
    .limit(1);
  return { linkId: existing!.id, inserted: false };
}

async function deleteAttachment(input: {
  anchor: SurfaceAnchor;
  surface: SurfaceRef;
  userId: string;
  attribution?: { agentUserId?: string | null; proposalId?: string | null };
}): Promise<number> {
  const removed = await db
    .delete(links)
    .where(edgeWhere(input.anchor, input.surface))
    .returning({ id: links.id, workspaceId: links.workspaceId });
  for (const row of removed) {
    recordLinkMutation(
      "delete",
      {
        id: row.id,
        workspaceId: row.workspaceId,
        fromType: input.anchor.kind,
        fromId: input.anchor.id,
        toType: input.surface.type,
        toId: input.surface.id,
        linkType: ATTACHES_LINK_TYPE,
      },
      input.userId,
      input.attribution ?? {}
    );
  }
  return removed.length;
}

// ── The governed doors ────────────────────────────────────────────────────

/** The words a proposal is titled with: `Attach view "Investor radar"`. */
async function surfaceTitle(surface: SurfaceRef): Promise<string | null> {
  const pick = async (q: Promise<Array<{ t: string | null }>>) =>
    (await q)[0]?.t ?? null;
  switch (surface.type) {
    case "view":
      return pick(
        db
          .select({ t: views.name })
          .from(views)
          .where(eq(views.id, surface.id))
          .limit(1)
      );
    case "document":
      return pick(
        db
          .select({ t: documents.title })
          .from(documents)
          .where(eq(documents.id, surface.id))
          .limit(1)
      );
    case "cell_instance":
      return pick(
        db
          .select({
            t: drizzleSql<string>`coalesce(${cellInstances.name}, ${cellInstances.cellType})`,
          })
          .from(cellInstances)
          .where(eq(cellInstances.id, surface.id))
          .limit(1)
      );
  }
}

type Gate =
  | { go: true; receiptId?: string }
  | { go: false; result: SurfaceDenied | AttachSurfaceResult };

async function gate(
  actor: SurfaceActor,
  action: "attach" | "detach",
  workspaceId: string | null,
  data: Record<string, unknown>
): Promise<Gate> {
  const perm = await checkPermissionOrPropose({
    userId: actor.userId,
    agentUserId: actor.agentUserId ?? undefined,
    workspaceId,
    subjectType: "surface",
    action,
    ...(actor.sessionId ? { sessionId: actor.sessionId } : {}),
    ...(actor.reasoning?.trim() ? { reasoning: actor.reasoning.trim() } : {}),
    data,
  });
  if ("denied" in perm && perm.denied) {
    return { go: false, result: { status: "denied", reason: perm.reason } };
  }
  if ("proposalId" in perm) {
    return {
      go: false,
      result: {
        status: "proposed",
        proposalId: perm.proposalId,
        ...(perm.reviewPath ? { reviewPath: perm.reviewPath } : {}),
        ...(perm.reviewUrl ? { reviewUrl: perm.reviewUrl } : {}),
      },
    };
  }
  return {
    go: true,
    receiptId: "granted" in perm ? perm.autoApprovedProposalId : undefined,
  };
}

/** What the gate and the approval read: the edge and its metadata. */
function attachData(
  title: string,
  anchor: SurfaceAnchor,
  surface: SurfaceRef,
  meta: { slot?: string | null; label?: string | null; position?: number }
): Record<string, unknown> {
  return {
    title,
    anchor,
    surface,
    ...(meta.slot ? { slot: meta.slot } : {}),
    ...(meta.label?.trim() ? { label: meta.label.trim() } : {}),
    ...(meta.position !== undefined ? { position: meta.position } : {}),
  };
}

/**
 * THE governed attach: floor → `checkPermissionOrPropose` (`surface/attach`,
 * in the anchor's space) → write → undo receipt.
 */
export async function attachSurface(
  actor: SurfaceActor,
  input: {
    anchor: SurfaceAnchor;
    surface: SurfaceRef;
    slot?: string | null;
    label?: string | null;
    position?: number;
  }
): Promise<AttachOutcome> {
  const metaProblem = attachmentMetaProblem(input);
  if (metaProblem) return refuse(400, metaProblem);
  const valid = await validateSurfaceLink(
    input.anchor,
    input.surface,
    actor.userId
  );
  if (!("ok" in valid)) return valid;
  const title = buildObjectActionTitle({
    action: "attach",
    objectKind: input.surface.type,
    objectName: await surfaceTitle(input.surface),
  });
  const g = await gate(
    actor,
    "attach",
    valid.workspaceId,
    attachData(title, input.anchor, input.surface, input)
  );
  if (!g.go) return g.result;
  const written = await insertAttachment({
    anchor: input.anchor,
    surface: input.surface,
    workspaceId: valid.workspaceId,
    createdBy: actor.userId,
    meta: input,
    attribution: { agentUserId: actor.agentUserId, proposalId: g.receiptId },
  });
  if (written.inserted) {
    await stampAutoApprovedCreate({
      receiptId: g.receiptId,
      record: { linkIds: [written.linkId] },
      door: actor.door,
    });
  }
  return {
    status: written.inserted ? "attached" : "exists",
    linkId: written.linkId,
    openUrl: attachedSurfaceOpenUrl(input.anchor, input.surface.id),
  };
}

/** THE governed detach (`surface/detach`). Reports absence honestly. */
export async function detachSurface(
  actor: SurfaceActor,
  input: { anchor: SurfaceAnchor; surface: SurfaceRef }
): Promise<DetachOutcome> {
  const valid = await validateSurfaceLink(
    input.anchor,
    input.surface,
    actor.userId
  );
  if (!("ok" in valid)) return valid;
  const [existing] = await db
    .select({ id: links.id })
    .from(links)
    .where(edgeWhere(input.anchor, input.surface))
    .limit(1);
  // Nothing to take off: no proposal for a no-op.
  if (!existing) return { status: "absent" };
  const title = buildObjectActionTitle({
    action: "detach",
    objectKind: input.surface.type,
    objectName: await surfaceTitle(input.surface),
  });
  const g = await gate(
    actor,
    "detach",
    valid.workspaceId,
    attachData(title, input.anchor, input.surface, {})
  );
  if (!g.go) return g.result as SurfaceDenied | DetachSurfaceResult;
  const removed = await deleteAttachment({
    anchor: input.anchor,
    surface: input.surface,
    userId: actor.userId,
    attribution: { agentUserId: actor.agentUserId, proposalId: g.receiptId },
  });
  return { status: removed > 0 ? "detached" : "absent" };
}

/**
 * Apply an APPROVED `surface/attach` | `surface/detach` proposal, floored on
 * the proposal's OWNER (`proposals.subjectUserId` — never the approver, never
 * the payload) against TODAY's rows: what it names may be gone or hidden since
 * it was filed. Nothing is written on a refusal.
 */
export async function applyApprovedSurfaceLink(input: {
  action: "attach" | "detach";
  data: Record<string, unknown>;
  ownerUserId: string | null | undefined;
  proposalId: string;
}): Promise<{ ok: true; rows: number } | { ok: false; why: string }> {
  const anchor = input.data.anchor as SurfaceAnchor | undefined;
  const surface = input.data.surface as SurfaceRef | undefined;
  if (!anchor || !surface || surfaceShapeProblem(anchor, surface)) {
    return {
      ok: false,
      why: "the proposal does not name an object and a surface.",
    };
  }
  if (!input.ownerUserId) {
    return {
      ok: false,
      why: "the proposal records no owner (subject_user_id), so whose objects these are cannot be established.",
    };
  }
  const valid = await validateSurfaceLink(anchor, surface, input.ownerUserId);
  if (!("ok" in valid)) {
    return {
      ok: false,
      why: `${valid.error}. Both the object and the surface must still exist and be visible to the proposal's owner.`,
    };
  }
  const attribution = { proposalId: input.proposalId };
  if (input.action === "detach") {
    const rows = await deleteAttachment({
      anchor,
      surface,
      userId: input.ownerUserId,
      attribution,
    });
    return { ok: true, rows };
  }
  const meta = {
    slot: typeof input.data.slot === "string" ? input.data.slot : undefined,
    label: typeof input.data.label === "string" ? input.data.label : undefined,
    position:
      typeof input.data.position === "number" ? input.data.position : undefined,
  };
  const problem = attachmentMetaProblem(meta);
  if (problem) return { ok: false, why: problem };
  const written = await insertAttachment({
    anchor,
    surface,
    workspaceId: valid.workspaceId,
    createdBy: input.ownerUserId,
    meta,
    attribution,
  });
  return { ok: true, rows: written.inserted ? 1 : 0 };
}

// ── The reader ─────────────────────────────────────────────────────────────

/**
 * The surfaces attached to ONE object, in their order, each read under the
 * READER's floor for its own table (a view, a document, a cell instance):
 * one the reader cannot see is left out. The anchor itself was floored by the
 * caller (`surfacesForObject` loads it first).
 */
export async function readAttachedSurfaces(
  access: AccessContext,
  anchor: SurfaceAnchor
): Promise<SurfaceRow[]> {
  const edges = await db
    .select({
      toType: links.toType,
      toId: links.toId,
      metadata: links.metadata,
    })
    .from(links)
    .where(
      and(
        eq(links.fromType, anchor.kind),
        eq(links.fromId, anchor.id),
        eq(links.linkType, ATTACHES_LINK_TYPE)
      )
    )
    .orderBy(
      drizzleSql`coalesce((${links.metadata}->>'position')::int, 2147483647)`,
      links.createdAt
    );
  if (edges.length === 0) return [];
  const idsOf = (type: SurfaceRef["type"]) =>
    edges.filter((e) => e.toType === type).map((e) => e.toId);
  const scoped = scopedDb(access);
  const [viewRows, docRows, cellRows] = await Promise.all([
    idsOf("view").length
      ? scoped.findMany<{ id: string; name: string; type: string }>(views, {
          where: inArray(views.id, idsOf("view")),
          columns: { id: true, name: true, type: true },
        })
      : Promise.resolve([]),
    idsOf("document").length
      ? scoped.findMany<{ id: string; title: string; type: string }>(
          documents,
          {
            where: inArray(documents.id, idsOf("document")),
            columns: { id: true, title: true, type: true },
          }
        )
      : Promise.resolve([]),
    idsOf("cell_instance").length
      ? scoped.findMany<{ id: string; name: string | null; cellType: string }>(
          cellInstances,
          {
            where: inArray(cellInstances.id, idsOf("cell_instance")),
            columns: { id: true, name: true, cellType: true },
          }
        )
      : Promise.resolve([]),
  ]);
  const viewById = new Map(viewRows.map((v) => [v.id, v]));
  const docById = new Map(docRows.map((d) => [d.id, d]));
  const cellById = new Map(cellRows.map((c) => [c.id, c]));

  const out: SurfaceRow[] = [];
  for (const e of edges) {
    const meta = (e.metadata ?? {}) as Partial<AttachmentMeta>;
    const label =
      typeof meta.label === "string" && meta.label ? meta.label : null;
    const base = {
      id: e.toId,
      relation: "attached" as const,
      anchor,
      ...(typeof meta.slot === "string" && meta.slot
        ? { slot: meta.slot }
        : {}),
      openUrl: attachedSurfaceOpenUrl(anchor, e.toId),
      source: "attaches",
    };
    if (e.toType === "view") {
      const v = viewById.get(e.toId);
      if (!v) continue;
      const body =
        v.type === "bento"
          ? "bento"
          : v.type === "whiteboard"
            ? "whiteboard"
            : "view";
      out.push({
        ...base,
        body,
        title: label ?? v.name,
        ...(body === "view" ? { viewType: v.type } : {}),
        readOnly: false,
      });
    } else if (e.toType === "document") {
      const d = docById.get(e.toId);
      if (!d) continue;
      const html = d.type === "html";
      out.push({
        ...base,
        body: html ? "html" : "document",
        title: label ?? d.title,
        // An HTML artifact reads pod data through the bridge and never writes.
        readOnly: html,
      });
    } else if (e.toType === "cell_instance") {
      const c = cellById.get(e.toId);
      if (!c) continue;
      out.push({
        ...base,
        body: "cell",
        title: label ?? (c.name || c.cellType),
        cellKey: c.cellType,
        readOnly: false,
      });
    } else {
      logger.warn(
        { toType: e.toType, toId: e.toId },
        "attaches edge to an endpoint type no surface reader knows"
      );
    }
  }
  return out;
}

// ── An object's own look (the aliased per-object renderer doors) ──────────

/** The surfaces an object carries in `slot` (a slot holds one look). */
export async function attachmentsInSlot(
  anchor: SurfaceAnchor,
  slot: string
): Promise<SurfaceRef[]> {
  const rows = await db
    .select({ toType: links.toType, toId: links.toId })
    .from(links)
    .where(
      and(
        eq(links.fromType, anchor.kind),
        eq(links.fromId, anchor.id),
        eq(links.linkType, ATTACHES_LINK_TYPE),
        drizzleSql`${links.metadata}->>'slot' = ${slot}`
      )
    );
  return rows.map((r) => ({
    type: r.toType as SurfaceRef["type"],
    id: r.toId,
  }));
}

/**
 * Take off every attachment the object carries in `slot` (a slot holds one
 * look). The store write only: callers floored the object and passed a gate.
 */
export async function detachSlot(
  anchor: SurfaceAnchor,
  slot: string,
  userId: string,
  attribution: { agentUserId?: string | null; proposalId?: string | null } = {},
  toType?: SurfaceRef["type"]
): Promise<number> {
  const previous = await db
    .select({ toType: links.toType, toId: links.toId })
    .from(links)
    .where(
      and(
        eq(links.fromType, anchor.kind),
        eq(links.fromId, anchor.id),
        eq(links.linkType, ATTACHES_LINK_TYPE),
        drizzleSql`${links.metadata}->>'slot' = ${slot}`,
        ...(toType ? [eq(links.toType, toType)] : [])
      )
    );
  let removed = 0;
  for (const p of previous) {
    removed += await deleteAttachment({
      anchor,
      surface: { type: p.toType as SurfaceRef["type"], id: p.toId },
      userId,
      attribution,
    });
  }
  return removed;
}

/**
 * Make `cellKey` THE look of one object's `detail` slot: the object's
 * `detail` attachments to a cell instance are taken off and, unless
 * `cellKey` is null (clear), a new instance of that cell is made in
 * `workspaceId` and attached in slot `detail`.
 *
 * The write half of the doors that used to store a per-object look elsewhere
 * (`entities.setEntityRenderer` → `entities.system_data.renderer`; the
 * per-object targets of `synap_promote_cell_to_renderer`). Callers have
 * floored the object and passed their own gate: this does no authorization.
 * A cell lives in a space: with no `workspaceId` nothing is attached and the
 * answer says so (`attached: false`).
 */
export async function replaceDetailCellLook(input: {
  anchor: SurfaceAnchor;
  cellKey: string | null;
  props?: Record<string, unknown> | null;
  workspaceId: string | null;
  ownerUserId: string;
  agentUserId?: string | null;
  proposalId?: string | null;
}): Promise<{ attached: boolean; surface?: SurfaceRef; removed: number }> {
  const attribution = {
    agentUserId: input.agentUserId ?? null,
    proposalId: input.proposalId ?? null,
  };
  const removed = await detachSlot(
    input.anchor,
    "detail",
    input.ownerUserId,
    attribution,
    "cell_instance"
  );
  if (!input.cellKey || !input.workspaceId) return { attached: false, removed };
  const [cell] = await db
    .insert(cellInstances)
    .values({
      workspaceId: input.workspaceId,
      userId: input.ownerUserId,
      cellType: input.cellKey,
      config: input.props ?? {},
      createdByKind: input.agentUserId ? "agent" : "user",
      trustLevel: input.agentUserId ? "generated" : "trusted",
    })
    .returning({ id: cellInstances.id });
  const surface: SurfaceRef = { type: "cell_instance", id: cell!.id };
  await insertAttachment({
    anchor: input.anchor,
    surface,
    workspaceId: input.workspaceId,
    createdBy: input.ownerUserId,
    meta: { slot: "detail" },
    attribution,
  });
  return { attached: true, surface, removed };
}

// ── View metadata that anchors (closed to the agent doors) ─────────────────

/**
 * The `views.metadata` keys that ANCHOR a view to an object, read as such by
 * the surface find and the home and board doors: a space's home
 * (`homeScope`), a scoped board (`scopedSurface`), a session's board
 * (`sessionId`), an entity's bento (`entityId`). Only the pod's own doors
 * write them (`views.getHome`, `resolveScopedSurface`, `setEntityViewMode`).
 * An agent door that passed raw metadata through let a key stamp any of them:
 * a view for an object is made with the surface door instead.
 */
export const VIEW_ANCHOR_METADATA_KEYS = [
  "homeScope",
  "scopedSurface",
  "sessionId",
  "entityId",
] as const;

/** The sentence refusing anchor keys in agent-supplied view metadata, or null. */
export function viewAnchorMetadataProblem(
  metadata: Record<string, unknown> | null | undefined
): string | null {
  if (!metadata) return null;
  const found = VIEW_ANCHOR_METADATA_KEYS.filter((k) =>
    Object.hasOwn(metadata, k)
  );
  return found.length
    ? `metadata.${found.join(", metadata.")} anchors a view to an object and is written by the pod only. To make a view FOR an object, use synap_create_surface (POST /surfaces) or attach one with synap_attach_surface.`
    : null;
}
