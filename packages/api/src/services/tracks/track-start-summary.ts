/**
 * LEAF (no db, no service imports — `permission-check.ts` imports it
 * statically): the consent sentence of a track start that carries a space
 * grant (decision 2a; see `track-space-grant.ts`).
 */

import { buildObjectActionTitle } from "@synap-core/types/vocabulary";

/** The key on `project_tracks.metadata` AND on the `track/create` payload. */
export const TRACK_SPACE_GRANT_KEY = "spaceGrant";

/**
 * The `track/create` proposal summary when the start carries a space grant —
 * the consent stated in the words the person approves: `Create track "X" and
 * let <agent> work in Strategy, Finance for this track`. `null` ⇒ no grant
 * rides this proposal; the caller's generic title applies.
 */
export function buildTrackStartSummary(
  subjectType: string,
  action: string,
  data: Record<string, unknown>
): string | null {
  if (subjectType !== "track" || action !== "create") return null;
  const raw = data[TRACK_SPACE_GRANT_KEY];
  if (!raw || typeof raw !== "object") return null;
  const g = raw as Record<string, unknown>;
  const names = Array.isArray(g.spaces)
    ? g.spaces
        .map((s) =>
          s && typeof s === "object"
            ? (s as Record<string, unknown>).name
            : null
        )
        .filter((n): n is string => typeof n === "string" && !!n.trim())
    : [];
  if (names.length === 0) return null;
  const agent =
    typeof g.agentName === "string" && g.agentName.trim()
      ? g.agentName
      : "the agent";
  const head = buildObjectActionTitle({
    action: "create",
    objectKind: "track",
    objectName: typeof data.name === "string" ? data.name : null,
  });
  return `${head} and let ${agent} work in ${names.join(", ")} for this track`;
}
