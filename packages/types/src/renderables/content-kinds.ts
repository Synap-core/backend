/**
 * Content kinds — the SINGLE taxonomy for "what a cell renders".
 *
 * This replaces the old profile-"slot" concept (list/detail/dashboard): there is
 * only ONE taxonomy, and a profile picks one renderer per ContentKind.
 *
 * Note the THREE orthogonal axes a cell has, kept separate:
 *   - `contentKind` (SINGULAR, here) — WHAT it renders + which profile assignment
 *     it fills. `widget` is the content-agnostic default (the safe fallback for
 *     AI-generated / imported cells); never a profile assignment, only placeable.
 *   - `placement` (PLURAL) — WHERE it can render (bento/page/side/inline/floating).
 *   - rendering mechanism (`renderer_type`: frame/builtin/iframe/native) — HOW it's
 *     implemented. Distinct from contentKind; lives on the cell/widget definition.
 *
 * Zero React, zero DB — the shared contract imported by BOTH the backend
 * (`widget_definitions.content_kind`, `getEffectiveRenderer`) and the frontend
 * (`CellMeta.contentKind`, the renderer studio). One definition, no drift.
 */

export const CONTENT_KINDS = [
  "entity-detail", // renders ONE entity — its full page
  "entity-card", // renders ONE entity — its small, embeddable block
  "entity-profile", // renders the WHOLE profile/type — its dashboard / home
  "collection", // renders a view of MANY entities — table / kanban / gallery / …
  "widget", // generic, content-agnostic — the DEFAULT; not a profile assignment
] as const;

export type ContentKind = (typeof CONTENT_KINDS)[number];

export function isContentKind(v: unknown): v is ContentKind {
  return (
    typeof v === "string" && (CONTENT_KINDS as readonly string[]).includes(v)
  );
}

/**
 * The content kinds a profile actually ASSIGNS, one each (entity-detail,
 * entity-card, entity-profile, collection). `widget` is placeable but never
 * assigned to a profile, so it's excluded.
 */
export const PROFILE_CONTENT_KINDS = [
  "entity-detail",
  "entity-card",
  "entity-profile",
  "collection",
] as const satisfies readonly ContentKind[];

export type ProfileContentKind = (typeof PROFILE_CONTENT_KINDS)[number];

export function isProfileContentKind(v: unknown): v is ProfileContentKind {
  return (
    typeof v === "string" &&
    (PROFILE_CONTENT_KINDS as readonly string[]).includes(v)
  );
}

/** Where a cell can render. A cell may support several. */
export const PLACEMENTS = [
  "bento",
  "page",
  "side",
  "inline",
  "floating",
] as const;

export type Placement = (typeof PLACEMENTS)[number];

/**
 * Map Track B's legacy `widget_definitions.role` → `ContentKind`. The old `role`
 * conflated content with placement; de-conflate here:
 *   entity-renderer → entity-detail
 *   view-renderer   → collection
 *   panel           → widget   (panel was a PLACEMENT, not a content kind)
 *   widget          → widget
 * `entity-profile` is NEW (Track B had no profile-level role) — set explicitly
 * on cells that render a whole profile; it never arrives from a legacy role.
 */
export function contentKindFromLegacyRole(
  role: string | null | undefined
): ContentKind {
  switch (role) {
    case "entity-renderer":
      return "entity-detail";
    case "view-renderer":
      return "collection";
    case "panel":
    case "widget":
      return "widget";
    default:
      return "widget";
  }
}

/**
 * Display metadata for the renderer studio — one entry per PROFILE content kind,
 * ordered single → many → whole-profile. `icon` is a lucide-react name.
 */
export const CONTENT_KIND_META: Record<
  ProfileContentKind,
  { label: string; purpose: string; icon: string }
> = {
  "entity-detail": {
    label: "Detail view",
    purpose:
      "One item open — the full page you see when you click into a record",
    icon: "AlignLeft",
  },
  "entity-card": {
    label: "Card",
    purpose:
      "One item in miniature — the block it becomes on a board, in a dashboard, or embedded in a document",
    icon: "IdCard",
  },
  collection: {
    label: "List / table",
    purpose:
      "All items together — the main browsable list, table, kanban, or grid",
    icon: "List",
  },
  "entity-profile": {
    label: "Profile home",
    purpose:
      "The dashboard for this whole type — shown when you navigate to the profile itself",
    icon: "LayoutDashboard",
  },
};
