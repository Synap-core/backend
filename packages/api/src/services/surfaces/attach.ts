/**
 * ATTACHED surfaces — the ONE write door and the ONE reader of
 * `<anchor> --attaches--> view | document | cell_instance` (founder
 * decision 23 Nov 2026).
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

import { randomUUID } from "node:crypto";
import { db, and, eq, inArray, uuidFromTextSql } from "@synap/database";
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
  isOpenableAnchorKind,
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

const ATTACHES_LINK_TYPE = "attaches" as const;

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

function isAnchorKind(kind: unknown): kind is AnchorKind {
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

/**
 * Where an attached surface opens: the object's page on that surface,
 * `/open/<kind>/<id>?surface=<surfaceId>`. A kind (profile) the typed route
 * does not serve opens the surface's own page.
 */
export function attachedSurfaceOpenUrl(
  anchor: SurfaceAnchor,
  surfaceId: string
): string {
  return isOpenableAnchorKind(anchor.kind)
    ? openLink(anchor.id, { kind: anchor.kind, surface: surfaceId })
    : openLink(surfaceId);
}

// ── The store write ────────────────────────────────────────────────────────

type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** A link event, emitted once the write that made it has committed. */
type LinkEvent = Parameters<typeof recordLinkMutation>;

function emit(events: LinkEvent[]): void {
  for (const e of events) recordLinkMutation(...e);
}

const anchorEdges = (anchor: SurfaceAnchor) =>
  and(
    eq(links.fromType, anchor.kind),
    eq(links.fromId, anchor.id),
    eq(links.linkType, ATTACHES_LINK_TYPE)
  );

const edgeWhere = (anchor: SurfaceAnchor, surface: SurfaceRef) =>
  and(
    anchorEdges(anchor),
    eq(links.toType, surface.type),
    eq(links.toId, surface.id)
  );

/** An edge's position as a number; a value that is not one sorts last. */
const POSITION = drizzleSql<number>`case when ${links.metadata}->>'position' ~ '^[0-9]+$' then (${links.metadata}->>'position')::int end`;

/**
 * After the object's last attached surface: one past the highest position.
 * Read under a lock on the anchor, held until the caller's transaction ends,
 * so two attaches to one object never take the same position.
 */
async function nextPosition(
  tx: DbOrTx,
  anchor: SurfaceAnchor
): Promise<number> {
  await tx.execute(
    drizzleSql`select pg_advisory_xact_lock(hashtext(${`attaches|${anchor.kind}|${anchor.id}`}))`
  );
  const [row] = await tx
    .select({ n: drizzleSql<number>`coalesce(max(${POSITION}) + 1, 0)` })
    .from(links)
    .where(anchorEdges(anchor));
  return Number(row?.n ?? 0);
}

interface AttachmentWrite {
  anchor: SurfaceAnchor;
  surface: SurfaceRef;
  workspaceId: string | null;
  createdBy: string;
  meta: { slot?: string | null; label?: string | null; position?: number };
  attribution?: { agentUserId?: string | null; proposalId?: string | null };
}

/** The edge write on `tx`; its event is returned, not emitted. */
async function writeAttachment(
  tx: DbOrTx,
  input: AttachmentWrite
): Promise<{ linkId: string; inserted: boolean; events: LinkEvent[] }> {
  const metadata: AttachmentMeta = {
    position: input.meta.position ?? (await nextPosition(tx, input.anchor)),
    ...(input.meta.slot ? { slot: input.meta.slot } : {}),
    ...(input.meta.label?.trim() ? { label: input.meta.label.trim() } : {}),
  };
  const [created] = await tx
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
    return {
      linkId: created.id,
      inserted: true,
      events: [
        [
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
          input.attribution ?? {},
        ],
      ],
    };
  }
  const [existing] = await tx
    .select({ id: links.id })
    .from(links)
    .where(edgeWhere(input.anchor, input.surface))
    .limit(1);
  return { linkId: existing!.id, inserted: false, events: [] };
}

