/**
 * LENS SCOPE — where a lens page is looking: `lens(scope)`.
 *
 * Founder rule (2026-10-04): Home, a project, a track and a session are the
 * SAME page through a different lens. The scope is the only parameter, and it
 * changes exactly three things — which empty sections OMIT, the header's ONE
 * scope fact, and which source doors disappear ({@link visibleSource}).
 *
 * The scope travels in the ADDRESS ({@link encodeLensScope}), never by writing
 * the viewer's global project lens. Every kind is encoded by the ONE address
 * door (`encodeActivityScope`), so a Show-all door and a heat cell can never
 * spell one scope two ways.
 */

import { encodeActivityScope, parseActivityScope } from "../activity/heat.js";

export const LENS_SCOPE_KINDS = [
  "pod",
  "workspace",
  "project",
  "track",
  "session",
] as const;
export type LensScopeKind = (typeof LENS_SCOPE_KINDS)[number];

/**
 * A track and a session know their containers when the page knows them —
 * that is what lets {@link visibleSource} hide a source the scope sits INSIDE
 * (the session's own project on a session page). Absent ⇒ unknown, which only
 * ever SHOWS a source (a redundant door is cheaper than a missing one).
 */
export type LensScope =
  | { kind: "pod" }
  | {
      kind: "workspace";
      workspaceId: string;
      /**
       * The project FILTERING this space (BRIEF-lens-model: inside a space the
       * selected project is a filter — "this space × this project"). The read
       * ANDs it onto the workspace (`signals.list` composes the two). Absent ⇒
       * the whole space. Not in the address token: a Show-all door carries
       * the space; the project rides on the surface lens.
       */
      projectId?: string | null;
    }
  | { kind: "project"; projectId: string }
  | { kind: "track"; trackId: string; projectId?: string | null }
  | {
      kind: "session";
      sessionId: string;
      trackId?: string | null;
      projectId?: string | null;
    };

/** The scope's own object, or null for the whole pod. */
export function lensScopeObject(
  scope: LensScope
): { kind: Exclude<LensScopeKind, "pod">; id: string } | null {
  switch (scope.kind) {
    case "pod":
      return null;
    case "workspace":
      return { kind: "workspace", id: scope.workspaceId };
    case "project":
      return { kind: "project", id: scope.projectId };
    case "track":
      return { kind: "track", id: scope.trackId };
    case "session":
      return { kind: "session", id: scope.sessionId };
  }
}

/** The containers the scope sits INSIDE (never itself), as `kind:id` keys. */
function ancestorKeys(scope: LensScope): Set<string> {
  const keys = new Set<string>();
  if (
    (scope.kind === "track" || scope.kind === "workspace") &&
    scope.projectId
  ) {
    keys.add(`project:${scope.projectId}`);
  }
  if (scope.kind === "session") {
    if (scope.trackId) keys.add(`track:${scope.trackId}`);
    if (scope.projectId) keys.add(`project:${scope.projectId}`);
  }
  return keys;
}

/**
 * WHERE a row came from — the small provenance door ("from <session>").
 * `kind` is an object-nav kind, so the door opens through the host's route
 * table like any other object.
 */
export interface LensSource {
  kind: "workspace" | "project" | "track" | "session";
  id: string;
  /** Short display name. */
  label: string;
}

/**
 * The source a row shows AT THIS SCOPE, or null.
 *
 * Hidden when it adds nothing the page does not already say:
 *   - it IS the scope (a session's row on that session's page);
 *   - the scope sits INSIDE it (the project, on one of its sessions' pages).
 *
 * Shown when it is MORE specific than the scope (which session, on a project
 * page) or unrelated to it (any source, on Home). The pod scope therefore
 * shows every source — Home is where provenance is most useful.
 */
export function visibleSource(
  row: { source: LensSource | null },
  scope: LensScope
): LensSource | null {
  const source = row.source;
  if (!source) return null;
  const own = lensScopeObject(scope);
  if (own && own.kind === source.kind && own.id === source.id) return null;
  if (ancestorKeys(scope).has(`${source.kind}:${source.id}`)) return null;
  return source;
}

/**
 * The scope as ONE address token: `pod`, `workspace:<id>`, `project:<id>`,
 * `track:<id>`, `session:<id>` — spelled by THE address door
 * (`encodeActivityScope`), so Work reads a lens page's "Show all" and a heat
 * cell with one reader. Containers do not travel — the page re-reads them
 * from the object.
 */
export function encodeLensScope(scope: LensScope): string {
  if (scope.kind === "track")
    return encodeActivityScope({ kind: "track", trackId: scope.trackId });
  if (scope.kind === "session") {
    return encodeActivityScope({ kind: "session", sessionId: scope.sessionId });
  }
  return encodeActivityScope(scope);
}

/** Read an address token back. Anything else ⇒ `undefined` (no override). */
export function parseLensScope(token: unknown): LensScope | undefined {
  return parseActivityScope(token);
}
