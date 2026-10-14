/**
 * The layer-2 kinds of a template package — ONE list, read by every rule that
 * asks "does this package bring layer 2?" (`declaresLayerTwo`, the apply) and
 * "did this pass converge everything the package declares?" (the boot
 * channel of the finisher, before it may stamp).
 *
 * The list is classified against `PackagePostWorkspaceBody` at COMPILE time:
 * a key added to the applier's body that is neither listed here nor withheld
 * below makes `_classified` a `never`, and the build stops — so a new layer-2
 * kind can never be silently skipped (and a version stamped without it).
 */
import type { PackagePostWorkspaceBody } from "../package-apply-post-workspace.js";

/** The package keys that make up layer 2 (the applier's content). */
export const LAYER_TWO_KEYS = [
  "capabilities",
  "automations",
  "playbooks",
  "loops",
  "cells",
  "actionPlacements",
  "rules",
  "skills",
] as const satisfies ReadonlyArray<keyof PackagePostWorkspaceBody>;

/** Body keys that steer the applier but are not layer-2 content. */
const NOT_LAYER_TWO_CONTENT = [
  // The package identity (slug + version) the applier stamps provenance with.
  "_meta",
  // The caller's engagement project, never the template's.
  "projectId",
] as const satisfies ReadonlyArray<keyof PackagePostWorkspaceBody>;

type _Classified =
  Exclude<
    keyof PackagePostWorkspaceBody,
    (typeof LAYER_TWO_KEYS)[number]
  > extends (typeof NOT_LAYER_TWO_CONTENT)[number]
    ? true
    : never;
const _classified: _Classified = true;
void _classified;

export type LayerTwoKey = (typeof LAYER_TWO_KEYS)[number];

/** The layer-2 kinds a package declares (a non-empty array under the key). */
export function declaredLayerTwoKinds(body: object): LayerTwoKey[] {
  const b = body as Record<string, unknown>;
  return LAYER_TWO_KEYS.filter(
    (k) => Array.isArray(b[k]) && (b[k] as unknown[]).length > 0
  );
}

/** Does this body bring anything for layer 2 to apply? */
export function declaresLayerTwo(body: Record<string, unknown>): boolean {
  return declaredLayerTwoKinds(body).length > 0 || !!body.projectId;
}