/**
 * THE store write of an attachment. Callers have ALREADY floored both ends and
 * passed the gate (this does no authorization). Idempotent on the unique
 * edge: an existing attachment is reported, never duplicated, its metadata
 * left as it is.
 */
export async function insertAttachment(
  input: AttachmentWrite
): Promise<{ linkId: string; inserted: boolean }> {
  const written = await db.transaction((tx) => writeAttachment(tx, input));
  emit(written.events);
  return { linkId: written.linkId, inserted: written.inserted };
}

/**
 * Take one edge off, on `tx`. An entity's bento is also mirrored in
 * `entities.system_data.bentoViewId` (the renderer ladder of hosts that do not
 * read attachments yet): the mirror naming this view goes with it, so a
 * detached bento is drawn and listed nowhere.
 */
async function removeAttachment(
  tx: DbOrTx,
  input: {
    anchor: SurfaceAnchor;
    surface: SurfaceRef;
    userId: string;
    attribution?: { agentUserId?: string | null; proposalId?: string | null };
  }
): Promise<{ removed: number; events: LinkEvent[] }> {
  const removed = await tx
    .delete(links)
    .where(edgeWhere(input.anchor, input.surface))
    .returning({ id: links.id, workspaceId: links.workspaceId });
  if (input.anchor.kind === "entity" && input.surface.type === "view") {
    await tx
      .update(entities)
      .set({
        systemData: drizzleSql`(coalesce(${entities.systemData}, '{}'::jsonb) - 'bentoViewId') || case when ${entities.systemData}->>'viewMode' = 'bento' then '{"viewMode":"document"}'::jsonb else '{}'::jsonb end`,
      })
      .where(
        and(
          eq(entities.id, input.anchor.id),
          drizzleSql`${entities.systemData}->>'bentoViewId' = ${input.surface.id}`
        )
      );
  }
  return {
    removed: removed.length,
    events: removed.map((row): LinkEvent => [
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
      input.attribution ?? {},
    ]),
  };
}

async function deleteAttachment(
  input: Parameters<typeof removeAttachment>[1]
): Promise<number> {
  const out = await db.transaction((tx) => removeAttachment(tx, input));
  emit(out.events);
  return out.removed;
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

/** The most rows one store answers for one object (the find door's bound). */
export const SURFACE_SOURCE_LIMIT = 200;

/**
 * The surfaces attached to ONE object, in their order, each read under the
 * READER's floor for its own table (a view, a document, a cell instance):
 * one the reader cannot see is left out. The anchor itself was floored by the
 * caller (`surfacesForObject` loads it first).
 */
export async function readAttachedSurfaces(
  access: AccessContext,
  anchor: SurfaceAnchor,
  limit: number = SURFACE_SOURCE_LIMIT,
  onTruncated?: (limit: number) => void
): Promise<SurfaceRow[]> {
  const edges = await db
    .select({
      toType: links.toType,
      toId: links.toId,
      metadata: links.metadata,
    })
    .from(links)
    .where(anchorEdges(anchor))
    .orderBy(drizzleSql`${POSITION} nulls last`, links.createdAt)
    .limit(limit + 1);
  if (edges.length > limit) {
    edges.length = limit;
    onTruncated?.(limit);
  }
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
      and(anchorEdges(anchor), drizzleSql`${links.metadata}->>'slot' = ${slot}`)
    );
  return rows.map((r) => ({
    type: r.toType as SurfaceRef["type"],
    id: r.toId,
  }));
}

/**
 * Put `surface` in the object's `slot`, in ONE transaction: its edge is
 * written first, then every other attachment in that slot (of `toType`, when
 * named) is taken off, and a replaced cell instance nothing else attaches or
 * relates to is deleted (it was only this object's look). A failure leaves the
 * object with its earlier look. With no `surface`, the slot is cleared. The
 * store write only: callers floored the object and passed a gate.
 */
