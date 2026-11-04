/**
 * THE SCOPE A CELL READS INSIDE A DOCUMENT — one rule for every client.
 *
 * A lens-backed cell (`lens-section`) never carries a scope in its props: the
 * AI arranges cells, the HOST says where they look. Before this module the
 * rule had two homes that disagreed (Generative UI wave 3, plan 9ad4b2fc §3):
 * the web (`cellLensScope` + `documentLensScope`, synap-app hooks) narrowed a
 * pod-wide document read inside a space to that space; the phone
 * (`documentCellScope`, relay-app) did not. Both now read it here.
 *
 * The rule, in order:
 *   1. a scope the host stamped (a document's stored `documents.scope`) wins,
 *      except that a POD scope read under a host that pinned a space is
 *      narrowed to that space — a shared pod page must not show a space's
 *      reader the rest of the pod ({@link documentLensScope});
 *   2. else the cell's workspace floor: an explicit workspace scope, else its
 *      workspace id unless the floor says the cell is pod-wide;
 *   3. else the whole pod.
 *
 * Pure and dependency-free. A client's own workspace-scope type (web's
 * `WorkspaceScope`) is read STRUCTURALLY ({@link CellWorkspaceFloor}), so no
 * client type crosses into this package.
 */

import type { LensScope } from "./scope.js";

/**
 * The space floor a host pins around a cell, read structurally: `{ type:
 * "workspace", workspaceId }` names a space, `{ type: "pod" }` says the cell
 * is pod-wide on purpose; any other `type` ("active", "multi"...) names no
 * one space and defers to the cell's `workspaceId`.
 */
export interface CellWorkspaceFloor {
  type: string;
  workspaceId?: string | null;
}

/** What a cell's host knows: the inputs of {@link cellLensScope}. */
export interface CellScopeContext {
  /** The scope the host stamped (a document's stored scope, already narrowed). */
  lensScope?: LensScope | null;
  /** The cell's workspace; empty or absent = none. */
  workspaceId?: string | null;
  /** The floor the host pinned (see {@link CellWorkspaceFloor}). */
  workspaceScope?: CellWorkspaceFloor | null;
}

/** The space a floor pins, or null when it names none. */
function pinnedSpace(
  floor: CellWorkspaceFloor | null | undefined
): string | null {
  return floor?.type === "workspace" && floor.workspaceId
    ? floor.workspaceId
    : null;
}

/**
 * The stored scope of a document, as its embeds read it under `host`: a pod
 * scope is narrowed to the space the host pinned; every other scope is kept.
 */
export function documentLensScope(
  stored: LensScope,
  host: { workspaceScope?: CellWorkspaceFloor | null }
): LensScope {
  const space = pinnedSpace(host.workspaceScope);
  if (stored.kind === "pod" && space) {
    return { kind: "workspace", workspaceId: space };
  }
  return stored;
}

/** The scope a cell reads at, from what its host knows (the rule above, steps 2-3). */
export function cellLensScope(ctx: CellScopeContext): LensScope {
  if (ctx.lensScope) return ctx.lensScope;
  const space = pinnedSpace(ctx.workspaceScope);
  if (space) return { kind: "workspace", workspaceId: space };
  if (ctx.workspaceScope?.type !== "pod" && ctx.workspaceId) {
    return { kind: "workspace", workspaceId: ctx.workspaceId };
  }
  return { kind: "pod" };
}

/**
 * The scope EVERY cell of a document reads: its stored scope (narrowed under
 * `host`, {@link documentLensScope}), else the document's space, else the pod.
 * The composition both clients draw a document's cells by; a host that pinned
 * no space (the phone's document page today) passes none.
 */
export function documentCellScope(
  doc: { scope?: LensScope | null; workspaceId?: string | null },
  host: { workspaceScope?: CellWorkspaceFloor | null } = {}
): LensScope {
  return cellLensScope({
    lensScope: doc.scope ? documentLensScope(doc.scope, host) : null,
    workspaceId: doc.workspaceId ?? null,
    workspaceScope: doc.workspaceId
      ? { type: "workspace", workspaceId: doc.workspaceId }
      : { type: "pod" },
  });
}
