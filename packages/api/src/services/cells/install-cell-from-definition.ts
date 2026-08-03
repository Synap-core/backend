/**
 * Install a cell from a PACKAGE payload — the shared mapping onto `defineCell`.
 *
 * A cell reaches the pod from two different package shapes:
 *   - `market.install({kind:"cell"})` — the cell IS the package
 *     (`services/capabilities/marketplace-install.ts`)
 *   - `POST /api/hub/packages/apply` — a WORKSPACE package carrying inline
 *     `cells[]` (`services/package-apply-post-workspace.ts`)
 *
 * Both need the identical mapping: derive the namespaced `typeKey`, and thread
 * `viewTypes` through so an installed renderer registers WITH its view-type
 * affinity. Dropping `viewTypes` is not cosmetic — the render chokepoint mounts
 * a bound cell only when the registration declares an affinity for the view's
 * type, so a cell installed without it can never be selected. That drop has
 * already shipped twice at other layers; this file exists so the two install
 * doors cannot drift into a third copy of it.
 *
 * The actual write stays in the ONE door `defineCell` (undefined-preserving
 * upsert, dep validation, realtime emit). This is mapping only.
 */

import { defineCell } from "./define-cell.js";

/** A cell as authored inside a package definition (CP `cells[]` entry). */
export interface PackageCellDefinition {
  key?: string;
  name?: string;
  code?: string;
  deps?: Record<string, string>;
  defaultSize?: { w: number; h: number };
  /** Package that owns the cell, when the payload names it itself. */
  packageSlug?: string;
  /** View types this cell can render — see the header. */
  viewTypes?: string[];
}

export interface InstallCellFromDefinitionInput {
  definition: PackageCellDefinition;
  /** Display name for the widget-definition row. */
  name: string;
  /** Owning package slug — first segment of the typeKey. */
  packageSlug: string;
  /** Cell key within the package — second segment. Defaults to `definition.key`. */
  cellKey?: string;
  /** Omit / null → pod-global cell. */
  workspaceId?: string | null;
  userId: string;
}

/**
 * Namespaced widget-definition key: `cell:<package>:<cellKey>`. Keeping the
 * derivation here (rather than at each call site) is what makes a re-install
 * through the OTHER door converge onto the same row instead of minting a
 * duplicate renderer.
 */
export function packageCellTypeKey(
  packageSlug: string,
  cellKey: string
): string {
  return `cell:${packageSlug}:${cellKey}`;
}

export async function installCellFromDefinition(
  input: InstallCellFromDefinitionInput
): Promise<{ typeKey: string; changeType: "created" | "updated" }> {
  const { definition } = input;
  if (!definition?.code) {
    throw new Error(
      `Cell "${input.cellKey ?? definition?.key ?? input.name}" is missing its renderer source (code)`
    );
  }
  const cellKey = input.cellKey ?? definition.key;
  if (!cellKey) {
    throw new Error(
      `Cell "${input.name}" has no key — a package cell needs a stable key to install under`
    );
  }
  return defineCell({
    name: input.name,
    rendererSource: definition.code,
    workspaceId: input.workspaceId,
    typeKey: packageCellTypeKey(input.packageSlug, cellKey),
    deps: definition.deps,
    defaultSize: definition.defaultSize,
    // Undefined (not `[]`) when the payload says nothing about affinity, so an
    // upsert over an existing row leaves a declared affinity untouched — the
    // contract `DefineCellInput.viewTypes` documents.
    viewTypes: Array.isArray(definition.viewTypes)
      ? definition.viewTypes
      : undefined,
    userId: input.userId,
  });
}
