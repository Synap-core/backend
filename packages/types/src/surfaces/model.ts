/**
 * The SURFACE model (founder decision of 23 Nov 2026):
 * a Surface is UI anchored to an object. ONE find door answers "which surfaces
 * does this object already carry?" on every door (tRPC `surfaces.forObject`,
 * MCP `synap_find_surfaces`, Hub REST `GET /api/hub/surfaces`, hub-rest-client
 * `listSurfaces`), all with this shape.
 *
 * A store the door could not read is listed in `unavailable`, never folded
 * into an empty `rows`: "nothing there" and "could not look" are different
 * facts.
 *
 * Pure + dependency-free, like the rest of `@synap-core/types/surfaces`.
 */

/**
 * The kinds of object a surface can be anchored to. A deliberate SUBSET of
 * the links graph's endpoint types (`LinkEndpointType`), not a copy of it, so
 * it is keyed as a record: `links-endpoint-type-ssot` checks that hand-written
 * endpoint lists match the whole union, which this one must not.
 */
const ANCHOR_KIND_SET = {
  entity: true,
  profile: true,
  workspace: true,
  project: true,
  track: true,
  playbook: true,
  session: true,
} as const;
export type AnchorKind = keyof typeof ANCHOR_KIND_SET;
export const ANCHOR_KINDS = Object.keys(ANCHOR_KIND_SET) as [
  AnchorKind,
  ...AnchorKind[],
];

export interface SurfaceAnchor {
  kind: AnchorKind;
  id: string;
}

/** What the surface IS (the body that draws it). */
export const SURFACE_BODIES = [
  "view",
  "document",
  "html",
  "bento",
  "whiteboard",
  "cell",
  "site",
  "app",
] as const;
export type SurfaceBody = (typeof SURFACE_BODIES)[number];

/**
 * How the surface hangs on its anchor:
 * - `renders`: a kind's default look in one slot (renderer bindings);
 * - `attached`: an extra surface put on one object (links `attaches`);
 * - `body`: an entity's one document;
 * - `pinned`: a view pinned to a project or scoped to a kind;
 * - `home`: a space's start page or home board, a kind's bento, a scoped board;
 * - `session-output`: what a session produced (the artifacts ledger);
 * - `exposed`: a Site, a view exposed to a project's members.
 */
export const SURFACE_RELATIONS = [
  "renders",
  "attached",
  "body",
  "pinned",
  "home",
  "session-output",
  "exposed",
] as const;
export type SurfaceRelation = (typeof SURFACE_RELATIONS)[number];

export interface SurfaceRow {
  /** The body's own id (view, document, cell instance, binding, share…). */
  id: string;
  body: SurfaceBody;
  relation: SurfaceRelation;
  anchor: SurfaceAnchor;
  title: string;
  /** For a view body: its view type (table, kanban, pipeline…). */
  viewType?: string;
  /** For a cell body: the cell's key. */
  cellKey?: string;
  /** For a renders row: the renderer slot (list, detail, card, dashboard). */
  slot?: string;
  /**
   * Where it opens: an attached surface on its object's page
   * (`/open/<kind>/<id>?surface=<id>`, `OPENABLE_ANCHOR_KINDS`), any other
   * row the `/open/…` link of its own body.
   */
  openUrl: string;
  /** True when the surface cannot be edited through it (an HTML artifact). */
  readOnly: boolean;
  /** Which store answered (for debugging and inspection). */
  source: string;
}

export interface SurfacesForObject {
  rows: SurfaceRow[];
  /** A store that could not be read: NOT "nothing there". */
  unavailable: { source: string; error: string }[];
}

// ── The write contract: create, attach, detach ──────────────────────────────
//
// An ATTACHED surface is a `links` edge `<anchor> --attaches--> <surface>`
// (founder decision 23 Nov 2026). ONE door writes it on every client: tRPC
// `surfaces.create | attach | detach`, MCP `synap_create_surface` /
// `synap_attach_surface`, Hub REST `POST /surfaces`, `POST /surfaces/attach`,
// `DELETE /surfaces/attach`, hub-rest-client `createSurface` /
// `attachSurface` / `detachSurface`. Every write is governed: an agent's call
// files a proposal (`surface/create | attach | detach`), never a direct write.

