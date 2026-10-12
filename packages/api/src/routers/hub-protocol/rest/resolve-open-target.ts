/**
 * resolveOpenTarget — "what is this id, and where does it open?" as ONE body.
 *
 * Two doors serve this answer and they must never disagree:
 *   • Hub REST `GET /api/hub/resolve/:id` (`resolve.ts`) — the CLI and Relay,
 *     which authenticate with a Bearer key / `X-Session-Token`;
 *   • tRPC `diagnose.resolveOpen` (`routers/diagnose.ts`) — the desktop, whose
 *     remote-pod transport is the Kratos COOKIE, which Hub REST auth does not
 *     accept (every desktop bare-id link used to 401 → "lookup failed").
 *
 * Both call THIS function, so there is one probe list (`resolveObjectKind`), one
 * label projection (`browserRouteFor`) and one body shape. A door only adapts
 * the FAILURE to its transport: this function THROWS when the probe fails, and
 * each door turns that into its own error (REST: 500 `RESOLVE_FAILED`; tRPC:
 * `INTERNAL_SERVER_ERROR`). A failure is never folded into `type: "unknown"`,
 * which means "the probe ran and nothing the caller can see has this id".
 *
 * The caller's `userId` is the visibility floor: every probe inside
 * `resolveObjectKind` ANDs it onto its id lookup.
 */

import { resolveObjectKind } from "../../../services/diagnose/resolve-object-kind.js";
import { browserRouteFor } from "./resolve-browser-route.js";

/** `unknown` is not a routable label — it is the honest "no match" answer. */
export const RESOLVE_UNKNOWN_TYPE = "unknown";

export interface OpenTarget {
  /** An `object-nav.ts` label, a known-but-unopenable kind, or `unknown`. */
  type: string;
  /** The id to OPEN — may differ from the queried id (a correlationId). */
  id: string;
  displayName: string | null;
  workspaceId: string | null;
  profileSlug?: string;
  /** Whether `type` names a surface the browser can open. */
  openable: boolean;
  /** Address parameters the link must carry (only runs: `flowType`). */
  params?: Record<string, string>;
}

/**
 * Resolve `id` for `userId`. Returns the found / unopenable / unknown body;
 * THROWS when the lookup itself failed.
 */
export async function resolveOpenTarget(
  id: string,
  userId: string
): Promise<OpenTarget> {
  const resolved = await resolveObjectKind(id, userId);

  if (!resolved) {
    return {
      type: RESOLVE_UNKNOWN_TYPE,
      id,
      displayName: null,
      workspaceId: null,
      openable: false,
    };
  }

  const route = browserRouteFor(resolved);
  if (!route) {
    // Resolved, but there is no browser surface for it. Report WHAT it is and
    // that it cannot be opened — never a link into nothing.
    return {
      type: resolved.kind,
      id: resolved.id,
      displayName: resolved.displayName ?? null,
      workspaceId: resolved.workspaceId ?? null,
      openable: false,
    };
  }

  return {
    type: route.label,
    id: resolved.id,
    displayName: resolved.displayName ?? null,
    workspaceId: resolved.workspaceId ?? null,
    ...(resolved.profileSlug ? { profileSlug: resolved.profileSlug } : {}),
    openable: true,
    ...(route.params ? { params: route.params } : {}),
  };
}