export async function replaceSlot(input: {
  anchor: SurfaceAnchor;
  slot: string;
  surface: SurfaceRef | null;
  /** Before the edge is written, on the same transaction (the new body). */
  makeSurface?: (tx: DbOrTx) => Promise<void>;
  workspaceId: string | null;
  userId: string;
  label?: string | null;
  toType?: SurfaceRef["type"];
  attribution?: { agentUserId?: string | null; proposalId?: string | null };
}): Promise<{ linkId: string | null; removed: number }> {
  const attribution = input.attribution ?? {};
  const out = await db.transaction(async (tx) => {
    const events: LinkEvent[] = [];
    let linkId: string | null = null;
    if (input.surface) {
      await input.makeSurface?.(tx);
      const written = await writeAttachment(tx, {
        anchor: input.anchor,
        surface: input.surface,
        workspaceId: input.workspaceId,
        createdBy: input.userId,
        meta: { slot: input.slot, label: input.label },
        attribution,
      });
      events.push(...written.events);
      linkId = written.linkId;
    }
    const previous = (
      await tx
        .select({ toType: links.toType, toId: links.toId })
        .from(links)
        .where(
          and(
            anchorEdges(input.anchor),
            drizzleSql`${links.metadata}->>'slot' = ${input.slot}`,
            ...(input.toType ? [eq(links.toType, input.toType)] : [])
          )
        )
    ).filter(
      (p) =>
        !input.surface ||
        p.toType !== input.surface.type ||
        p.toId !== input.surface.id
    );
    let removed = 0;
    for (const p of previous) {
      const r = await removeAttachment(tx, {
        anchor: input.anchor,
        surface: { type: p.toType as SurfaceRef["type"], id: p.toId },
        userId: input.userId,
        attribution,
      });
      removed += r.removed;
      events.push(...r.events);
    }
    const replacedCells = previous
      .filter((p) => p.toType === "cell_instance")
      .map((p) => p.toId);
    if (replacedCells.length > 0) {
      await tx.execute(drizzleSql`
        delete from cell_instances c
        where c.id in (${drizzleSql.join(
          // The value is cast, not the key, so the delete probes the
          // primary key (read-patterns: key-cast-to-text).
          replacedCells.map((id) => uuidFromTextSql(drizzleSql`${id}`)),
          drizzleSql`, `
        )})
          and not exists (select 1 from links l
            where l.to_type = 'cell_instance' and l.to_id = c.id::text)
          and not exists (select 1 from relations r
            where r.source_cell_id = c.id or r.target_cell_id = c.id)`);
    }
    return { linkId, removed, events };
  });
  emit(out.events);
  return { linkId: out.linkId, removed: out.removed };
}

/**
 * Make `cellKey` THE look of one object's `detail` slot: a new instance of
 * that cell is made in `workspaceId` and attached in slot `detail`, replacing
 * the object's earlier cell look (`replaceSlot`, one transaction). A null
 * `cellKey` clears the slot.
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
  const { cellKey, workspaceId } = input;
  const surface: SurfaceRef | null =
    cellKey && workspaceId ? { type: "cell_instance", id: randomUUID() } : null;
  const { removed } = await replaceSlot({
    anchor: input.anchor,
    slot: "detail",
    surface,
    toType: "cell_instance",
    makeSurface: async (tx) => {
      await tx.insert(cellInstances).values({
        id: surface!.id,
        workspaceId: workspaceId!,
        userId: input.ownerUserId,
        cellType: cellKey!,
        config: input.props ?? {},
        createdByKind: input.agentUserId ? "agent" : "user",
        trustLevel: input.agentUserId ? "generated" : "trusted",
      });
    },
    workspaceId,
    userId: input.ownerUserId,
    attribution: {
      agentUserId: input.agentUserId ?? null,
      proposalId: input.proposalId ?? null,
    },
  });
  return surface
    ? { attached: true, surface, removed }
    : { attached: false, removed };
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
const VIEW_ANCHOR_METADATA_KEYS = [
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
