import type {
  WorkspaceLayoutConfig,
  WorkspacePrimarySurface,
  WorkspacePrimarySurfaceDefinition,
} from "../schema/workspaces.js";
import { stableStringify } from "./stable-stringify.js";

export interface PrimarySurfaceMergeResult {
  layout: WorkspaceLayoutConfig;
  changed: boolean;
}

export interface WorkspacePrimarySurfaceViewCandidate {
  id: string;
  name: string;
  slug?: string;
}

/**
 * Resolve an authoring-time view name/slug only after the target workspace's
 * views exist. Persisted descriptors remain viewId-only.
 *
 * A missing or ambiguous target is a hard failure: silently keeping an
 * authoring reference would violate the persisted contract, while choosing the
 * first match would make package application order-dependent.
 */
export function resolveWorkspacePrimarySurface(
  surface: WorkspacePrimarySurfaceDefinition | null,
  candidates: WorkspacePrimarySurfaceViewCandidate[]
): WorkspacePrimarySurface | null {
  if (surface === null || surface.kind !== "view" || "viewId" in surface) {
    return surface;
  }

  const matches = candidates.filter(
    (candidate) =>
      (!surface.viewName || candidate.name === surface.viewName) &&
      (!surface.viewSlug || candidate.slug === surface.viewSlug)
  );
  const reference = surface.viewSlug
    ? `viewSlug "${surface.viewSlug}"${
        surface.viewName ? ` and viewName "${surface.viewName}"` : ""
      }`
    : `viewName "${surface.viewName}"`;

  if (matches.length === 0) {
    throw new Error(
      `Primary surface ${reference} did not match a workspace view`
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Primary surface ${reference} is ambiguous (${matches.length} workspace views)`
    );
  }

  return {
    kind: "view",
    viewId: matches[0].id,
    ...(surface.title ? { title: surface.title } : {}),
  };
}

/**
 * Apply the persisted primary-surface three-state contract without touching
 * unrelated layout preferences.
 *
 * - missing property: preserve
 * - null: clear to workspace home
 * - descriptor: replace
 */
export function mergeWorkspacePrimarySurface(
  liveLayout: WorkspaceLayoutConfig,
  incomingLayout: WorkspaceLayoutConfig | undefined
): PrimarySurfaceMergeResult {
  if (
    !incomingLayout ||
    !Object.prototype.hasOwnProperty.call(incomingLayout, "primarySurface")
  ) {
    return { layout: liveLayout, changed: false };
  }

  if (
    stableStringify(liveLayout.primarySurface) ===
    stableStringify(incomingLayout.primarySurface)
  ) {
    return { layout: liveLayout, changed: false };
  }

  return {
    layout: {
      ...liveLayout,
      primarySurface: incomingLayout.primarySurface,
    },
    changed: true,
  };
}
