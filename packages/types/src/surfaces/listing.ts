/**
 * THE rules of an object's Surfaces list, in one home: which rows of
 * `surfaces.forObject` are listed, how many show before "Show all", the noun
 * a body reads as, the object kind its own page is, and which anchor kinds
 * the typed `/open/<kind>/<id>` route serves. Pod admin, the backend's
 * attach door, the app and the browser read them here; none keeps a copy.
 */

import type { Locale } from "../i18n/locale.js";
import { resolveObjectNoun } from "../vocabulary/index.js";
import type { AnchorKind, SurfaceBody, SurfaceRow } from "./model.js";

/** How many rows of an object's Surfaces list show before "Show all". */
export const SURFACES_CAP = 5;

/**
 * The rows an object's page LISTS: not its body (the page draws it), not a
 * kind's look (`renders`, the page is drawn with it), and not the page's own
 * look (an attached surface in the `detail` slot: a per-object look moved off
 * the old override stores, which the page already wears).
 */
export function listedSurfaceRows<
  R extends Pick<SurfaceRow, "relation" | "slot">,
>(rows: readonly R[]): R[] {
  return rows.filter(
    (r) =>
      r.relation !== "body" &&
      r.relation !== "renders" &&
      !(r.relation === "attached" && r.slot === "detail")
  );
}

/** The noun a surface's body reads as (View, HTML artifact, Bento…). */
export function surfaceBodyLabel(body: SurfaceBody, locale?: Locale): string {
  return resolveObjectNoun(body, locale);
}

/**
 * The object kind a body is stored as, the kind its own page opens: an HTML
 * artifact is a document, a bento or a whiteboard is a view, a Site is a
 * project's. Any other body is its own kind.
 */
export function surfaceObjectKind(body: SurfaceBody): string {
  switch (body) {
    case "html":
      return "document";
    case "bento":
    case "whiteboard":
      return "view";
    case "site":
      return "project";
    default:
      return body;
  }
}

/**
 * The anchor kinds the pod's typed `/open/<kind>/<id>` route serves: an
 * attached surface opens on its object's page there
 * (`/open/<kind>/<id>?surface=<id>`). A kind outside it (a profile) opens the
 * surface's own page. A host that renders only some of them (pod admin)
 * narrows this list, never keeps its own.
 */
export const OPENABLE_ANCHOR_KINDS = [
  "entity",
  "workspace",
  "project",
  "track",
  "playbook",
  "session",
] as const satisfies readonly AnchorKind[];
export type OpenableAnchorKind = (typeof OPENABLE_ANCHOR_KINDS)[number];

export function isOpenableAnchorKind(
  kind: string
): kind is OpenableAnchorKind {
  return (OPENABLE_ANCHOR_KINDS as readonly string[]).includes(kind);
}

/**
 * Whether `id` can name an anchor of `kind`: a uuid, except a profile (its id
 * or its slug). The find door answers a malformed id with a 400, never a
 * failed read.
 */
export function isAnchorIdShaped(kind: AnchorKind, id: string): boolean {
  return kind === "profile" || ANCHOR_UUID_RE.test(id);
}

const ANCHOR_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
