/**
 * Deprecated-surface registry — the SSOT for "this surface left the default
 * path, here's why, here's what replaced it" (V1 plan, Synap doc 31de1f4c,
 * §4 "Deprecation mechanism", decided 2026-09-28).
 *
 * WHY THIS EXISTS. V1 narrows the browser rail to Home/Work/Data and the relay
 * bar to Home/+/Work. Several existing apps/tabs/sections are NOT deleted —
 * "nothing is deleted" (plan decision F4) — they just leave the default
 * navigation, with a recorded reason and a pointer to what replaced them, so a
 * future agent (or founder) doesn't silently re-add a surface the plan
 * deliberately moved off the rail.
 *
 * WHAT THIS DOES NOT DO (yet). This wave (W0) only builds the registry +
 * banners + a tripwire that the registered ids exist and are banner-marked.
 * Actually EXCLUDING these ids from the rail/tab-bar/palette defaults is W3
 * ("Rail & bar") — until then this is documentation + a guard against
 * forgetting, not enforcement.
 *
 * Pure + dependency-free — safe to import from browser (Electron), relay
 * (React Native), CLI, or server contexts (same contract as `./vocabulary`).
 */

export type DeprecatedSurfaceHost = "browser" | "relay";

export interface DeprecatedSurface {
  /**
   * The id a reader can grep for on the surface's own side:
   * - browser: a `browser/electron/renderer/src/apps/manifest.ts` app id
   * - relay: a relay tab id (`MobileTabId`) OR, when the deprecated thing is
   *   not a route but a section mounted on another screen (e.g. Home's Idea
   *   Studio), a descriptive id that the banner comment on that section names
   *   verbatim — see `decisionDoc` / `reason` for which case applies.
   */
  id: string;
  surface: DeprecatedSurfaceHost;
  /** ISO date the deprecation was decided. */
  since: string;
  reason: string;
  replacedBy: string;
  decisionDoc: string;
}

const V1_PLAN_DOC = "Synap doc 31de1f4c — V1 plan";
const SINCE = "2026-09-28";

/**
 * Every surface the V1 plan (§2 "V1 surface map") marks DEPRECATE, as of the
 * plan's W0 wave. Add a row here — never delete one, even once a surface is
 * physically removed later; a removed surface still needs its history
 * recorded for anyone who greps for the old id.
 */
export const DEPRECATED_SURFACES: readonly DeprecatedSurface[] = [
  // ── browser (Electron) ────────────────────────────────────────────────
  {
    id: "governance",
    surface: "browser",
    since: SINCE,
    reason:
      "Governance app deprecated: it merges into Work (needs-you) and Settings (Agents, Trust rules, History). Its System tab is retired outright.",
    replacedBy: "Work › Needs you; Settings › AI & agents",
    decisionDoc: V1_PLAN_DOC,
  },
  {
    id: "processors",
    surface: "browser",
    since: SINCE,
    reason:
      "Operations app deprecated: folds into Work › Activity plus the new health mark. Builder mode keeps a door to it.",
    replacedBy: "Work › Activity",
    decisionDoc: V1_PLAN_DOC,
  },
  {
    id: "activity",
    surface: "browser",
    since: SINCE,
    reason:
      "Activity app entry (already folded into Operations/`processors` in 2026-08-19 and aliased via APP_ID_ALIASES) is deprecated alongside `processors` itself.",
    replacedBy: "Work › Activity",
    decisionDoc: V1_PLAN_DOC,
  },
  {
    id: "work-map",
    surface: "browser",
    since: SINCE,
    reason:
      "Work map deprecated AS A STANDALONE APP: it lives on as a view, Work › Map, and on project pages.",
    replacedBy: "Work › Map",
    decisionDoc: V1_PLAN_DOC,
  },

  // ── relay (React Native) ──────────────────────────────────────────────
  {
    id: "rules",
    surface: "relay",
    since: SINCE,
    reason:
      "Rules tab deprecated: moves to Settings › Trust rules (decision D3).",
    replacedBy: "Settings › Trust rules",
    decisionDoc: V1_PLAN_DOC,
  },
  {
    id: "feed",
    surface: "relay",
    since: SINCE,
    reason:
      'Feed/Activity tab deprecated: folds into Home\'s "See all activity"; its needs-you lens is retired (Home already surfaces needs-you).',
    replacedBy: "Home › See all activity",
    decisionDoc: V1_PLAN_DOC,
  },
  {
    id: "idea-studio",
    surface: "relay",
    since: SINCE,
    reason:
      "Idea Studio section on Home deprecated: returns later as an installable template rather than baked into Home.",
    replacedBy: "Templates (market)",
    decisionDoc: V1_PLAN_DOC,
  },
  {
    id: "gallery",
    surface: "relay",
    since: SINCE,
    reason:
      "Gallery tab (classic shell only) deprecated: data browsing is a desktop job (Data app).",
    replacedBy: "Desktop Data app",
    decisionDoc: V1_PLAN_DOC,
  },
  {
    id: "pipeline",
    surface: "relay",
    since: SINCE,
    reason:
      "Pipeline tab (classic shell only) deprecated: data browsing is a desktop job (Data app).",
    replacedBy: "Desktop Data app",
    decisionDoc: V1_PLAN_DOC,
  },
];

export function deprecatedSurfacesFor(
  surface: DeprecatedSurfaceHost
): readonly DeprecatedSurface[] {
  return DEPRECATED_SURFACES.filter((s) => s.surface === surface);
}

export function isDeprecatedSurface(
  surface: DeprecatedSurfaceHost,
  id: string
): boolean {
  return DEPRECATED_SURFACES.some((s) => s.surface === surface && s.id === id);
}
