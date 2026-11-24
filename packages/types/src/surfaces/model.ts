/**
 * The SURFACE model (Surfaces wave, plan 187bbb25 §0, decision of 23 Nov 2026):
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
 * - `attached`: an extra surface put on one object (links `attaches`, P3);
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
  /** Today the existing `/open/<id>` link of the body. */
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