/**
 * What a surface is STORED as on the links graph (the edge's TO end): a
 * `views` row (View, Bento, Whiteboard), a `documents` row (Document, HTML
 * artifact) or a `cell_instances` row (a placed Cell).
 */
export const ATTACHABLE_SURFACE_TYPES = [
  "view",
  "document",
  "cell_instance",
] as const;
export type AttachableSurfaceType = (typeof ATTACHABLE_SURFACE_TYPES)[number];

export interface SurfaceRef {
  type: AttachableSurfaceType;
  id: string;
}

/**
 * What an attachment carries (`links.metadata`). `position` orders an
 * object's surfaces (0 first); `slot` names the renderer slot it fills when it
 * replaces a look (`detail` for a per-object look moved off the old override
 * stores); `label` is the name shown in the object's Surfaces list when it
 * differs from the body's own title.
 */
export interface AttachmentMeta {
  position: number;
  slot?: string;
  label?: string;
}

/** The longest `label` an attachment keeps. */
export const ATTACHMENT_LABEL_MAX = 120;

/** The bodies `surfaces.create` can make (a Site or an external app attaches as a reference document). */
export const CREATABLE_SURFACE_BODIES = [
  "view",
  "bento",
  "whiteboard",
  "document",
  "html",
  "cell",
] as const;
export type CreatableSurfaceBody = (typeof CREATABLE_SURFACE_BODIES)[number];

/**
 * What a new surface holds, by body:
 * - view: `viewType` (table, kanban, …; default table), `config`;
 * - bento: `config` (`{ blocks }`);
 * - whiteboard: nothing (an empty board);
 * - document: `content` (markdown) or `url` (a reference);
 * - html: `content` (the page; read-only bridge, at most 2 MB) and `reads`
 *   (what its frame reads, the declaration `synap_create_document` takes,
 *   stored as `metadata.reads` and enforced by the frame read door);
 * - cell: `cellKey` (a cell type key) and `props`.
 * `workspaceId` is the space the body is stored in; default: the anchor's.
 */
export interface SurfaceSpec {
  viewType?: string;
  config?: Record<string, unknown>;
  content?: string;
  url?: string;
  cellKey?: string;
  props?: Record<string, unknown>;
  /** html only: the declared reads, as sent (checked at the door). */
  reads?: unknown[] | null;
  workspaceId?: string;
}

export interface CreateSurfaceInput {
  anchor: SurfaceAnchor;
  body: CreatableSurfaceBody;
  title: string;
  spec?: SurfaceSpec;
  slot?: string;
  label?: string;
}

export interface AttachSurfaceInput {
  anchor: SurfaceAnchor;
  surface: SurfaceRef;
  slot?: string;
  label?: string;
  /** Default: after the object's last attached surface. */
  position?: number;
}

export interface DetachSurfaceInput {
  anchor: SurfaceAnchor;
  surface: SurfaceRef;
}

/** An agent's (or a ruled) write: filed for the person to approve. */
export interface SurfaceWriteProposed {
  status: "proposed";
  proposalId: string;
  reviewPath?: string;
  reviewUrl?: string;
}

export type CreateSurfaceResult =
  | {
      status: "created";
      surface: SurfaceRef;
      /** `/open/<anchor kind>/<anchor id>?surface=<surface id>`. */
      openUrl: string;
    }
  | SurfaceWriteProposed;

export type AttachSurfaceResult =
  | {
      /** `exists`: that surface was already attached to that object. */
      status: "attached" | "exists";
      linkId: string;
      openUrl: string;
    }
  | SurfaceWriteProposed;

export type DetachSurfaceResult =
  | {
      /** `absent`: nothing was attached there, nothing changed. */
      status: "detached" | "absent";
    }
  | SurfaceWriteProposed;

/** The `?surface=` query parameter of an object link. */
export const OPEN_SURFACE_PARAM = "surface";
